import { BrandConfig } from "@anjuna/contracts";
import brandFixture from "@anjuna/contracts/fixtures/admin/brand.get.response.json";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigPanel } from "../src/client/screens/ConfigPanel";

// spec polish D6.2 and D8.2: the loading title names the domain, and A/B weights
// are read-only here with a link into Settings.
const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const employee = { ...owner, id: "employee", role: "employee" as const };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Handler = (init?: RequestInit) => Response | Promise<Response>;
let routes: Map<string, Handler>;
let brand: BrandConfig;

const abOn: BrandConfig["ab_config"] = { experiment_id: "exp-1", variants: [{ id: "lite_v1", weight: 60 }, { id: "full_v1", weight: 40 }] };

beforeEach(() => {
  brand = BrandConfig.parse({ ...brandFixture.brand, brand_id: "brand-a", hostnames: ["config-domain.test"], ab_config: abOn });
  routes = new Map<string, Handler>([
    ["GET /api/lifecycle/brands", () => json({ brands: [{ brand_id: "brand-a", hostnames: ["config-domain.test"] }] })],
    ["GET /api/brands", () => json({ brands: [], generated_at: "2026-10-06T00:00:00Z" })],
    ["GET /api/brands/brand-a", () => json({ brand })],
    ["GET /api/brands/brand-a/site-text", () => json({ brand_id: "brand-a", defaults: null })],
    ["GET /api/brands/brand-a/edit", () => json({ brand_id: "brand-a", status: "live", template_version_id: "tv-1", microsoft_ads_account: null })],
    ["GET /api/brands/brand-a/assets", () => json({ brand_id: "brand-a", assets: [] })],
    ["GET /api/templates/sealed", () => json({ templates: [] })],
  ]);
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const handler = routes.get(`${method} ${input}`);
    if (!handler) throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
    return handler(init);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const panel = () => screen.findByRole("complementary", { name: "การตั้งค่าแบรนด์ (Brand config)" });
const holdBrand = () => routes.set("GET /api/brands/brand-a", () => new Promise<Response>(() => {}));

describe("ConfigPanel loading title", () => {
  it("is the domain, never the brand id", async () => {
    holdBrand();
    render(<ConfigPanel me={owner} brandId="brand-a" onClose={() => {}} onChanged={() => {}} />);
    expect(await screen.findByRole("heading", { name: "config-domain.test" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "brand-a" })).toBeNull();
  });

  it("falls back to กำลังโหลด… (Loading) while the domain is unknown", async () => {
    holdBrand();
    routes.set("GET /api/lifecycle/brands", () => json({ brands: [] }));
    render(<ConfigPanel me={owner} brandId="brand-a" onClose={() => {}} onChanged={() => {}} />);
    expect(await screen.findByRole("heading", { name: "กำลังโหลด… (Loading)" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "brand-a" })).toBeNull();
  });
});

describe("ConfigPanel A/B summary (spec polish D8.2)", () => {
  it("shows the A/B summary and an Edit in Settings link for an owner", async () => {
    render(<ConfigPanel me={owner} brandId="brand-a" onClose={() => {}} onChanged={() => {}} />);
    const drawer = await panel();
    expect(await within(drawer).findByText("exp-1: Lite (lite_v1) 60% / 14 ขั้น (aurum-14-step) 40%")).toBeTruthy();
    const link = within(drawer).getByRole("link", { name: "แก้ไขใน Settings (Edit in Settings)" });
    expect(link.getAttribute("href")).toBe("/settings?brand=brand-a");
    fireEvent.click(link);
    expect(window.location.pathname + window.location.search).toBe("/settings?brand=brand-a");
  });

  it("shows ปิด (Off) when the brand has no A/B test", async () => {
    brand = BrandConfig.parse({ ...brandFixture.brand, brand_id: "brand-a", hostnames: ["config-domain.test"], ab_config: null });
    render(<ConfigPanel me={owner} brandId="brand-a" onClose={() => {}} onChanged={() => {}} />);
    const drawer = await panel();
    expect(await within(drawer).findByText("ปิด (Off)")).toBeTruthy();
    expect(within(drawer).getByRole("link", { name: "แก้ไขใน Settings (Edit in Settings)" })).toBeTruthy();
  });

  it("has no A/B weight inputs", async () => {
    render(<ConfigPanel me={owner} brandId="brand-a" onClose={() => {}} onChanged={() => {}} />);
    const drawer = await panel();
    await within(drawer).findByRole("link", { name: "แก้ไขใน Settings (Edit in Settings)" });
    expect(within(drawer).queryByRole("slider")).toBeNull();
    expect(within(drawer).queryByRole("button", { name: /Save A\/B/ })).toBeNull();
    expect(within(drawer).queryByRole("spinbutton")).toBeNull();
  });

  it("hides the A/B section from an employee", async () => {
    render(<ConfigPanel me={employee} brandId="brand-a" onClose={() => {}} onChanged={() => {}} />);
    const drawer = await panel();
    await within(drawer).findByRole("heading", { name: "คีย์เวิร์ดเริ่มต้น (Keyword default)" });
    expect(within(drawer).queryByRole("heading", { name: "น้ำหนัก A/B (A/B weights)" })).toBeNull();
    expect(within(drawer).queryByRole("link", { name: "แก้ไขใน Settings (Edit in Settings)" })).toBeNull();
  });
});
