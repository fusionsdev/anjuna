import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleBrandSummary } from "@anjuna/contracts";
import { App } from "../src/client/App";
import { api, type Me } from "../src/client/api";
import { BrandLifecycle } from "../src/client/screens/BrandLifecycle";
import { parseRoute, routePath } from "../src/client/router";

const owner: Me = { id: "u1", email: "owner@example.test", role: "owner" };
const LINK = "ไทม์ไลน์ (Timeline)";

const lifecycle = (id: string, extra: Record<string, unknown> = {}) => LifecycleBrandSummary.parse({
  brand_id: id, name: "Credit Genie", account: "test-account", hostnames: ["creditsgene.test"], status: "live", current_revision_id: `${id}_rev_1`,
  runtime_sync_status: "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01", ...extra,
});
const json = (body: unknown, status = 200) => Response.json(body, { status });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = new URL(input, "https://app.test").pathname;
    if (path === "/api/lifecycle/brands") return json({ brands: [lifecycle("b1"), lifecycle("legacy-1", { status: "unmanaged", hostnames: ["legacy.test"] })] });
    if (path === "/api/upgrade-all/latest") return json({ upgrade: null });
    if (path === "/api/brands") return json({ brands: [], generated_at: "2026-10-25T00:00:00.000Z" });
    if (path.endsWith("/checklist")) return json({ brand_id: "b1", checklist: [] });
    if (path.endsWith("/installs")) return json({ brand_id: "b1", installs: [] });
    if (path.endsWith("/revisions")) return json({ brand_id: "b1", current_revision_id: null, rollback_target_revision_id: null, revisions: [] });
    if (path === "/api/spend") return json({ from: "2026-10-18", to: "2026-10-25", brands: [] });
    if (path.startsWith("/api/funnel")) return json({ from: "2026-10-18", to: "2026-10-25", rows: [] });
    throw new Error(`Unexpected test HTTP request: ${input}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("brand timeline route", () => {
  it("parseRoute reads /brands/b1/timeline and routePath builds it back; a bad escape opens the brands list like /brands/%", () => {
    expect(parseRoute("/brands/b1/timeline")).toEqual({ view: "brand-timeline", brandId: "b1" });
    expect(parseRoute("/brands/b1/timeline/")).toEqual({ view: "brand-timeline", brandId: "b1" });
    expect(parseRoute("/brands/new/timeline")).toEqual({ view: "brand-timeline", brandId: "new" });
    expect(parseRoute("/brands/a%20b%2Fc/timeline")).toEqual({ view: "brand-timeline", brandId: "a b/c" });
    expect(routePath({ view: "brand-timeline", brandId: "b1" })).toBe("/brands/b1/timeline");
    expect(routePath({ view: "brand-timeline", brandId: "a b/c" })).toBe("/brands/a%20b%2Fc/timeline");
    expect(parseRoute(routePath({ view: "brand-timeline", brandId: "a b/c" }))).toEqual({ view: "brand-timeline", brandId: "a b/c" });
    expect(parseRoute("/brands/%/timeline")).toEqual(parseRoute("/brands/%"));
    expect(parseRoute("/brands/%/timeline")).toEqual({ view: "brands", brandId: null });
    expect(parseRoute("/brands/b1/other")).toEqual({ view: "not-found", path: "/brands/b1/other" });
  });

  it("the brand detail panel shows a Timeline link to /brands/<id>/timeline and a click navigates", async () => {
    render(<BrandLifecycle me={owner} routeBrandId="b1" />);
    const link = await screen.findByRole("link", { name: LINK });
    expect(link.getAttribute("href")).toBe("/brands/b1/timeline");
    expect(link.getAttribute("target")).toBeNull();
    fireEvent.click(link);
    expect(window.location.pathname).toBe("/brands/b1/timeline");
  });

  it("keeps the browser default for a modified click, and shows the link for an unmanaged brand without a factory record", async () => {
    render(<BrandLifecycle me={owner} routeBrandId="legacy-1" />);
    const link = await screen.findByRole("link", { name: LINK });
    expect(link.getAttribute("href")).toBe("/brands/legacy-1/timeline");
    // jsdom cannot follow a link; record what the component did, then stop the navigation attempt.
    let prevented: boolean | null = null;
    const record = (event: Event) => { prevented = event.defaultPrevented; event.preventDefault(); };
    document.addEventListener("click", record);
    try {
      fireEvent.click(link, { ctrlKey: true });
    } finally {
      document.removeEventListener("click", record);
    }
    expect(prevented).toBe(false);
    expect(window.location.pathname).toBe("/");
    fireEvent.click(link);
    expect(window.location.pathname).toBe("/brands/legacy-1/timeline");
  });

  it("opening /brands/b1/timeline renders the timeline screen with Brands active in the sidebar", async () => {
    vi.spyOn(api, "me").mockResolvedValue(owner);
    vi.spyOn(api, "alerts").mockRejectedValue(new Error("Unavailable"));
    const timeline = vi.spyOn(api, "brandTimeline").mockReturnValue(new Promise(() => undefined));
    window.history.replaceState(null, "", "/brands/b1/timeline");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "ไทม์ไลน์แบรนด์ (Brand timeline)" })).toBeTruthy();
    await waitFor(() => expect(timeline).toHaveBeenCalledWith("b1", expect.anything()));
    expect(screen.getByRole("link", { name: "แบรนด์" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByText(LINK)).toBeNull();
  });
});
