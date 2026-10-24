import { BrandConfig } from "@anjuna/contracts";
import brandFixture from "@anjuna/contracts/fixtures/admin/brand.get.response.json";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import { api } from "../src/client/api";
import { SettingsScreen } from "../src/client/screens/Settings";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const employee = { id: "employee", email: "employee@example.test", role: "employee" as const };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const brand = (over: Record<string, unknown> = {}) => BrandConfig.parse({ ...brandFixture.brand, ...over });
const ok = (b: BrandConfig) => ({ brand_id: b.brand_id, hostname: b.hostnames[0]!, brand: b, error: null });

const alpha = brand({
  brand_id: "brand-alpha", hostnames: ["alpha.example.test"], status: "live", aid: "111", prepop_base: "https://lg.example.test/alpha", drain_key: "dk_alpha",
  ab_config: { experiment_id: "exp-alpha", variants: [{ id: "lite_v1", weight: 60 }, { id: "full_v1", weight: 40 }] },
  flow_gate_mode: "signed_cookie", amount_buckets: [500, 1000], keyword_default: "Quick Cash", updated_at: "2026-10-24T01:02:03.000Z",
});
const beta = brand({
  brand_id: "brand-beta", hostnames: ["beta.example.test"], status: "paused", aid: "222", prepop_base: "https://lg.example.test/beta", drain_key: "dk_beta",
  ab_config: null, flow_gate_mode: "param", amount_buckets: [1500], keyword_default: null,
});
const ghost = { brand_id: "brand-ghost", hostname: "ghost.example.test", brand: null, error: "unavailable" as const };

let requests: string[];
let reply: () => Response;

beforeEach(() => {
  requests = [];
  window.history.replaceState(null, "", "/settings");
  reply = () => json({ rows: [ok(alpha), ok(beta), ghost], generated_at: "2026-10-25T00:00:00.000Z" });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    requests.push(input);
    if (input === "/api/settings/brands") return reply();
    throw new Error(`Unexpected test HTTP request: ${input}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const table = () => screen.getByRole("table", { name: "ตั้งค่าแบรนด์ (Brand settings)" });
const rowOf = async (domain: string) => {
  await screen.findByRole("table", { name: "ตั้งค่าแบรนด์ (Brand settings)" });
  return within(within(table()).getByText(domain).closest("tr")!);
};

describe("Settings table", () => {
  it("renders one row per brand with domain, AID, A/B summary, flow gate label, buckets, keyword, prepop base and drain key", async () => {
    render(<SettingsScreen />);
    const a = await rowOf("alpha.example.test");
    const cells = a.getAllByRole("cell").map((c) => c.textContent);
    expect(cells[0]).toContain("alpha.example.test");
    expect(cells[1]).toContain("live");
    expect(cells.slice(2, 9)).toEqual([
      "111",
      "exp-alpha: Lite (lite_v1) 60% / 14 ขั้น (aurum-14-step) 40%",
      "Single Page Cookie",
      "500, 1000",
      "Quick Cash",
      "https://lg.example.test/alpha",
      "dk_alpha",
    ]);
    const updated = a.getAllByRole("cell")[9]!.querySelector("time");
    expect(updated?.getAttribute("datetime")).toBe("2026-10-24T01:02:03.000Z");
    expect(updated?.textContent).not.toBe("");
    expect(a.getByText("111").className).toContain("mono");
    expect(a.getByText("dk_alpha").className).toContain("mono");
    expect(a.getByText(/14 ขั้น \(aurum-14-step\) 40%/)).toBeTruthy();
    expect(a.getByText("Single Page Cookie")).toBeTruthy();

    const b = await rowOf("beta.example.test");
    expect(b.getByText("ปิด (Off)")).toBeTruthy();
    expect(b.getByText("Keyword Param")).toBeTruthy();
    expect(b.getAllByRole("cell")[6]!.textContent).toBe("—");
    expect(within(table()).getAllByRole("row")).toHaveLength(4);
  });

  it("an error row shows the domain and \"โหลดไม่สำเร็จ (Could not load)\" and has no Edit button", async () => {
    render(<SettingsScreen />);
    const g = await rowOf("ghost.example.test");
    expect(g.getByText("โหลดไม่สำเร็จ (Could not load)").className).toContain("p-bad");
    expect(g.queryByRole("button")).toBeNull();
    const cells = g.getAllByRole("cell").map((c) => c.textContent);
    expect(cells.slice(2, 10)).toEqual(Array(8).fill("—"));

    const a = await rowOf("alpha.example.test");
    expect(a.getByRole("button", { name: /แก้ไข \(Edit\)/ })).toBeTruthy();
    expect((await rowOf("beta.example.test")).getByRole("button", { name: /แก้ไข \(Edit\)/ })).toBeTruthy();
  });

  it("Edit opens the drawer with the row's values and Close closes it", async () => {
    render(<SettingsScreen />);
    const a = await rowOf("alpha.example.test");
    fireEvent.click(a.getByRole("button", { name: /แก้ไข \(Edit\)/ }));
    const drawer = screen.getByRole("complementary", { name: "แก้ไขตั้งค่า alpha.example.test (Edit settings)" });
    expect((within(drawer).getByLabelText("AID (LeadsGate aid)") as HTMLInputElement).value).toBe("111");
    expect((within(drawer).getByLabelText("รหัส Experiment (Experiment id)") as HTMLInputElement).value).toBe("exp-alpha");
    fireEvent.click(within(drawer).getByRole("button", { name: "ปิด (Close)" }));
    expect(screen.queryByRole("complementary", { name: /Edit settings/ })).toBeNull();
    fireEvent.click((await rowOf("beta.example.test")).getByRole("button", { name: /แก้ไข \(Edit\)/ }));
    expect((screen.getByLabelText("AID (LeadsGate aid)") as HTMLInputElement).value).toBe("222");
    expect(screen.queryByLabelText("รหัส Experiment (Experiment id)")).toBeNull();
  });

  it("a failed load shows the error card and Retry reloads", async () => {
    reply = () => json({ error: "bad_gateway" }, 502);
    render(<SettingsScreen />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("ลองอีกครั้ง (Retry)");
    // .note from styles.css wins the cascade over a class rule, so red comes from the inline style.
    expect(alert.getAttribute("style")).toContain("background: var(--badbg)");
    expect(alert.getAttribute("style")).toContain("color: var(--bad)");
    expect(screen.queryByRole("table")).toBeNull();
    reply = () => json({ rows: [ok(beta)], generated_at: "2026-10-25T00:00:00.000Z" });
    fireEvent.click(within(alert).getByRole("button", { name: "ลองอีกครั้ง (Retry)" }));
    await waitFor(() => expect(screen.getByText("beta.example.test")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(requests).toEqual(["/api/settings/brands", "/api/settings/brands"]);
  });

});

describe("Settings in the app", () => {
  beforeEach(() => {
    vi.spyOn(api, "alerts").mockRejectedValue(new Error("alerts are not under test"));
  });

  it("the sidebar shows Settings to an owner and not to an employee", async () => {
    vi.spyOn(api, "me").mockResolvedValue(owner);
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "เมนูหลัก" });
    expect(within(nav).getByRole("link", { name: "ตั้งค่า (Settings)" }).getAttribute("href")).toBe("/settings");
    cleanup();

    vi.restoreAllMocks();
    vi.spyOn(api, "alerts").mockRejectedValue(new Error("alerts are not under test"));
    vi.spyOn(api, "me").mockResolvedValue(employee);
    window.history.replaceState(null, "", "/settings");
    render(<App />);
    const employeeNav = await screen.findByRole("navigation", { name: "เมนูหลัก" });
    expect(within(employeeNav).queryByRole("link", { name: "ตั้งค่า (Settings)" })).toBeNull();
  });

  it("an owner opening /settings sees the table", async () => {
    vi.spyOn(api, "me").mockResolvedValue(owner);
    render(<App />);
    expect(await screen.findByRole("table", { name: "ตั้งค่าแบรนด์ (Brand settings)" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "เมนูหลัก" });
    expect(within(nav).getByRole("link", { name: "ตั้งค่า (Settings)" }).getAttribute("aria-current")).toBe("page");
  });

  it("an employee opening /settings sees the Owner-only card and no request goes to /api/settings/brands", async () => {
    vi.spyOn(api, "me").mockResolvedValue(employee);
    render(<App />);
    expect(await screen.findByText("สำหรับ Owner เท่านั้น (Owner only)")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(requests).not.toContain("/api/settings/brands");
  });
});
