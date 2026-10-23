# Panel Shell (Spec 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the control panel real URL routes, an app shell with a header and a mobile drawer, bundled design tokens and fonts, shared UI components, a confirm dialog on every destructive action, domain labels everywhere, and brand row basics.

**Architecture:** A 0-dependency router (`router.ts`) on `history.pushState` + `popstate` feeds `App.tsx`. `AppShell` + `SidebarNav` wrap every screen. `useConfirm()` returns a confirm function plus the dialog element, so each screen owns its dialog and no provider is needed. `useBrandLabels()` maps `brand_id` to domain from `/api/lifecycle/brands` and `/api/brands`.

**Tech Stack:** React 19, Vite 8, TypeScript strict, Vitest 4 (jsdom project for `*.ui.test.tsx`, workers pool for `*.test.ts`), `@testing-library/react`, Bun workspaces.

**Spec:** `docs/superpowers/specs/2026-10-23-panel-shell-design.md` (read its "Baseline correction" section first).

## Global Constraints

- Work only in `apps/web` plus this plan and the spec. Branch `fus-374-panel-shell`, worktree `H:/w/anjuna-wt/fus-374-panel-shell`.
- No router library and no UI library. The only new dependency is `@fontsource/ibm-plex-sans-thai@5.3.0`.
- No external font request: `index.html` must not reference `fonts.googleapis.com` or `fonts.gstatic.com`.
- UI copy follows the existing pattern: Thai first, English in parentheses, for example `ยกเลิก (Cancel)`.
- Role rules stay in `src/server/panel-roles.ts` and the existing UI checks. This plan changes no permission.
- Template deep links from template-mcp stay working: `https://app.aduplift.ai/#templates/<template_version_id>` (`workers/template-mcp/src/submit.ts:95`).
- Vite `base` stays the default `/`, so built assets load from absolute `/assets/...` paths on any deep link.
- Flow-gate labels: `param` = "Keyword Param", `signed_cookie` = "Single Page Cookie".
- Every task ends with `bun run --cwd apps/web typecheck` and `bun run --cwd apps/web test` green.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; subject suffix `(FUS-374)`.

## Review Focus

- A deep link to `/brands/<unknown id>` must say the brand is not found; it must not show the first brand's side panel. (Task 2 test.)
- `/users` opened by an Employee must show a no-permission message; it must not render the Users screen. (Task 2 test.)
- `/#templates/<id>` and `/#templates/%` (malformed escape) must open Templates; the bad escape opens the list with no crash. (Task 1 and Task 2 tests.)
- A second `confirm()` while a dialog is open must resolve the first one as `false`, so one click never runs two actions. (Task 5 test.)
- A cmd/ctrl-click or middle-click on a sidebar link must open a new tab (no `preventDefault`). (Task 4 test.)

---

### Task 1: Router module

**Files:**
- Create: `apps/web/src/client/router.ts`
- Test: `apps/web/test/router.ui.test.tsx`

**Interfaces:**
- Produces:
  - `type Route = { view: "home" } | { view: "brands"; brandId: string | null } | { view: "new-brand" } | { view: "templates"; templateId: string | null } | { view: "funnel" } | { view: "alerts" } | { view: "mailing" } | { view: "audit" } | { view: "users" } | { view: "builder-keys" } | { view: "not-found"; path: string }`
  - `type View = Route["view"]`
  - `parseRoute(pathname: string, hash?: string): Route`
  - `routePath(route: Route): string`
  - `viewPath(view: Exclude<View, "not-found">): string`
  - `navigate(path: string, options?: { replace?: boolean }): void`
  - `useRoute(): Route`
  - `isPlainLeftClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/test/router.ui.test.tsx
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { isPlainLeftClick, navigate, parseRoute, routePath, useRoute, viewPath } from "../src/client/router";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("parseRoute", () => {
  it.each([
    ["/", { view: "home" }],
    ["/brands", { view: "brands", brandId: null }],
    ["/brands/", { view: "brands", brandId: null }],
    ["/brands/new", { view: "new-brand" }],
    ["/brands/brand_abc", { view: "brands", brandId: "brand_abc" }],
    ["/brands/a%20b", { view: "brands", brandId: "a b" }],
    ["/templates", { view: "templates", templateId: null }],
    ["/templates/tv-1", { view: "templates", templateId: "tv-1" }],
    ["/funnel", { view: "funnel" }],
    ["/alerts", { view: "alerts" }],
    ["/mailing", { view: "mailing" }],
    ["/audit", { view: "audit" }],
    ["/users", { view: "users" }],
    ["/builder-keys", { view: "builder-keys" }],
    ["/nope", { view: "not-found", path: "/nope" }],
    ["/brands/a/b", { view: "not-found", path: "/brands/a/b" }],
  ])("%s", (path, route) => {
    expect(parseRoute(path)).toEqual(route);
  });

  it("maps the legacy template hash from template-mcp", () => {
    expect(parseRoute("/", "#templates/tv-9")).toEqual({ view: "templates", templateId: "tv-9" });
    expect(parseRoute("/", "#templates")).toEqual({ view: "templates", templateId: null });
  });

  it("opens the list for a malformed escape", () => {
    expect(parseRoute("/", "#templates/%")).toEqual({ view: "templates", templateId: null });
    expect(parseRoute("/templates/%")).toEqual({ view: "templates", templateId: null });
    expect(parseRoute("/brands/%")).toEqual({ view: "brands", brandId: null });
  });
});

describe("routePath", () => {
  it("round-trips every route", () => {
    for (const path of ["/", "/brands", "/brands/new", "/brands/x%2Fy", "/templates", "/templates/tv-1", "/funnel", "/alerts", "/mailing", "/audit", "/users", "/builder-keys"]) {
      expect(routePath(parseRoute(path))).toBe(path);
    }
    expect(viewPath("brands")).toBe("/brands");
    expect(viewPath("new-brand")).toBe("/brands/new");
  });
});

describe("isPlainLeftClick", () => {
  it("rejects modified and non-left clicks", () => {
    const base = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(isPlainLeftClick(base)).toBe(true);
    expect(isPlainLeftClick({ ...base, button: 1 })).toBe(false);
    expect(isPlainLeftClick({ ...base, metaKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, ctrlKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, shiftKey: true })).toBe(false);
  });
});

function Probe() {
  const route = useRoute();
  return <p>{JSON.stringify(route)}</p>;
}

describe("useRoute", () => {
  it("follows navigate, back and the legacy hash", async () => {
    window.history.replaceState(null, "", "/#templates/tv-1");
    render(<Probe />);
    expect(screen.getByText(JSON.stringify({ view: "templates", templateId: "tv-1" }))).toBeTruthy();
    // The legacy hash is rewritten to the real path, so a reload keeps the screen.
    expect(window.location.pathname).toBe("/templates/tv-1");
    expect(window.location.hash).toBe("");

    act(() => navigate("/funnel"));
    expect(screen.getByText(JSON.stringify({ view: "funnel" }))).toBeTruthy();

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    });
    expect(screen.getByText(JSON.stringify({ view: "templates", templateId: "tv-1" }))).toBeTruthy();

    act(() => navigate("/audit", { replace: true }));
    expect(window.location.pathname).toBe("/audit");
  });

  it("picks up a hash change in a tab that already holds the panel", () => {
    render(<Probe />);
    act(() => {
      window.location.hash = "#templates/tv-2";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(screen.getByText(JSON.stringify({ view: "templates", templateId: "tv-2" }))).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bunx vitest run --project ui test/router.ui.test.tsx`
Expected: FAIL, `Failed to resolve import "../src/client/router"`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/client/router.ts
import { useEffect, useState } from "react";

/** One screen of the panel and the id it shows, read from the URL path. */
export type Route =
  | { view: "home" }
  | { view: "brands"; brandId: string | null }
  | { view: "new-brand" }
  | { view: "templates"; templateId: string | null }
  | { view: "funnel" }
  | { view: "alerts" }
  | { view: "mailing" }
  | { view: "audit" }
  | { view: "users" }
  | { view: "builder-keys" }
  | { view: "not-found"; path: string };
export type View = Route["view"];

const STATIC: Record<string, Route> = {
  "/": { view: "home" },
  "/brands": { view: "brands", brandId: null },
  "/brands/new": { view: "new-brand" },
  "/templates": { view: "templates", templateId: null },
  "/funnel": { view: "funnel" },
  "/alerts": { view: "alerts" },
  "/mailing": { view: "mailing" },
  "/audit": { view: "audit" },
  "/users": { view: "users" },
  "/builder-keys": { view: "builder-keys" },
};

/** A bad escape such as "%" reads as no id, so the list opens. */
function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function parseRoute(pathname: string, hash = ""): Route {
  // template-mcp links to `/#templates/<id>`; keep those links working.
  const legacy = /^#templates(?:\/(.*))?$/.exec(hash);
  if (legacy) return { view: "templates", templateId: legacy[1] ? decode(legacy[1]) : null };
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const fixed = STATIC[path];
  if (fixed) return fixed;
  const one = /^\/(brands|templates)\/([^/]+)$/.exec(path);
  if (one) {
    const id = decode(one[2]!);
    return one[1] === "brands" ? { view: "brands", brandId: id } : { view: "templates", templateId: id };
  }
  return { view: "not-found", path };
}

export function routePath(route: Route): string {
  switch (route.view) {
    case "brands":
      return route.brandId ? `/brands/${encodeURIComponent(route.brandId)}` : "/brands";
    case "templates":
      return route.templateId ? `/templates/${encodeURIComponent(route.templateId)}` : "/templates";
    case "not-found":
      return route.path;
    default:
      return viewPath(route.view);
  }
}

export function viewPath(view: Exclude<View, "not-found">): string {
  switch (view) {
    case "home": return "/";
    case "new-brand": return "/brands/new";
    default: return `/${view}`;
  }
}

const ROUTE_EVENT = "anjuna:route";

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

function current(): Route {
  const route = parseRoute(window.location.pathname, window.location.hash);
  // Rewrite a legacy hash link to its path so reload and back keep the screen.
  if (window.location.hash.startsWith("#templates")) window.history.replaceState(null, "", routePath(route));
  return route;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(current);
  useEffect(() => {
    const update = () => setRoute(current());
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    window.addEventListener(ROUTE_EVENT, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
      window.removeEventListener(ROUTE_EVENT, update);
    };
  }, []);
  return route;
}

/** A modified or middle click keeps the browser default: open the link in a new tab or window. */
export function isPlainLeftClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bunx vitest run --project ui test/router.ui.test.tsx`
Expected: PASS. If `round-trips every route` fails on `/brands/x%2Fy`, check that `parseRoute` decodes to `x/y` and `routePath` encodes back to `x%2Fy`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/client/router.ts apps/web/test/router.ui.test.tsx
git commit -m "feat(web): URL router on history.pushState with legacy template hash support (FUS-374)"
```

---

### Task 2: App on URL routes

**Files:**
- Create: `apps/web/src/client/screens/NotFound.tsx`
- Modify: `apps/web/src/client/App.tsx` (replace `useState<View>` and the hash effect)
- Modify: `apps/web/src/client/screens/Templates.tsx:18-45,73,102,125` (selected id from props)
- Modify: `apps/web/src/client/screens/BrandLifecycle.tsx:64-115,304,343` (route brand id, select callback, wizard close)
- Test: `apps/web/test/app.ui.test.tsx` (update), `apps/web/test/templates.ui.test.tsx` and `apps/web/test/lifecycle.ui.test.tsx` (keep green)

**Interfaces:**
- Consumes: `useRoute`, `navigate`, `viewPath`, `routePath`, `isPlainLeftClick`, `Route`, `View` from Task 1.
- Produces:
  - `TemplatesScreen({ me, selectedId, onSelect }: { me: Me; selectedId?: string | null; onSelect?: (id: string | null) => void })`. Without `onSelect` the screen keeps its own state (tests that render it alone keep working).
  - `BrandLifecycle({ me, wizardRequest, routeBrandId, onSelectBrand, onWizardClosed }: { me: Me; wizardRequest?: number; routeBrandId?: string | null; onSelectBrand?: (brandId: string) => void; onWizardClosed?: () => void })`
  - `NotFound({ title, hint }: { title: string; hint?: string })` renders `<h1>{title}</h1>`, the hint, and an `<a href="/">กลับหน้าแรก (Back to Home)</a>` that calls `navigate("/")` on a plain left click.

- [ ] **Step 1: Update the shell test to the routed behavior (failing)**

In `apps/web/test/app.ui.test.tsx`:
- Change the `BrandLifecycle` mock to also print the route brand id:
  ```tsx
  vi.mock("../src/client/screens/BrandLifecycle", () => ({
    BrandLifecycle: ({ wizardRequest, routeBrandId }: { wizardRequest: number; routeBrandId?: string | null }) => <h1>Brands screen: {wizardRequest} {routeBrandId ?? "-"}</h1>,
  }));
  vi.mock("../src/client/screens/Templates", () => ({ TemplatesScreen: ({ selectedId }: { selectedId?: string | null }) => <h1>Templates screen {selectedId ?? "-"}</h1> }));
  ```
- Nav items become links. Replace every `getAllByRole("button")` / `getByRole("button", { name: <nav label> })` inside the nav with `"link"`. Expected heading strings change to `"Brands screen: 0 -"`, `"Templates screen -"`, `"Brands screen: 1 -"`, `"Brands screen: 2 -"`.
- Keep the `ออกจากระบบ (Sign out)` button test as is.
- Add these tests inside `describe("Console rail", ...)`:

```tsx
  it.each([
    ["/brands", "Brands screen: 0 -", "แบรนด์"],
    ["/brands/brand_abc", "Brands screen: 0 brand_abc", "แบรนด์"],
    ["/brands/new", "Brands screen: 1 -", "สร้างแบรนด์ใหม่"],
    ["/templates/tv-1", "Templates screen tv-1", "เทมเพลต"],
    ["/funnel", "Funnel screen", "ฟันเนล"],
    ["/audit", "Audit screen", "ประวัติการแก้ไข"],
    ["/builder-keys", "Builder keys screen", "คีย์ Builder"],
  ])("deep link %s renders its screen", async (path, heading, label) => {
    window.history.replaceState(null, "", path);
    render(<App />);
    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "เมนูหลัก" });
    expect(within(nav).getByRole("link", { name: new RegExp(`^${label}`) }).getAttribute("aria-current")).toBe("page");
  });

  it("changes the URL on navigation and follows the back button", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "หน้าแรก" });
    fireEvent.click(screen.getByRole("link", { name: "ฟันเนล" }));
    expect(window.location.pathname).toBe("/funnel");
    expect(await screen.findByRole("heading", { name: "Funnel screen" })).toBeTruthy();
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    });
    expect(await screen.findByRole("heading", { name: "หน้าแรก" })).toBeTruthy();
  });

  it("shows Page not found for an unknown path and marks no nav item", async () => {
    window.history.replaceState(null, "", "/nope");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "ไม่พบหน้านี้ (Page not found)" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "เมนูหลัก" });
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
    fireEvent.click(screen.getByRole("link", { name: "กลับหน้าแรก (Back to Home)" }));
    expect(await screen.findByRole("heading", { name: "หน้าแรก" })).toBeTruthy();
  });

  it("tells an Employee who opens /users that the page is Owner only", async () => {
    vi.mocked(api.me).mockResolvedValue({ ...owner, role: "employee" });
    window.history.replaceState(null, "", "/users");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "สำหรับ Owner เท่านั้น (Owner only)" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Users screen" })).toBeNull();
  });

  it("opens the list for a malformed template hash", async () => {
    window.history.replaceState(null, "", "/#templates/%");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Templates screen -" })).toBeTruthy();
  });
```

Change the existing `"preserves initial template deep links"` expectation to heading `"Templates screen tv-test"` and add `expect(window.location.pathname).toBe("/templates/tv-test");`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && bunx vitest run --project ui test/app.ui.test.tsx`
Expected: FAIL (nav items are buttons; deep links render Home).

- [ ] **Step 3: Implement**

`apps/web/src/client/screens/NotFound.tsx`:

```tsx
import { isPlainLeftClick, navigate } from "../router";

export function NotFound({ title, hint }: { title: string; hint?: string }) {
  return (
    <section className="panel">
      <h1>{title}</h1>
      {hint && <p className="hint">{hint}</p>}
      <a href="/" onClick={(e) => { if (!isPlainLeftClick(e)) return; e.preventDefault(); navigate("/"); }}>กลับหน้าแรก (Back to Home)</a>
    </section>
  );
}
```

`App.tsx` changes:
- Delete `type View`, the `view` state, and the `hashchange` effect. Add `const route = useRoute();` and `const view = route.view;`.
- `wizardRequest` initial value: `useState(() => (parseRoute(window.location.pathname).view === "new-brand" ? 1 : 0))`.
- The alert-count effect depends on `[me, view]` as today (it reloads on navigation).
- `open(id: HomeTarget | Exclude<View, "not-found">)`: for `"new-brand"` raise `wizardRequest` and `navigate("/brands/new")`; otherwise `navigate(viewPath(id))`.
- Nav entries render `<a className={...} href={viewPath(n.id)} aria-current={...} onClick={(e) => { if (!isPlainLeftClick(e)) return; e.preventDefault(); open(n.id); }}>`. `aria-current="page"` when `view === n.id`; a `/brands/<id>` route marks `brands`.
- Main area:
  ```tsx
  {view === "home" && <HomeScreen me={me} onGo={open} />}
  {(view === "brands" || view === "new-brand") && <BrandLifecycle me={me} wizardRequest={wizardRequest}
      routeBrandId={route.view === "brands" ? route.brandId : null}
      onSelectBrand={(id) => navigate(routePath({ view: "brands", brandId: id }))}
      onWizardClosed={() => { if (window.location.pathname === "/brands/new") navigate("/brands", { replace: true }); }} />}
  {view === "templates" && <TemplatesScreen me={me} selectedId={route.view === "templates" ? route.templateId : null}
      onSelect={(id) => navigate(routePath({ view: "templates", templateId: id }))} />}
  {view === "users" && (me.role === "owner" ? <UsersScreen me={me} /> : <NotFound title="สำหรับ Owner เท่านั้น (Owner only)" hint="บัญชีพนักงานเปิดหน้านี้ไม่ได้ (An employee account cannot open this page.)" />)}
  {view === "not-found" && <NotFound title="ไม่พบหน้านี้ (Page not found)" hint={route.view === "not-found" ? route.path : undefined} />}
  ```
  Keep the other screens as today.
- Add `.nav` rules for links in `styles.css`: `a.nav { text-decoration: none; }`.

`Templates.tsx` changes:
- Delete `selectedFromHash` and the `hashchange` effect.
- `const [ownSelected, setOwnSelected] = useState<string | null>(null);`
- `const selected = onSelect ? (selectedId ?? null) : ownSelected;`
- `const select = (id: string | null) => (onSelect ? onSelect(id) : setOwnSelected(id));`
- Replace the three `setSelected(...)` calls (lines 73, 102, 125) with `select(...)`.

`BrandLifecycle.tsx` changes:
- Add the three props. Add
  ```tsx
  useEffect(() => { if (routeBrandId && routeBrandId !== selectedId) setSelectedId(routeBrandId); }, [routeBrandId]);
  ```
- In `load`, auto-select the first brand only when there is no route brand: `if (!selectedId && !routeBrandId && result.brands[0]) setSelectedId(result.brands[0].brand_id);`
- Row select (line 343): `const select = () => { setSelectedId(brand.brand_id); onSelectBrand?.(brand.brand_id); };`
- Wizard `onClose`: also call `onWizardClosed?.()`. Wizard `onGenerated(brandId)`: also call `onSelectBrand?.(brandId)`.
- When `brands.length > 0 && routeBrandId && !selected`, the side panel shows `<section className="panel brand-side"><p role="alert">ไม่พบแบรนด์ <code>{routeBrandId}</code> (Brand not found)</p></section>` in place of the "เลือกแบรนด์" hint.
- Add to `apps/web/test/lifecycle.ui.test.tsx` (use its existing render helper and fixtures):
  ```tsx
  it("says a route brand id that does not exist is not found", async () => {
    render(<BrandLifecycle me={owner} routeBrandId="brand_missing" />);
    expect(await screen.findByText(/ไม่พบแบรนด์/)).toBeTruthy();
    expect(screen.getByText("brand_missing")).toBeTruthy();
  });
  ```
  Adapt `owner` and the mocked fetch to the names that file already uses.

- [ ] **Step 4: Run tests**

Run: `cd apps/web && bunx vitest run --project ui`
Expected: PASS, including `templates.ui.test.tsx` and `lifecycle.ui.test.tsx`.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run --cwd apps/web typecheck
git add apps/web/src/client apps/web/test
git commit -m "feat(web): panel screens on URL paths with deep links, back button and not-found page (FUS-374)"
```

---

### Task 3: Design tokens and bundled font

**Files:**
- Create: `apps/web/src/client/styles/tokens.css`
- Modify: `apps/web/src/client/styles.css:1-23` (move the `:root` and dark-theme blocks out)
- Modify: `apps/web/src/client/index.html:7-9` (remove the Google Fonts links)
- Modify: `apps/web/src/client/main.tsx` (import fonts and tokens before `styles.css`)
- Modify: `apps/web/package.json` (add `"@fontsource/ibm-plex-sans-thai": "5.3.0"` to `dependencies`)
- Test: `apps/web/test/build.node.test.ts`

**Interfaces:**
- Produces CSS variables used by later tasks: the existing color tokens unchanged, plus `--space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px; --space-6: 32px; --radius-sm: 6px; --radius-md: 9px; --radius-lg: 12px; --shadow-1: 0 1px 2px rgba(16, 24, 20, .06); --shadow-2: 0 8px 24px rgba(16, 24, 20, .14); --text-xs: 11px; --text-sm: 12px; --text-md: 14px; --text-lg: 16px; --text-xl: 22px; --row-h: 36px; --mono: ui-monospace, "SFMono-Regular", Consolas, monospace;`

- [ ] **Step 1: Write the failing test**

Add inside `describe("SPA build", ...)` in `build.node.test.ts`, after the existing `it`:

```ts
  it("loads no external font and uses absolute asset paths for deep links", async () => {
    await build({ configFile: path.join(root, "vite.config.ts"), logLevel: "silent" });
    const out = path.join(root, "dist/client");
    const html = readFileSync(path.join(out, "index.html"), "utf8");
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(html).toMatch(/src="\/assets\/[^"]+\.js"/);
    const fonts = readdirSync(path.join(out, "assets")).filter((f) => f.endsWith(".woff2"));
    expect(fonts.length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && bunx vitest run --project build test/build.node.test.ts`
Expected: FAIL on the `fonts.googleapis.com` match.

- [ ] **Step 3: Implement**

1. `bun add --cwd apps/web @fontsource/ibm-plex-sans-thai@5.3.0` (pin the exact version in `package.json`).
2. Cut lines 1-23 of `styles.css` (the `:root`, `@media (prefers-color-scheme: dark)` and `:root[data-theme="dark"]` blocks) into `styles/tokens.css` unchanged, then add the new tokens from "Interfaces" to the first `:root` block.
3. `main.tsx` imports, in this order:
   ```ts
   import "@fontsource/ibm-plex-sans-thai/thai-400.css";
   import "@fontsource/ibm-plex-sans-thai/thai-500.css";
   import "@fontsource/ibm-plex-sans-thai/thai-600.css";
   import "@fontsource/ibm-plex-sans-thai/latin-400.css";
   import "@fontsource/ibm-plex-sans-thai/latin-500.css";
   import "@fontsource/ibm-plex-sans-thai/latin-600.css";
   import "./styles/tokens.css";
   import "./styles.css";
   ```
   Check the subset file names under `node_modules/@fontsource/ibm-plex-sans-thai/` first; if the package names the files differently, use its per-weight subset files for `thai` and `latin`.
4. Delete the 3 font `<link>` lines from `index.html`.

- [ ] **Step 4: Run tests**

Run: `cd apps/web && bunx vitest run --project build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json bun.lock apps/web/src/client/styles apps/web/src/client/styles.css apps/web/src/client/index.html apps/web/src/client/main.tsx apps/web/test/build.node.test.ts
git commit -m "feat(web): design tokens file and self-hosted IBM Plex Sans Thai, no external font request (FUS-374)"
```

---

### Task 4: App shell, sidebar, header and mobile drawer

**Files:**
- Create: `apps/web/src/client/components/AppShell.tsx`
- Create: `apps/web/src/client/components/SidebarNav.tsx`
- Modify: `apps/web/src/client/App.tsx` (render through `AppShell`)
- Modify: `apps/web/src/client/api.ts:30-34` (`Me` gains `account?: string`)
- Modify: `apps/web/src/server/index.ts:126-128` (`/api/me` adds `account: env.DEFAULT_ACCOUNT`)
- Modify: `apps/web/src/client/styles.css` (shell, header, drawer rules; replace the `@media (max-width: 760px)` shell rules)
- Test: `apps/web/test/app-shell.ui.test.tsx`, `apps/web/test/api.test.ts` (one new case)

**Interfaces:**
- Consumes: `View`, `viewPath`, `isPlainLeftClick` (Task 1).
- Produces:
  - `type NavItem = { id: Exclude<View, "not-found">; label: string; badge?: { count: number; label: string } | null; gap?: boolean }`
  - `SidebarNav({ items, current, onOpen }: { items: NavItem[]; current: View; onOpen: (id: NavItem["id"]) => void })` renders `<nav aria-label="เมนูหลัก">` with one `<a className="nav">` per item.
  - `AppShell({ me, title, nav, onSignOut, children }: { me: Me; title: string; nav: ReactNode; onSignOut: () => void; children: ReactNode })`
  - Page titles: `pageTitle: Record<View, string>` exported from `AppShell.tsx` with the nav labels and `"not-found": "ไม่พบหน้านี้"`.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/test/app-shell.ui.test.tsx
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/client/components/AppShell";
import { SidebarNav, type NavItem } from "../src/client/components/SidebarNav";

afterEach(cleanup);

const me = { id: "u1", email: "owner@example.test", role: "owner" as const, account: "aduplift" };
const items: NavItem[] = [
  { id: "home", label: "หน้าแรก" },
  { id: "alerts", label: "การแจ้งเตือน", badge: { count: 3, label: "3 รายการที่ต้องจัดการ" } },
];

function renderShell(onSignOut = vi.fn(), onOpen = vi.fn()) {
  render(
    <AppShell me={me} title="หน้าแรก" onSignOut={onSignOut} nav={<SidebarNav items={items} current="home" onOpen={onOpen} />}>
      <p>body</p>
    </AppShell>,
  );
  return { onSignOut, onOpen };
}

describe("AppShell", () => {
  it("shows the page title, tenant badge and user menu in the header", () => {
    const { onSignOut } = renderShell();
    const header = screen.getByRole("banner");
    expect(within(header).getByText("หน้าแรก")).toBeTruthy();
    expect(within(header).getByText("aduplift")).toBeTruthy();
    fireEvent.click(within(header).getByRole("button", { name: /owner@example.test/ }));
    expect(screen.getByText("Owner")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ออกจากระบบ (Sign out)" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("opens and closes the mobile drawer with the menu button and Escape", () => {
    renderShell();
    const toggle = screen.getByRole("button", { name: "เมนู (Menu)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".shell")?.getAttribute("data-drawer")).toBe("open");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes the drawer when a nav link is used", () => {
    const { onOpen } = renderShell();
    fireEvent.click(screen.getByRole("button", { name: "เมนู (Menu)" }));
    fireEvent.click(screen.getByRole("link", { name: /การแจ้งเตือน/ }));
    expect(onOpen).toHaveBeenCalledWith("alerts");
    expect(screen.getByRole("button", { name: "เมนู (Menu)" }).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("SidebarNav", () => {
  it("marks the current page and shows the badge", () => {
    renderShell();
    const nav = screen.getByRole("navigation", { name: "เมนูหลัก" });
    expect(within(nav).getByRole("link", { name: "หน้าแรก" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByLabelText("3 รายการที่ต้องจัดการ").textContent).toBe("3");
  });

  it("leaves a ctrl-click or middle-click to the browser", () => {
    const { onOpen } = renderShell();
    const link = screen.getByRole("link", { name: "หน้าแรก" });
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true); // default not prevented
    expect(fireEvent.click(link, { button: 1 })).toBe(true);
    expect(onOpen).not.toHaveBeenCalled();
    expect(link.getAttribute("href")).toBe("/");
  });
});
```

In `apps/web/test/api.test.ts`, next to the existing `/api/me` case, add a case that signs in with the existing helper and expects `body.user.account` to equal `"aduplift"`. The workers test env comes from `vitest.config.ts` `miniflare.bindings`, which does not load `wrangler.jsonc` vars; if `DEFAULT_ACCOUNT` is not set there or by `test/helpers.ts`, add `DEFAULT_ACCOUNT: "aduplift"` to the worker project's `bindings` in `vitest.config.ts`.

Update `apps/web/test/app.ui.test.tsx`: in `"counts warn and alert categories..."` change `badge.closest("button")` to `badge.closest("a")`. The user email and role now sit behind the user-menu button. In `"starts at Home..."` open the menu first: `fireEvent.click(screen.getByRole("button", { name: /owner@example.test/ }))`, then assert `"Owner"`. Do the same in `"hides owner-only Users from employees"` before asserting `"พนักงาน"`, and in the sign-out test before clicking Sign out.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && bunx vitest run --project ui test/app-shell.ui.test.tsx`
Expected: FAIL, missing modules.

- [ ] **Step 3: Implement**

`SidebarNav.tsx`:

```tsx
import { type View, isPlainLeftClick, viewPath } from "../router";

export type NavItem = { id: Exclude<View, "not-found">; label: string; badge?: { count: number; label: string } | null; gap?: boolean };

export function SidebarNav({ items, current, onOpen }: { items: NavItem[]; current: View; onOpen: (id: NavItem["id"]) => void }) {
  return (
    <nav aria-label="เมนูหลัก">
      {items.map((n) => (
        <a
          key={n.id}
          href={viewPath(n.id)}
          className={`nav${n.gap ? " navgap" : ""}`}
          aria-current={current === n.id ? "page" : undefined}
          onClick={(e) => {
            if (!isPlainLeftClick(e)) return;
            e.preventDefault();
            onOpen(n.id);
          }}
        >
          <span>{n.label}</span>
          {n.badge && <b aria-label={n.badge.label}>{n.badge.count}</b>}
        </a>
      ))}
    </nav>
  );
}
```

`AppShell.tsx`:

```tsx
import { type ReactNode, useEffect, useState } from "react";
import type { Me } from "../api";
import type { View } from "../router";

export const pageTitle: Record<View, string> = {
  home: "หน้าแรก", brands: "แบรนด์", "new-brand": "สร้างแบรนด์ใหม่", templates: "เทมเพลต", funnel: "ฟันเนล",
  alerts: "การแจ้งเตือน", mailing: "รายชื่ออีเมล", audit: "ประวัติการแก้ไข", users: "ผู้ใช้", "builder-keys": "คีย์ Builder",
  "not-found": "ไม่พบหน้านี้",
};

export function AppShell({ me, title, nav, onSignOut, children }: { me: Me; title: string; nav: ReactNode; onSignOut: () => void; children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setDrawer(false); setMenu(false); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="shell" data-drawer={drawer ? "open" : "closed"}>
      <aside className="sidebar" id="sidebar" onClick={(e) => { if ((e.target as HTMLElement).closest("a.nav")) setDrawer(false); }}>
        <div className="brandmark"><i aria-hidden="true" />Anjuna</div>
        {nav}
      </aside>
      {drawer && <div className="scrim shell-scrim" onClick={() => setDrawer(false)} />}
      <div className="main-col">
        <header className="topbar">
          <button type="button" className="menu-btn" aria-label="เมนู (Menu)" aria-controls="sidebar" aria-expanded={drawer} onClick={() => setDrawer((v) => !v)}>☰</button>
          <span className="topbar-title">{title}</span>
          {me.account && <span className="pill p-blue env-badge">{me.account}</span>}
          <div className="user-menu">
            <button type="button" className="btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>{me.email}</button>
            {menu && (
              <div className="user-pop" role="menu">
                <div className="who"><div>{me.email}</div><div>{me.role === "owner" ? "Owner" : "พนักงาน"}</div></div>
                <button type="button" role="menuitem" className="nav signout" onClick={onSignOut}>ออกจากระบบ (Sign out)</button>
              </div>
            )}
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
```

Note: the sidebar `onClick` closes the drawer after `SidebarNav` calls `onOpen`, because React runs the link handler first and the click bubbles to `aside`.

`App.tsx`: build `items: NavItem[]` from the existing `nav` array (filter by `show`, alerts gets `badge` when `alertCount !== null`), then

```tsx
return (
  <AppShell me={me} title={pageTitle[view]} onSignOut={async () => { await api.signOut().catch(() => undefined); setMe(null); }}
    nav={<SidebarNav items={items} current={view === "new-brand" ? "new-brand" : view} onOpen={open} />}>
    {/* the screen switch from Task 2 */}
  </AppShell>
);
```

Server `index.ts:127`: `return json(200, { user: { id: ctx.actor_id, email, role: ctx.actor_role, account: env.DEFAULT_ACCOUNT } });`. `api.ts`: `export interface Me { id: string; email: string; role: AdminRole; account?: string }`.

`styles.css`: replace `.shell` with a 2-column grid `200px minmax(0, 1fr)`; `.main-col { min-width: 0; display: flex; flex-direction: column; }`; `.topbar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) clamp(16px, 3vw, 32px); border-bottom: 1px solid var(--line); background: var(--paper); }`; `.topbar-title { font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`; `.menu-btn { display: none; }`; `.user-menu { position: relative; }`; `.user-pop { position: absolute; right: 0; top: calc(100% + 4px); background: var(--raised); border: 1px solid var(--line); border-radius: var(--radius-md); box-shadow: var(--shadow-2); min-width: 220px; padding: var(--space-2); z-index: 6; }`; `.shell-scrim { display: none; }`. Delete the old `.me` rules. Replace the old `@media (max-width: 760px)` shell block with:

```css
@media (max-width: 767px) {
  .shell { grid-template-columns: minmax(0, 1fr); }
  .menu-btn { display: inline-flex; }
  .sidebar { position: fixed; inset: 0 auto 0 0; width: min(260px, 80vw); z-index: 30; transform: translateX(-100%); transition: transform .2s; }
  .shell[data-drawer="open"] .sidebar { transform: none; }
  .shell[data-drawer="open"] .shell-scrim { display: block; position: fixed; inset: 0; z-index: 25; }
  .content { padding: 16px; }
  .env-badge { display: none; }
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/web && bunx vitest run --project ui && bunx vitest run --project worker test/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run --cwd apps/web typecheck
git add apps/web/src apps/web/test
git commit -m "feat(web): app shell with header, tenant badge, user menu and mobile drawer (FUS-374)"
```

---

### Task 5: Confirm dialog

**Files:**
- Create: `apps/web/src/client/components/ConfirmDialog.tsx`
- Create: `apps/web/test/confirm.ts` (test helper)
- Modify: `apps/web/src/client/styles.css` (append dialog rules)
- Test: `apps/web/test/confirm-dialog.ui.test.tsx`

**Interfaces:**
- Produces:
  - `type ConfirmOptions = { title: string; body?: ReactNode; confirmLabel: string; tone?: "danger" | "default" }`
  - `useConfirm(): [confirm: (options: ConfirmOptions) => Promise<boolean>, dialog: ReactNode]`. The component must render `dialog` somewhere in its JSX.
  - Cancel button label is always `ยกเลิก (Cancel)`.
  - Test helper `answerConfirm(accept: boolean): Promise<HTMLElement>` in `test/confirm.ts`: waits for `role="alertdialog"`, clicks the confirm button (accept) or `ยกเลิก (Cancel)`, and returns the dialog element as it was.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/test/confirm-dialog.ui.test.tsx
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useConfirm } from "../src/client/components/ConfirmDialog";
import { answerConfirm } from "./confirm";

afterEach(cleanup);

function Harness() {
  const [confirm, dialog] = useConfirm();
  const [log, setLog] = useState<string[]>([]);
  const ask = (name: string) => async () => {
    const ok = await confirm({ title: `ลบ ${name}?`, body: "ย้อนกลับไม่ได้", confirmLabel: "ลบ (Delete)", tone: "danger" });
    setLog((l) => [...l, `${name}:${ok}`]);
  };
  return (
    <>
      <button onClick={ask("a")}>ask a</button>
      <button onClick={ask("b")}>ask b</button>
      <p>{log.join(",")}</p>
      {dialog}
    </>
  );
}

describe("useConfirm", () => {
  it("resolves true on confirm and false on cancel", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("ask a"));
    const dialog = await answerConfirm(true);
    expect(dialog.textContent).toContain("ลบ a?");
    expect(await screen.findByText("a:true")).toBeTruthy();
    fireEvent.click(screen.getByText("ask a"));
    await answerConfirm(false);
    expect(await screen.findByText("a:true,a:false")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("cancels on Escape and on the scrim, and focuses Cancel first", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("ask a"));
    await screen.findByRole("alertdialog");
    expect(document.activeElement?.textContent).toBe("ยกเลิก (Cancel)");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(await screen.findByText("a:false")).toBeTruthy();
    fireEvent.click(screen.getByText("ask a"));
    fireEvent.click(document.querySelector(".modal-wrap")!);
    expect(await screen.findByText("a:false,a:false")).toBeTruthy();
  });

  it("resolves an open dialog as false when a second confirm starts", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("ask a"));
    await screen.findByRole("alertdialog");
    await act(async () => { fireEvent.click(screen.getByText("ask b")); });
    expect(await screen.findByText("a:false")).toBeTruthy();
    await answerConfirm(true);
    expect(await screen.findByText("a:false,b:true")).toBeTruthy();
  });
});
```

```ts
// apps/web/test/confirm.ts
import { fireEvent, screen, within } from "@testing-library/react";

/** Answers the open ConfirmDialog. Returns the dialog element. */
export async function answerConfirm(accept: boolean): Promise<HTMLElement> {
  const dialog = await screen.findByRole("alertdialog");
  const buttons = within(dialog).getAllByRole("button");
  const cancel = buttons.find((b) => b.textContent === "ยกเลิก (Cancel)")!;
  const confirm = buttons.find((b) => b !== cancel)!;
  fireEvent.click(accept ? confirm : cancel);
  return dialog;
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && bunx vitest run --project ui test/confirm-dialog.ui.test.tsx`
Expected: FAIL, missing module.

- [ ] **Step 3: Implement**

```tsx
// apps/web/src/client/components/ConfirmDialog.tsx
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";

export type ConfirmOptions = { title: string; body?: ReactNode; confirmLabel: string; tone?: "danger" | "default" };
type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

/** Replaces window.confirm. Render the returned element; await the function. */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const close = useCallback((ok: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(ok);
    returnFocus.current?.focus?.();
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    // One dialog at a time: a new question cancels the open one.
    pendingRef.current?.resolve(false);
    returnFocus.current = document.activeElement as HTMLElement | null;
    const next = { ...options, resolve };
    pendingRef.current = next;
    setPending(next);
  }), []);

  // An unmounted screen must not leave a promise waiting forever.
  useEffect(() => () => { pendingRef.current?.resolve(false); }, []);

  return [confirm, pending ? <Dialog key={pending.title} pending={pending} onClose={close} /> : null];
}

function Dialog({ pending, onClose }: { pending: Pending; onClose: (ok: boolean) => void }) {
  const titleId = useId();
  const bodyId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-wrap" onClick={(e) => { if (e.target === e.currentTarget) onClose(false); }}>
      <div className="card modal confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={pending.body ? bodyId : undefined}>
        <h2 id={titleId}>{pending.title}</h2>
        {pending.body && <div id={bodyId} className="confirm-body">{pending.body}</div>}
        <div className="confirm-actions">
          <button type="button" className="btn" autoFocus onClick={() => onClose(false)}>ยกเลิก (Cancel)</button>
          <button type="button" className={pending.tone === "danger" ? "btn danger" : "btn pri"} onClick={() => onClose(true)}>{pending.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
```

Append to `styles.css`:

```css
.confirm-dialog { display: grid; gap: var(--space-3); box-shadow: var(--shadow-2); }
.confirm-body { color: var(--muted); white-space: pre-line; }
.confirm-actions { display: flex; justify-content: flex-end; gap: var(--space-2); flex-wrap: wrap; }
```

- [ ] **Step 4: Run tests**

Run: `cd apps/web && bunx vitest run --project ui test/confirm-dialog.ui.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/client/components/ConfirmDialog.tsx apps/web/src/client/styles.css apps/web/test/confirm.ts apps/web/test/confirm-dialog.ui.test.tsx
git commit -m "feat(web): ConfirmDialog with useConfirm hook, Escape and scrim cancel (FUS-374)"
```

---

### Task 6: Replace every window.confirm

**Files:**
- Modify: `apps/web/src/client/screens/BrandLifecycle.tsx:277-287` (redeploy, redeploy with latest form)
- Modify: `apps/web/src/client/screens/ConfigPanel.tsx:87,99,127` (rollback, template move, token rotation)
- Modify: `apps/web/src/client/screens/BuilderKeys.tsx:73` (revoke key)
- Modify: `apps/web/src/client/screens/BrandEditSections.tsx:103` (remove logo or favicon)
- Test: `apps/web/test/lifecycle.ui.test.tsx`, `apps/web/test/redeploy.ui.test.tsx`, `apps/web/test/builder-keys.ui.test.tsx`, `apps/web/test/brand-edit.ui.test.tsx`

**Interfaces:**
- Consumes: `useConfirm`, `ConfirmOptions` (Task 5); `answerConfirm` (Task 5 test helper).
- Produces: no new exports. After this task `grep -rn "window.confirm" apps/web/src` returns nothing.

- [ ] **Step 1: Migrate the tests first (failing)**

In each of the 4 test files:
- Delete `vi.stubGlobal("confirm", ...)` and the `confirm` mock variables.
- Where a test expected the action to run after the stubbed `confirm` returned `true`, call `await answerConfirm(true)` right after the click that used to trigger `window.confirm`.
- Where a test set `confirm` to return `false` ("declines"), call `await answerConfirm(false)` and keep the "no request sent" assertions.
- Where a test asserted the confirm text (for example `expect(confirm).toHaveBeenCalledWith(expect.stringContaining("..."))`), assert on the dialog text instead: `const dialog = await answerConfirm(true); expect(dialog.textContent).toContain("...")`.
- Import: `import { answerConfirm } from "./confirm";`

Add one assertion to `test/builder-keys.ui.test.tsx` "revokes a key after confirmation": before answering, no revoke request has been sent.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && bunx vitest run --project ui test/lifecycle.ui.test.tsx test/redeploy.ui.test.tsx test/builder-keys.ui.test.tsx test/brand-edit.ui.test.tsx`
Expected: FAIL, `Unable to find role="alertdialog"`.

- [ ] **Step 3: Implement**

Pattern for each call site. Take the existing Thai text as the `title` and the English sentence in parentheses as the `body`; keep the meaning word for word.

```tsx
const [confirm, confirmDialog] = useConfirm();
// ...
async function redeploy() {
  if (!selected) return;
  const ok = await confirm({
    title: "ติดตั้งแบรนด์นี้ใหม่ด้วยเวอร์ชันเทมเพลตและ form ปัจจุบัน?",
    body: `Redeploy at the current template version and form. If a step fails, it rolls back to the previous version.${pausedNote()}`,
    confirmLabel: "ติดตั้งใหม่ (Redeploy)",
  });
  if (!ok) return;
  await dispatchOperation(() => api.redeploy(selected.brand_id));
}
```

Render `{confirmDialog}` once at the end of each component's returned JSX (`BrandLifecycle`, `ConfigPanel` inside its `Drawer`, `BuilderKeysScreen`, and the component in `BrandEditSections.tsx` that owns line 103). Confirm labels and tones:

| Site | confirmLabel | tone |
|---|---|---|
| BrandLifecycle redeploy | `ติดตั้งใหม่ (Redeploy)` | default |
| BrandLifecycle redeploy latest form | `ติดตั้งใหม่พร้อมฟอร์มล่าสุด (Redeploy with latest form)` | default |
| ConfigPanel rollback | `ย้อนกลับ (Rollback)` | danger |
| ConfigPanel template move | `ย้ายเทมเพลต (Move template)` | default |
| ConfigPanel rotate token | `หมุน token (Rotate token)` | danger |
| BuilderKeys revoke | `ยกเลิกคีย์ (Revoke key)` | danger |
| BrandEditSections remove asset | `ลบ (Remove)` | danger |

`pausedNote()` currently starts with `\n\n`; the dialog body uses `white-space: pre-line`, so keep it.

- [ ] **Step 4: Run tests**

Run: `cd apps/web && bunx vitest run --project ui && grep -rn "window.confirm" src || echo "no window.confirm left"`
Expected: PASS and `no window.confirm left`.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run --cwd apps/web typecheck
git add apps/web/src/client apps/web/test
git commit -m "refactor(web): ConfirmDialog replaces window.confirm on redeploy, rollback, token, key and asset actions (FUS-374)"
```

---

### Task 7: Confirm on actions that had none

**Files:**
- Create: `apps/web/src/client/labels.ts`
- Modify: `apps/web/src/client/screens/BrandLifecycle.tsx:269-272,296-299,379` (rollback, recover, upgrade-all)
- Modify: `apps/web/src/client/screens/ConfigPanel.tsx:64-71,111-118` (pause/resume, flow gate)
- Modify: `apps/web/src/client/screens/Users.tsx:46` (role change)
- Test: `apps/web/test/confirm-actions.ui.test.tsx`

**Interfaces:**
- Consumes: `useConfirm` (Task 5), `answerConfirm` (Task 5 helper).
- Produces: `labels.ts` exports
  ```ts
  import type { FlowGateMode } from "@anjuna/contracts";
  export const flowGateLabel: Record<FlowGateMode, string> = { param: "Keyword Param", signed_cookie: "Single Page Cookie" };
  ```

- [ ] **Step 1: Write the failing tests**

`apps/web/test/confirm-actions.ui.test.tsx` covers one cancel case and one accept case per action. Reuse the fixture style of `lifecycle.ui.test.tsx` and `redeploy.ui.test.tsx` (copy the minimal `fetch` stub they use; it routes by URL path and records requests). Required cases, each asserting the request list:

```tsx
it.each([
  ["rollback", "ย้อนกลับ (Rollback)", "/rollback"],
  ["recover", "กู้คืน (Recover, Owner)", "/recover"],
])("%s asks first and sends nothing on cancel", async (_name, button, suffix) => {
  // render BrandLifecycle as Owner with a live brand whose actions allow rollback/recover
  fireEvent.click(await screen.findByRole("button", { name: button }));
  await answerConfirm(false);
  expect(requests.some((r) => r.method === "POST" && r.path.endsWith(suffix))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: button }));
  await answerConfirm(true);
  await waitFor(() => expect(requests.some((r) => r.method === "POST" && r.path.endsWith(suffix))).toBe(true));
});
```

Also:
- Upgrade-all: click `เริ่มอัปเกรดทุกแบรนด์ (Start upgrade-all)`, cancel, no `POST /api/upgrade-all`; accept, one request.
- ConfigPanel pause: click `หยุดชั่วคราว (Pause)`, cancel, no `POST .../pause`; accept, one request.
- ConfigPanel resume (paused brand): `เปิดใช้งานต่อ (Resume)` goes through the dialog the same way.
- ConfigPanel flow gate: change the select to `signed_cookie`; cancel sends no `PATCH`, and the select still shows `param`; accept sends one `PATCH` with `flow_gate_mode: "signed_cookie"`. The options read `Keyword Param` and `Single Page Cookie`.
- Users role change: change a user's role select; cancel sends no `PATCH /api/users/...`, and the select keeps the old value; accept sends one.

For the recover case, use a fixture whose install has `recovery_required: true`, which is what makes `actions.recover` true (`lifecycle-state.ts` `lifecycleMutationAvailability`).

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && bunx vitest run --project ui test/confirm-actions.ui.test.tsx`
Expected: FAIL, no alertdialog appears.

- [ ] **Step 3: Implement**

- BrandLifecycle `rollback()`: `if (!(await confirm({ title: "ย้อนกลับแบรนด์นี้เป็นเวอร์ชันก่อนหน้า?", body: "Roll the brand back to its previous version.", confirmLabel: "ย้อนกลับ (Rollback)", tone: "danger" }))) return;`
- BrandLifecycle `recover()`: `title: "กู้คืนแบรนด์นี้?"`, `body: "Recover runs the compensation install for this brand."`, `confirmLabel: "กู้คืน (Recover)"`, `tone: "danger"`.
- Upgrade-all button: wrap in `async () => { if (!(await confirm({ title: "เริ่มอัปเกรดทุกแบรนด์?", body: \`Upgrade every brand from ${upgrade.from_template_version_id || "—"} to ${upgrade.to_template_version_id || "—"}, canary ${upgrade.canary_brand_id || "—"} first.\`, confirmLabel: "เริ่มอัปเกรด (Start upgrade)", tone: "danger" }))) return; void act(...) }`.
- ConfigPanel pause/resume: `title: brand.status === "live" ? "หยุดแบรนด์นี้ชั่วคราว?" : "เปิดแบรนด์นี้ต่อ?"`, `body: brand.status === "live" ? "Pause stops new leads on this brand until it is resumed." : "Resume starts taking leads again."`, `confirmLabel` equal to the button text, `tone: brand.status === "live" ? "danger" : "default"`.
- ConfigPanel flow gate: controlled select; on change read `next`, then `if (!(await confirm({ title: \`เปลี่ยนเกตของโฟลว์เป็น ${flowGateLabel[next]}?\`, body: "Changes how visitors move from the landing page to the form.", confirmLabel: "เปลี่ยน (Change)" }))) return;` then `save({ flow_gate_mode: next })`. Option text: `{flowGateLabel.param}` and `{flowGateLabel.signed_cookie}`; keep the `value` attributes.
- Users role select: `if (!(await confirm({ title: \`เปลี่ยนสิทธิ์ของ ${u.email} เป็น ${next === "owner" ? "Owner" : "พนักงาน"}?\`, confirmLabel: "เปลี่ยนสิทธิ์ (Change role)", tone: next === "owner" ? "danger" : "default" }))) return;` The select stays controlled by `u.role`, so a cancel leaves it unchanged.
- Render `{confirmDialog}` in `UsersScreen`.

- [ ] **Step 4: Run tests**

Run: `cd apps/web && bunx vitest run --project ui`
Expected: PASS (existing lifecycle, redeploy and config-panel tests updated with `answerConfirm(true)` where they now hit a dialog).

- [ ] **Step 5: Typecheck and commit**

```bash
bun run --cwd apps/web typecheck
git add apps/web/src/client apps/web/test
git commit -m "feat(web): confirm before rollback, recover, upgrade-all, pause, flow gate and role changes (FUS-374)"
```

---

### Task 8: Shared components

**Files:**
- Create: `apps/web/src/client/components/DataTable.tsx`
- Create: `apps/web/src/client/components/StatusBadge.tsx`
- Create: `apps/web/src/client/components/EmptyState.tsx`
- Create: `apps/web/src/client/components/Spinner.tsx`
- Create: `apps/web/src/client/components/Toast.tsx`
- Modify: `apps/web/src/client/screens/Audit.tsx` (use `DataTable`, `EmptyState`, `Spinner`)
- Modify: `apps/web/src/client/App.tsx` (loading state uses `Spinner`)
- Modify: `apps/web/src/client/screens/BrandLifecycle.tsx:41-45,347,389` (status pills use `StatusBadge`)
- Modify: `apps/web/src/client/styles.css` (append component rules)
- Test: `apps/web/test/components.ui.test.tsx`

**Interfaces:**
- Produces:
  - `type Column<T> = { key: string; header: ReactNode; cell: (row: T) => ReactNode; align?: "left" | "right"; mono?: boolean }`
  - `DataTable<T>({ columns, rows, rowKey, empty, label }: { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; empty: ReactNode; label: string })`
  - `type Tone = "live" | "warn" | "bad" | "mute" | "blue"`
  - `StatusBadge({ tone, label }: { tone: Tone; label: string })`
  - `EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode })`
  - `Spinner({ label }: { label?: string })` default label `กำลังโหลด…`
  - `Toast({ kind, text, onDismiss, timeoutMs }: { kind: "ok" | "err"; text: string; onDismiss: () => void; timeoutMs?: number })` default `timeoutMs` 5000

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/test/components.ui.test.tsx
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "../src/client/components/DataTable";
import { EmptyState } from "../src/client/components/EmptyState";
import { Spinner } from "../src/client/components/Spinner";
import { StatusBadge } from "../src/client/components/StatusBadge";
import { Toast } from "../src/client/components/Toast";

afterEach(() => { cleanup(); vi.useRealTimers(); });

type Row = { id: string; n: number };
const columns = [
  { key: "id", header: "ID", cell: (r: Row) => r.id, mono: true },
  { key: "n", header: "N", cell: (r: Row) => r.n.toLocaleString("en-US"), align: "right" as const },
];

describe("DataTable", () => {
  it("renders headers, cells, monospace ids and right-aligned numbers", () => {
    render(<DataTable label="rows" columns={columns} rows={[{ id: "a1", n: 1200 }]} rowKey={(r) => r.id} empty="none" />);
    const table = screen.getByRole("table", { name: "rows" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["ID", "N"]);
    const cells = within(table).getAllByRole("cell");
    expect(cells[0]!.className).toContain("mono");
    expect(cells[1]!.className).toContain("num");
    expect(cells[1]!.textContent).toBe("1,200");
  });

  it("shows the empty content in one full-width cell", () => {
    render(<DataTable label="rows" columns={columns} rows={[]} rowKey={(r) => r.id} empty={<EmptyState title="ยังไม่มีรายการ" />} />);
    const cell = screen.getByRole("cell");
    expect(cell.getAttribute("colspan")).toBe("2");
    expect(within(cell).getByText("ยังไม่มีรายการ")).toBeTruthy();
  });
});

describe("StatusBadge", () => {
  it("carries color, icon and text", () => {
    render(<StatusBadge tone="bad" label="ล้มเหลว (failed)" />);
    const badge = screen.getByText("ล้มเหลว (failed)").closest(".pill")!;
    expect(badge.className).toContain("p-bad");
    expect(badge.querySelector('[aria-hidden="true"]')?.textContent).toBe("✕");
  });
});

describe("Spinner", () => {
  it("announces loading", () => {
    render(<Spinner />);
    expect(screen.getByRole("status").textContent).toContain("กำลังโหลด…");
  });
});

describe("Toast", () => {
  it("dismisses on click and after the timeout", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast kind="err" text="ไม่สำเร็จ" onDismiss={onDismiss} timeoutMs={1000} />);
    expect(screen.getByRole("alert").textContent).toContain("ไม่สำเร็จ");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "ปิด (Close)" }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("uses role=status for a success", () => {
    render(<Toast kind="ok" text="บันทึกแล้ว" onDismiss={() => undefined} />);
    expect(screen.getByRole("status").textContent).toContain("บันทึกแล้ว");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && bunx vitest run --project ui test/components.ui.test.tsx`
Expected: FAIL, missing modules.

- [ ] **Step 3: Implement**

```tsx
// DataTable.tsx
import type { ReactNode } from "react";

export type Column<T> = { key: string; header: ReactNode; cell: (row: T) => ReactNode; align?: "left" | "right"; mono?: boolean };

export function DataTable<T>({ columns, rows, rowKey, empty, label }: { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; empty: ReactNode; label: string }) {
  const cls = (c: Column<T>) => [c.align === "right" ? "num" : "", c.mono ? "mono" : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className="tw data-table">
      <table aria-label={label}>
        <thead><tr>{columns.map((c) => <th key={c.key} scope="col" className={cls(c)}>{c.header}</th>)}</tr></thead>
        <tbody>
          {rows.map((row) => <tr key={rowKey(row)}>{columns.map((c) => <td key={c.key} className={cls(c)}>{c.cell(row)}</td>)}</tr>)}
          {rows.length === 0 && <tr><td colSpan={columns.length}>{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
```

```tsx
// StatusBadge.tsx
export type Tone = "live" | "warn" | "bad" | "mute" | "blue";
const icon: Record<Tone, string> = { live: "●", warn: "▲", bad: "✕", mute: "○", blue: "◆" };

export function StatusBadge({ tone, label }: { tone: Tone; label: string }) {
  return <span className={`pill p-${tone} status-badge`}><span aria-hidden="true">{icon[tone]}</span>{label}</span>;
}
```

```tsx
// EmptyState.tsx
import type { ReactNode } from "react";
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return <div className="empty-state"><p className="empty-title">{title}</p>{hint && <p className="hint">{hint}</p>}{action}</div>;
}
```

```tsx
// Spinner.tsx
export function Spinner({ label = "กำลังโหลด…" }: { label?: string }) {
  return <div className="spinner" role="status"><span className="spinner-ring" aria-hidden="true" />{label}</div>;
}
```

```tsx
// Toast.tsx
import { useEffect } from "react";
export function Toast({ kind, text, onDismiss, timeoutMs = 5000 }: { kind: "ok" | "err"; text: string; onDismiss: () => void; timeoutMs?: number }) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, timeoutMs);
    return () => window.clearTimeout(timer);
  }, [text, timeoutMs, onDismiss]);
  return (
    <div className={`toast toast-${kind}`} role={kind === "err" ? "alert" : "status"}>
      <span>{text}</span>
      <button type="button" className="link" aria-label="ปิด (Close)" onClick={onDismiss}>×</button>
    </div>
  );
}
```

CSS to append:

```css
.data-table thead th { position: sticky; top: 0; background: var(--raised); z-index: 1; }
.data-table td { height: var(--row-h); padding-block: 6px; }
.data-table .mono { font-family: var(--mono); font-size: var(--text-sm); }
.data-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.status-badge { display: inline-flex; gap: 4px; align-items: center; }
.empty-state { padding: var(--space-5); text-align: center; color: var(--muted); }
.empty-title { margin: 0 0 4px; color: var(--ink); font-weight: 500; }
.spinner { display: inline-flex; gap: var(--space-2); align-items: center; color: var(--muted); }
.spinner-ring { width: 14px; height: 14px; border: 2px solid var(--line); border-top-color: var(--money); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.toast { position: fixed; right: 16px; bottom: 16px; z-index: 40; display: flex; gap: var(--space-3); align-items: center; padding: 10px 14px; border-radius: var(--radius-md); box-shadow: var(--shadow-2); background: var(--raised); border: 1px solid var(--line); max-width: min(420px, calc(100vw - 32px)); }
.toast-ok { border-left: 3px solid var(--money); }
.toast-err { border-left: 3px solid var(--bad); }
```

The existing `@media (prefers-reduced-motion: reduce)` rule removes transitions; add `.spinner-ring { animation: none; }` inside it.

Adopt:
- `App.tsx` loading: `if (loading) return <div className="center"><Spinner /></div>;`
- `Audit.tsx`: replace the table with `DataTable` (label `ประวัติการแก้ไข`), columns as today (`actor_id` and `action` with `mono: true`); `empty={<EmptyState title="ยังไม่มีรายการ" />}`; loading uses `<Spinner />`.
- `BrandLifecycle.tsx`: replace `statusTone` + `tone()` with `const statusBadgeTone: Record<string, Tone> = { live: "live", failed: "bad", rolled_back: "warn", installing: "blue", draft: "mute", paused: "warn", unmanaged: "mute", retired: "mute" };` and render `<StatusBadge tone={statusBadgeTone[brand.status] ?? "mute"} label={statusLabel[brand.status] ?? brand.status} />` at lines 347 and 389.

- [ ] **Step 4: Run tests**

Run: `cd apps/web && bunx vitest run --project ui`
Expected: PASS. If an existing test reads a status pill by exact text, the icon is inside `aria-hidden` and not in the label text node, so `getByText(label)` still matches the inner text only when the test uses a function matcher; if a test fails on `textContent` equality, compare with `toContain`.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run --cwd apps/web typecheck
git add apps/web/src/client apps/web/test
git commit -m "feat(web): DataTable, StatusBadge, EmptyState, Spinner and Toast; Audit and brand status use them (FUS-374)"
```

---

### Task 9: Domain labels everywhere

**Files:**
- Create: `apps/web/src/client/brand-labels.tsx`
- Modify: `apps/web/src/client/screens/Funnel.tsx:128,169`
- Modify: `apps/web/src/client/screens/Alerts.tsx:56,59,62`
- Modify: `apps/web/src/client/screens/Audit.tsx` (target column for `target.type === "brand"`)
- Modify: `apps/web/src/client/screens/UpgradeOutcomes.tsx:52`
- Test: `apps/web/test/brand-labels.ui.test.tsx`

**Interfaces:**
- Consumes: `api.lifecycleBrands()`, `api.brands()` from `api.ts`.
- Produces:
  - `buildBrandLabels(lifecycle: Pick<LifecycleBrandSummary, "brand_id" | "hostnames">[] | null, runtime: Pick<BrandSummary, "brand_id" | "hostnames">[] | null): Map<string, string>`
  - `useBrandLabels(): (brandId: string) => string` (returns the domain, or the `brandId` itself when unknown or still loading)
  - `BrandLabel({ brandId, domain }: { brandId: string; domain?: string | null })` renders `<span className="brand-label" title={brandId}>{shown}{shown !== brandId && <code className="brand-id">{brandId}</code>}</span>` where `shown = domain || labelOf(brandId)`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/test/brand-labels.ui.test.tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { BrandLabel, buildBrandLabels } from "../src/client/brand-labels";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("buildBrandLabels", () => {
  it("prefers the factory domain, falls back to the runtime hostname", () => {
    const map = buildBrandLabels(
      [{ brand_id: "b1", hostnames: ["one.example"] }],
      [{ brand_id: "b1", hostnames: ["www.one.example"] }, { brand_id: "b2", hostnames: ["two.example"] }],
    );
    expect(map.get("b1")).toBe("one.example");
    expect(map.get("b2")).toBe("two.example");
    expect(map.has("b3")).toBe(false);
  });

  it("works when one source failed", () => {
    expect(buildBrandLabels(null, [{ brand_id: "b2", hostnames: ["two.example"] }]).get("b2")).toBe("two.example");
    expect(buildBrandLabels([{ brand_id: "b1", hostnames: ["one.example"] }], null).get("b1")).toBe("one.example");
  });
});

describe("BrandLabel", () => {
  it("shows the domain first and the id in monospace", async () => {
    vi.spyOn(api, "lifecycleBrands").mockResolvedValue({ brands: [{ brand_id: "b1", hostnames: ["one.example"] }] as never });
    vi.spyOn(api, "brands").mockResolvedValue({ brands: [], generated_at: "2026-10-23T00:00:00.000Z" });
    render(<BrandLabel brandId="b1" />);
    expect(await screen.findByText("one.example")).toBeTruthy();
    expect(screen.getByText("b1").tagName).toBe("CODE");
  });

  it("falls back to the id when both sources fail", async () => {
    vi.spyOn(api, "lifecycleBrands").mockRejectedValue(new Error("down"));
    vi.spyOn(api, "brands").mockRejectedValue(new Error("down"));
    render(<BrandLabel brandId="b9" />);
    expect(await screen.findByText("b9")).toBeTruthy();
    expect(document.querySelector(".brand-id")).toBeNull();
  });

  it("uses an explicit domain without a lookup result", () => {
    vi.spyOn(api, "lifecycleBrands").mockReturnValue(new Promise(() => undefined));
    vi.spyOn(api, "brands").mockReturnValue(new Promise(() => undefined));
    render(<BrandLabel brandId="b1" domain="given.example" />);
    expect(screen.getByText("given.example")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && bunx vitest run --project ui test/brand-labels.ui.test.tsx`
Expected: FAIL, missing module.

- [ ] **Step 3: Implement**

```tsx
// apps/web/src/client/brand-labels.tsx
import type { BrandSummary, LifecycleBrandSummary } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { api } from "./api";

type Source = Pick<LifecycleBrandSummary, "brand_id" | "hostnames">[] | null;

export function buildBrandLabels(lifecycle: Source, runtime: Pick<BrandSummary, "brand_id" | "hostnames">[] | null): Map<string, string> {
  const map = new Map<string, string>();
  for (const b of runtime ?? []) if (b.hostnames[0]) map.set(b.brand_id, b.hostnames[0]);
  // The factory domain wins over the runtime hostname.
  for (const b of lifecycle ?? []) if (b.hostnames[0]) map.set(b.brand_id, b.hostnames[0]);
  return map;
}

/** brand_id to domain. Unknown ids, and ids asked before the lists load, read as the id itself. */
export function useBrandLabels(): (brandId: string) => string {
  const [map, setMap] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    let active = true;
    void Promise.allSettled([api.lifecycleBrands(), api.brands()]).then(([lifecycle, runtime]) => {
      if (!active) return;
      setMap(buildBrandLabels(lifecycle.status === "fulfilled" ? lifecycle.value.brands : null, runtime.status === "fulfilled" ? runtime.value.brands : null));
    });
    return () => { active = false; };
  }, []);
  return (brandId) => map.get(brandId) ?? brandId;
}

export function BrandLabel({ brandId, domain }: { brandId: string; domain?: string | null }) {
  const labelOf = useBrandLabels();
  const shown = domain || labelOf(brandId);
  return <span className="brand-label" title={brandId}>{shown}{shown !== brandId && <code className="brand-id">{brandId}</code>}</span>;
}
```

A screen with many rows calls `useBrandLabels()` once and renders `<BrandLabel brandId={id} domain={labelOf(id)} />` per row, so it fetches once per screen.

CSS: `.brand-label { display: inline-flex; flex-direction: column; } .brand-label .brand-id { font-family: var(--mono); font-size: var(--text-xs); color: var(--muted); }`.

Adopt:
- `Funnel.tsx:128`: `<td><BrandLabel brandId={b.brand_id} domain={labelOf(b.brand_id) !== b.brand_id ? labelOf(b.brand_id) : b.hostname || null} /></td>`; line 169: `<td><BrandLabel brandId={r.brand} domain={labelOf(r.brand)} /></td>`.
- `Alerts.tsx` lines 56, 59, 62: replace `{b.brand}` with `<BrandLabel brandId={b.brand} domain={labelOf(b.brand)} />`.
- `Audit.tsx` target column: `e.target.type === "brand" ? <BrandLabel brandId={e.target.id} domain={labelOf(e.target.id)} /> : \`${e.target.type}:${e.target.id}\``.
- `UpgradeOutcomes.tsx:52`: `<th scope="row"><BrandLabel brandId={row.brand_id} domain={row.domain} /></th>`.

Existing tests that mock `fetch` by path (for example `funnel.ui.test.tsx`) now also see `/api/lifecycle/brands` and `/api/brands`. Make their stubs answer those two paths with `{ brands: [] , core_error: null }` and `{ brands: [], generated_at: "2026-10-23T00:00:00.000Z" }`, or a 404 that the hook treats as a failed source. Assertions on `brand-a` still pass because the id stays in the `code` element.

- [ ] **Step 4: Run tests**

Run: `cd apps/web && bunx vitest run --project ui`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run --cwd apps/web typecheck
git add apps/web/src/client apps/web/test
git commit -m "feat(web): brand domain labels in Funnel, Alerts, Audit and upgrade outcomes (FUS-374)"
```

---

### Task 10: Brand row basics

**Files:**
- Modify: `apps/web/src/client/screens/BrandLifecycle.tsx:333-360` (flow-gate label, Pause/Resume on the row, toast)
- Modify: `apps/web/src/client/screens/Brands.css` (row action cell)
- Delete: `apps/web/src/client/screens/Brands.tsx`
- Test: `apps/web/test/brand-row.ui.test.tsx`

**Interfaces:**
- Consumes: `useConfirm` (Task 5), `StatusBadge` (Task 8), `Toast` (Task 8), `flowGateLabel` (Task 7), `answerConfirm` (Task 5 helper).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

`apps/web/test/brand-row.ui.test.tsx`, reusing the fetch-stub pattern of `lifecycle.ui.test.tsx` with two brands: `b-live` (lifecycle `live`, runtime `live`, `flow_gate_mode: "param"`) and `b-paused` (lifecycle `paused`, runtime `paused`, `flow_gate_mode: "signed_cookie"`). Cases:

```tsx
it("shows the flow-gate label on each row", async () => {
  render(<BrandLifecycle me={owner} />);
  const live = await rowOf("live.example");
  expect(within(live).getByText("Keyword Param")).toBeTruthy();
  expect(within(await rowOf("paused.example")).getByText("Single Page Cookie")).toBeTruthy();
});

it("pauses from the row after a confirm, without selecting the row", async () => {
  render(<BrandLifecycle me={owner} />);
  const live = await rowOf("live.example");
  fireEvent.click(within(live).getByRole("button", { name: "หยุดชั่วคราว (Pause)" }));
  await answerConfirm(false);
  expect(requests.filter((r) => r.path === "/api/brands/b-live/pause")).toHaveLength(0);
  fireEvent.click(within(live).getByRole("button", { name: "หยุดชั่วคราว (Pause)" }));
  await answerConfirm(true);
  await waitFor(() => expect(requests.filter((r) => r.method === "POST" && r.path === "/api/brands/b-live/pause")).toHaveLength(1));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringContaining("หยุดแบรนด์แล้ว"));
});

it("lets an Employee resume a paused brand but not pause a live one", async () => {
  render(<BrandLifecycle me={{ ...owner, role: "employee" }} />);
  expect(within(await rowOf("live.example")).queryByRole("button", { name: "หยุดชั่วคราว (Pause)" })).toBeNull();
  expect(within(await rowOf("paused.example")).getByRole("button", { name: "เปิดใช้งานต่อ (Resume)" })).toBeTruthy();
});

it("shows a failed pause as an error toast", async () => {
  pauseStatus = 500;
  render(<BrandLifecycle me={owner} />);
  fireEvent.click(within(await rowOf("live.example")).getByRole("button", { name: "หยุดชั่วคราว (Pause)" }));
  await answerConfirm(true);
  expect(await screen.findByRole("alert")).toBeTruthy();
});
```

`rowOf(domain)` finds the text and returns its closest `tr`. `pauseStatus` is a variable the fetch stub uses for `POST /api/brands/:id/pause`. Employee may resume and only the Owner may pause; this matches `ConfigPanel.tsx:65`.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && bunx vitest run --project ui test/brand-row.ui.test.tsx`
Expected: FAIL, no flow-gate text.

- [ ] **Step 3: Implement**

- Add a `โฟลว์ (Flow gate)` column after Status. Cell: `{runtime ? flowGateLabel[runtime.flow_gate_mode] : "—"}` where `runtime = runtimeBrands.find((r) => r.brand_id === brand.brand_id)`. Raise `columns` by 1 for both roles (`owner ? 8 : 5`).
- In the Status cell, after the `StatusBadge`, render the row action when `runtime` exists and either `runtime.status === "paused"` or (`runtime.status === "live"` and `owner`):
  ```tsx
  <button type="button" className={runtime.status === "live" ? "btn warn row-action" : "btn pri row-action"}
    onClick={(e) => { e.stopPropagation(); void toggleStatus(runtime); }}>
    {runtime.status === "live" ? "หยุดชั่วคราว (Pause)" : "เปิดใช้งานต่อ (Resume)"}
  </button>
  ```
- `toggleStatus(runtime: BrandSummary)`: confirm with the same title, body and tone as the ConfigPanel pause/resume in Task 7, call `api.setStatus(runtime.brand_id, runtime.status === "live" ? "pause" : "resume")`, then `setToast({ kind: "ok", text: runtime.status === "live" ? "หยุดแบรนด์แล้ว" : "เปิดแบรนด์แล้ว" })` and `await load()`; on error `setToast({ kind: "err", text: e instanceof ApiError ? e.thai : "ไม่สำเร็จ" })`.
- `const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);` and render `{toast && <Toast kind={toast.kind} text={toast.text} onDismiss={() => setToast(null)} />}` plus `{confirmDialog}`. Wrap `onDismiss` in `useCallback` so the Toast timer does not restart on every render.
- `Brands.css`: `.brand-table .row-action { margin-left: 8px; padding: 3px 8px; font-size: 12px; }`.
- Delete `screens/Brands.tsx` after `grep -rn "screens/Brands\"\|BrandsScreen" apps/web/src apps/web/test` returns nothing outside that file.

- [ ] **Step 4: Run tests**

Run: `cd apps/web && bunx vitest run --project ui`
Expected: PASS. Update `lifecycle.ui.test.tsx` and `brands-page.ui.test.tsx` column-count or header assertions for the new Flow gate column.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
bun run --cwd apps/web typecheck && bun run --cwd apps/web test
git add -A apps/web
git commit -m "feat(web): brand rows show the flow-gate label and pause or resume after a confirm; drop the dead Brands wrapper (FUS-374)"
```

---

## Final verification (after Task 10)

- `bun run typecheck` and `bun run test` at the repo root, both green.
- Local panel with mock core (`apps/web` dev setup in `src/server/local-dev.ts`): open `/`, `/brands`, `/brands/<id>`, `/brands/new`, `/templates/<id>`, `/#templates/<id>`, `/nope` directly; reload each; use the back button; click Rollback, Pause, Upgrade-all, flow gate and role change and cancel each.
- Screenshots at 1440 px and 375 px width of Home, Brands, the open mobile drawer and a confirm dialog.
