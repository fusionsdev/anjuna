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
