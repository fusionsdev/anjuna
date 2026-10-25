import { useEffect, useState } from "react";

/** One screen of the panel and the id it shows, read from the URL path. */
export type Route =
  | { view: "home" }
  | { view: "brands"; brandId: string | null }
  | { view: "new-brand" }
  | { view: "templates"; templateId: string | null }
  | { view: "funnel" }
  | { view: "conversions" }
  | { view: "alerts" }
  | { view: "deploys" }
  | { view: "mailing" }
  | { view: "audit" }
  | { view: "users" }
  | { view: "builder-keys" }
  // spec leads
  | { view: "leads"; leadId: string | null }
  | { view: "suppressions" }
  // spec settings
  | { view: "settings" }
  // spec timeline
  | { view: "brand-timeline"; brandId: string }
  | { view: "not-found"; path: string };
export type View = Route["view"];

// "new" is a reserved brand path segment: `/brands/new` is the wizard, never a brand id.
const STATIC: Record<string, Route> = {
  "/": { view: "home" },
  "/brands": { view: "brands", brandId: null },
  "/brands/new": { view: "new-brand" },
  "/templates": { view: "templates", templateId: null },
  "/funnel": { view: "funnel" },
  "/conversions": { view: "conversions" },
  "/alerts": { view: "alerts" },
  "/deploys": { view: "deploys" },
  "/mailing": { view: "mailing" },
  "/audit": { view: "audit" },
  "/users": { view: "users" },
  "/builder-keys": { view: "builder-keys" },
  // spec leads
  "/leads": { view: "leads", leadId: null },
  "/suppressions": { view: "suppressions" },
  // spec settings
  "/settings": { view: "settings" },
};

/** A bad escape such as "%" reads as no id, so the list opens. */
function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

// template-mcp links to `/#templates/<id>`; keep those links working.
const LEGACY_TEMPLATES_HASH = /^#templates(?:\/(.*))?$/;

export function parseRoute(pathname: string, hash = ""): Route {
  const legacy = LEGACY_TEMPLATES_HASH.exec(hash);
  if (legacy) return { view: "templates", templateId: legacy[1] ? decode(legacy[1]) : null };
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const fixed = STATIC[path];
  if (fixed) return fixed;
  // spec timeline
  const timeline = /^\/brands\/([^/]+)\/timeline$/.exec(path);
  if (timeline) {
    const id = decode(timeline[1]!);
    return id === null ? { view: "brands", brandId: null } : { view: "brand-timeline", brandId: id };
  }
  const one = /^\/(brands|templates|leads)\/([^/]+)$/.exec(path);
  if (one) {
    const id = decode(one[2]!);
    if (one[1] === "leads") return { view: "leads", leadId: id };
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
    case "leads":
      return route.leadId ? `/leads/${encodeURIComponent(route.leadId)}` : "/leads";
    case "brand-timeline": // spec timeline
      return `/brands/${encodeURIComponent(route.brandId)}/timeline`;
    case "not-found":
      return route.path;
    default:
      return viewPath(route.view);
  }
}

export function viewPath(view: Exclude<View, "not-found">): string {
  switch (view) {
    case "home": return "/";
    case "brand-timeline": return "/brands"; // needs a brand id, so routePath builds it; a bare view falls back to the list
    case "new-brand": return "/brands/new";
    default: return `/${view}`;
  }
}

const ROUTE_EVENT = "anjuna:route";

function go(path: string, options: { replace?: boolean }): void {
  // A click on the page already open must not add a second history entry.
  const samePage = !window.location.hash && path === window.location.pathname + window.location.search;
  if (options.replace || samePage) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

// spec settings: a screen with unsaved edits registers one guard; the location it guards is the page open when it was set.
let leaveGuard: (() => Promise<boolean>) | null = null;
let guardedLocation = "";

const fullLocation = () => window.location.pathname + window.location.search + window.location.hash;

/** A screen with unsaved edits registers one; null clears it. Resolves true when leaving is fine. */
export function setLeaveGuard(guard: (() => Promise<boolean>) | null): void {
  leaveGuard = guard;
  guardedLocation = guard ? fullLocation() : "";
}

/** Asks the guard once; runs `leave` when it answers true, even if the guard cleared itself first (a discard does). */
function askToLeave(leave: () => void): void {
  const guard = leaveGuard;
  if (!guard) return;
  void guard().then((ok) => {
    if (ok) leave();
  });
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (leaveGuard && path !== window.location.pathname + window.location.search) {
    askToLeave(() => go(path, options));
    return;
  }
  go(path, options);
}

function current(): Route {
  return parseRoute(window.location.pathname, window.location.hash);
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(current);
  useEffect(() => {
    const update = () => {
      // Rewrite a legacy hash link to its path so reload and back keep the screen.
      if (LEGACY_TEMPLATES_HASH.test(window.location.hash)) window.history.replaceState(null, "", routePath(current()));
      setRoute(current());
    };
    const onPop = () => {
      const destination = fullLocation();
      if (!leaveGuard || destination === guardedLocation) return update();
      // Put the guarded page back so the draft stays on screen while the owner decides.
      window.history.pushState(null, "", guardedLocation);
      askToLeave(() => go(destination, {}));
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    window.addEventListener(ROUTE_EVENT, update);
    // A navigate() from a child effect on mount ran before these listeners existed.
    update();
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onPop);
      window.removeEventListener(ROUTE_EVENT, update);
    };
  }, []);
  return route;
}

/**
 * The query string of the open page. A fixed route such as /conversions is one shared object, so useRoute() does not re-render
 * when only the query changes. This hook re-reads it on navigate(), Back and Forward.
 */
export function useSearch(): string {
  const [search, setSearch] = useState(() => window.location.search);
  useEffect(() => {
    const update = () => setSearch(window.location.search);
    window.addEventListener("popstate", update);
    window.addEventListener(ROUTE_EVENT, update);
    // A navigate() from a child effect on mount ran before these listeners existed.
    update();
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(ROUTE_EVENT, update);
    };
  }, []);
  return search;
}

/** A modified or middle click keeps the browser default: open the link in a new tab or window. */
export function isPlainLeftClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
