import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { api } from "../src/client/api";
import { isPlainLeftClick, navigate, parseRoute, routePath, useRoute, useSearch, viewPath } from "../src/client/router";

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
    ["/conversions", { view: "conversions" }],
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
    for (const path of ["/", "/brands", "/brands/new", "/brands/x%2Fy", "/templates", "/templates/tv-1", "/funnel", "/conversions", "/alerts", "/mailing", "/audit", "/users", "/builder-keys"]) {
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
    expect(isPlainLeftClick({ ...base, button: 2 })).toBe(false);
    expect(isPlainLeftClick({ ...base, metaKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, ctrlKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, shiftKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, altKey: true })).toBe(false);
  });
});

function Probe() {
  const route = useRoute();
  return <p>{JSON.stringify(route)}</p>;
}

function NavigateOnMount({ to }: { to: string }) {
  useEffect(() => navigate(to), [to]);
  return null;
}

function ProbeWithChildNavigation() {
  const route = useRoute();
  return (
    <>
      <p>{JSON.stringify(route)}</p>
      <NavigateOnMount to="/funnel" />
    </>
  );
}

function SearchProbe() {
  return <p data-testid="search">{useSearch()}</p>;
}

describe("useSearch", () => {
  it("follows the query string through navigate, replace, back and forward on one route", async () => {
    window.history.replaceState(null, "", "/conversions");
    render(<SearchProbe />);
    expect(screen.getByTestId("search").textContent).toBe("");
    // The route object is the same for every /conversions URL, so useRoute() alone would not re-render here.
    act(() => navigate("/conversions?status=dead"));
    expect(screen.getByTestId("search").textContent).toBe("?status=dead");
    act(() => navigate("/conversions?status=pending", { replace: true }));
    expect(screen.getByTestId("search").textContent).toBe("?status=pending");
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    });
    expect(screen.getByTestId("search").textContent).toBe("");
    await act(async () => {
      window.history.forward();
      await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    });
    expect(screen.getByTestId("search").textContent).toBe("?status=pending");
  });
});

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

  it("adds one history entry for two navigate() calls to the same path", () => {
    render(<Probe />);
    // A push drops any forward entry an earlier test left, so the length below counts only this test.
    act(() => navigate("/alerts"));
    const before = window.history.length;
    act(() => {
      navigate("/funnel");
      navigate("/funnel");
    });
    expect(window.history.length).toBe(before + 1);
    expect(screen.getByText(JSON.stringify({ view: "funnel" }))).toBeTruthy();
  });

  it("keeps a navigate() made by a child effect on mount", () => {
    render(<ProbeWithChildNavigation />);
    expect(screen.getByText(JSON.stringify({ view: "funnel" }))).toBeTruthy();
    expect(window.location.pathname).toBe("/funnel");
  });

  it("does not rewrite a hash that only starts with #templates", () => {
    window.history.replaceState(null, "", "/#templatesX");
    render(<Probe />);
    expect(screen.getByText(JSON.stringify({ view: "home" }))).toBeTruthy();
    expect(window.location.pathname).toBe("/");
    expect(window.location.hash).toBe("#templatesX");
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

// spec leads
describe("leads and suppressions routes", () => {
  it("parses /leads, /leads/<id> and /suppressions and round-trips each through routePath", () => {
    expect(parseRoute("/leads")).toEqual({ view: "leads", leadId: null });
    expect(parseRoute("/leads/a%20b")).toEqual({ view: "leads", leadId: "a b" });
    expect(parseRoute("/suppressions")).toEqual({ view: "suppressions" });
    // A bad escape reads as no id, the same as /brands/% and /templates/%.
    expect(parseRoute("/leads/%")).toEqual({ view: "leads", leadId: null });
    expect(routePath({ view: "leads", leadId: "a/b" })).toBe("/leads/a%2Fb");
    for (const path of ["/leads", "/leads/x%2Fy", "/suppressions"]) expect(routePath(parseRoute(path))).toBe(path);
  });

  it("builds an export URL that carries every set filter and the pii flag", () => {
    expect(api.leadsExportUrl({ from: "2026-10-01", to: "2026-10-31", brand: "brand-a", status: "sold", q: "" }, true))
      .toBe("/api/leads/export?from=2026-10-01&to=2026-10-31&brand=brand-a&status=sold&pii=1");
    expect(api.leadsExportUrl({ from: "2026-10-01", to: "", brand: "", status: "", q: "a&b=c" }, false))
      .toBe("/api/leads/export?from=2026-10-01&q=a%26b%3Dc");
  });
});
