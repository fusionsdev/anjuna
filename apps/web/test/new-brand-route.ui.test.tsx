import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleBrandSummary } from "@anjuna/contracts";
import { App } from "../src/client/App";
import { api } from "../src/client/api";

// The real App with the real Brands screen: the wizard entry points must go through the router.
const employee = { id: "employee", email: "employee@example.test", role: "employee" as const };
const newBrand = "แบรนด์ใหม่ (New brand)";
const wizard = () => screen.queryByRole("region", { name: "วิซาร์ดแบรนด์ใหม่ (New brand wizard)" });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const back = () => act(async () => {
  window.history.back();
  await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
});
const forward = () => act(async () => {
  window.history.forward();
  await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
});

let routes: Record<string, unknown>;

beforeEach(() => {
  window.history.replaceState(null, "", "/brands");
  vi.spyOn(api, "me").mockResolvedValue(employee);
  vi.spyOn(api, "alerts").mockRejectedValue(new Error("Unavailable"));
  routes = {
    "/api/upgrade-all/latest": { upgrade: null },
    "/api/lifecycle/brands": { brands: [] },
    "/api/brands": { brands: [], generated_at: "2026-10-23T00:00:00Z" },
    "/api/funnel": { from: "2026-10-16T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z", rows: [] },
    "/api/templates": { templates: [] },
    "/api/wizard/defaults": { amount_buckets: [100, 200, 300], form_route: "/request" },
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const body = routes[input.split("?")[0]!];
    if (body === undefined) throw new Error(`Unexpected test HTTP request: ${input}`);
    return json(body);
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("New brand button on the Brands page", () => {
  it("opens /brands/new with the wizard, and Back closes the wizard", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: newBrand }));
    expect(await screen.findByRole("region", { name: "วิซาร์ดแบรนด์ใหม่ (New brand wizard)" })).toBeTruthy();
    expect(window.location.pathname).toBe("/brands/new");
    await back();
    expect(window.location.pathname).toBe("/brands");
    await waitFor(() => expect(wizard()).toBeNull());
    expect(await screen.findByRole("button", { name: newBrand })).toBeTruthy();
  });

  it("opens the wizard again from a reload at /brands/new", async () => {
    window.history.replaceState(null, "", "/brands/new");
    render(<App />);
    expect(await screen.findByRole("region", { name: "วิซาร์ดแบรนด์ใหม่ (New brand wizard)" })).toBeTruthy();
  });
});

describe("a resumed draft wizard", () => {
  const row = (id: string, name: string, host: string, status: string) => LifecycleBrandSummary.parse({
    brand_id: id, name, account: "test-account", hostnames: [host], status, current_revision_id: status === "draft" ? null : "rev-1",
    runtime_sync_status: status === "draft" ? "queued" : "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01",
  });
  const draft = {
    brand: { brand_id: "brand_new", name: "Maple Cash", domain: "maple.test", keyword_default: "Quick Loan", status: "draft" },
    revision: { revision_id: "brand_new_rev_1", revision: 1, template_version_id: "tv-1", form_artifact_id: "fa-1" },
    profile: { contact: { phone: "+1 (555) 010-0199", address: "12 Main St, Austin, TX 78701", email: "help@maplecash.test" }, copy: {}, ads: {} },
  };
  beforeEach(() => {
    Object.assign(routes, {
      "/api/lifecycle/brands": { brands: [row("brand_live", "Live Cash", "live.test", "live"), row("brand_new", "Maple Cash", "maple.test", "draft")] },
      "/api/brands/brand_live/checklist": { brand_id: "brand_live", checklist: [] },
      "/api/brands/brand_live/installs": { brand_id: "brand_live", installs: [] },
      "/api/brands/brand_new/checklist": { brand_id: "brand_new", checklist: [] },
      "/api/brands/brand_new/installs": { brand_id: "brand_new", installs: [] },
      "/api/wizard/drafts/brand_new": draft,
      "/api/wizard/zone-check": { zone_active: true, zone_name: "maple.test", nameservers: [], conflicting_records: [] },
      "/api/templates": { templates: [] },
    });
  });

  it("closes when Back returns to /brands, and the draft stays selected", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Live Cash" });
    fireEvent.click(screen.getByRole("button", { name: /Maple Cash/ }));
    expect(window.location.pathname).toBe("/brands/brand_new");
    fireEvent.click(await screen.findByRole("button", { name: "ทำต่อในวิซาร์ด (Resume in wizard)" }));
    expect(await screen.findByRole("region", { name: "วิซาร์ดแบรนด์ใหม่ (New brand wizard)" })).toBeTruthy();
    await back();
    expect(window.location.pathname).toBe("/brands");
    await waitFor(() => expect(wizard()).toBeNull());
    expect(await screen.findByRole("heading", { name: "Maple Cash" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Live Cash" })).toBeNull();
  });

  it("is replaced by the new-brand wizard when Forward enters /brands/new, and Back closes it", async () => {
    // The draft comes first, so it is the default selection at /brands and Resume does not change the URL.
    routes["/api/lifecycle/brands"] = { brands: [row("brand_new", "Maple Cash", "maple.test", "draft"), row("brand_live", "Live Cash", "live.test", "live")] };
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: newBrand }));
    expect(await screen.findByRole("region", { name: "วิซาร์ดแบรนด์ใหม่ (New brand wizard)" })).toBeTruthy();
    await back();
    await waitFor(() => expect(wizard()).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "ทำต่อในวิซาร์ด (Resume in wizard)" }));
    expect(await screen.findByRole("heading", { level: 2, name: "ตรวจสอบ (Review)" })).toBeTruthy();
    expect(window.location.pathname).toBe("/brands");
    await forward();
    expect(window.location.pathname).toBe("/brands/new");
    expect(await screen.findByRole("heading", { level: 2, name: "แบรนด์ (Brand)" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "ชื่อแบรนด์ (Brand name)" }) as HTMLInputElement).value).toBe("");
    await back();
    expect(window.location.pathname).toBe("/brands");
    await waitFor(() => expect(wizard()).toBeNull());
    expect(await screen.findByRole("heading", { name: "Maple Cash" })).toBeTruthy();
  });
});
