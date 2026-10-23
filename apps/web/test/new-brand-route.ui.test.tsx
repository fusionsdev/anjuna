import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import { api } from "../src/client/api";

// The real App with the real Brands screen: the New brand button must go through the router.
const employee = { id: "employee", email: "employee@example.test", role: "employee" as const };
const newBrand = "แบรนด์ใหม่ (New brand)";
const wizard = () => screen.queryByRole("region", { name: "วิซาร์ดแบรนด์ใหม่ (New brand wizard)" });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const back = () => act(async () => {
  window.history.back();
  await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
});

beforeEach(() => {
  window.history.replaceState(null, "", "/brands");
  vi.spyOn(api, "me").mockResolvedValue(employee);
  vi.spyOn(api, "alerts").mockRejectedValue(new Error("Unavailable"));
  const routes: Record<string, unknown> = {
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
