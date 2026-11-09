import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../src/client/api";
import { CampaignsScreen } from "../src/client/screens/Campaigns";

const owner = { role: "owner" } as Me;
const employee = { role: "employee" } as Me;
const AT = "2026-01-02T03:04:05.000Z";

type Campaign = Record<string, unknown>;
const campaign = (over: Campaign): Campaign => ({
  draft_job_id: "22222222-2222-4222-8222-222222222222", campaign_id: "123456", brand_id: "petvet", account: "5381163935",
  name: "petvet-search-1", daily_budget: 500, currency: "THB", daily_budget_thb: 500, state: "draft", updated_at: AT,
  geo: { country: "US" }, final_url: "https://petvetpay.com/",
  ...over,
});
const running = campaign({ draft_job_id: "33333333-3333-4333-8333-333333333333", campaign_id: "777", name: "petvet-search-2", daily_budget: 1000, daily_budget_thb: 1000, state: "enabled" });

let campaigns: Campaign[];
let enabledTotal: number;
let requests: Array<{ method: string; path: string; body: unknown }>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  campaigns = [campaign({}), running];
  enabledTotal = 1000;
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, path: input, body });
    if (method === "GET" && input === "/api/ads/campaigns") {
      return json({ campaigns, caps: { total_thb_day: 3000, brand_thb_day: 3000 }, enabled_total_thb_day: enabledTotal });
    }
    if (method === "GET" && input === "/api/lifecycle/brands") {
      return json({ brands: [
        { brand_id: "petvet", name: "PetVetPay", hostnames: ["petvetpay.com"] },
        { brand_id: "bison", name: "BisonCash", hostnames: ["bisoncash.com"] },
      ] });
    }
    if (method === "GET" && input === "/api/brands") {
      return json({ brands: [{ brand_id: "petvet", hostnames: ["petvetpay.com"] }, { brand_id: "bison", hostnames: ["bisoncash.com"] }], generated_at: AT });
    }
    if (method === "POST" && input.startsWith("/api/ads/campaigns/")) return json({ job: {}, created: true }, 201);
    throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const row = async (name: string) => (await screen.findByText(name)).closest("tr")!;

describe("Campaigns screen", () => {
  it("the enable dialog names brand, domain, budget, geo, account and the cap left, and warns that it spends money", async () => {
    render(<CampaignsScreen me={owner} />);
    fireEvent.click(within(await row("petvet-search-1")).getByRole("button", { name: "ตรวจและเปิดใช้งาน petvet-search-1" }));
    const dialog = await screen.findByRole("alertdialog");
    const text = dialog.textContent!;
    expect(text).toContain("PetVetPay");
    expect(text).toContain("petvetpay.com");
    expect(text).toContain("฿500");
    expect(text).toContain("ประเทศ US");
    expect(text).toContain("538-116-3935");
    // Brand cap 3,000 minus the 1,000 already enabled.
    expect(text).toMatch(/เพดานที่เหลือ\s*฿2,000/);
    expect(text).toContain("ใช้เงินจริง");
    const submit = within(dialog).getByRole("button", { name: "เปิดใช้งานและเริ่มใช้เงิน" });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(requests.some((r) => r.method === "POST" && r.path === "/api/ads/campaigns/123456/enable")).toBe(true));
  });

  it("a budget above the cap left disables the submit with the Thai reason", async () => {
    campaigns = [campaign({ daily_budget: 2500, daily_budget_thb: 2500 }), running];
    render(<CampaignsScreen me={owner} />);
    fireEvent.click(within(await row("petvet-search-1")).getByRole("button", { name: "ตรวจและเปิดใช้งาน petvet-search-1" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("งบต่อวันเกินเพดานที่เหลือ");
    expect((within(dialog).getByRole("button", { name: "เปิดใช้งานและเริ่มใช้เงิน" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the total cap left counts when it is smaller than the brand cap left", async () => {
    // Another brand already holds 2,800 of the 3,000 total: 200 left for everyone.
    campaigns = [campaign({}), campaign({ draft_job_id: "44444444-4444-4444-8444-444444444444", campaign_id: "888", brand_id: "bison", name: "bison-search-1", daily_budget: 2800, daily_budget_thb: 2800, state: "enabled" })];
    enabledTotal = 2800;
    render(<CampaignsScreen me={owner} />);
    fireEvent.click(within(await row("petvet-search-1")).getByRole("button", { name: "ตรวจและเปิดใช้งาน petvet-search-1" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/เพดานที่เหลือ\s*฿200/);
    expect((within(dialog).getByRole("button", { name: "เปิดใช้งานและเริ่มใช้เงิน" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("an employee sees the list and the draft form, and no enable or pause button", async () => {
    render(<CampaignsScreen me={employee} />);
    expect(await screen.findByText("petvet-search-1")).toBeTruthy();
    expect(screen.getByText("petvet-search-2")).toBeTruthy();
    expect(screen.getByRole("form", { name: "ร่างแคมเปญใหม่" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /ตรวจและเปิดใช้งาน/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^หยุด/ })).toBeNull();
  });

  it("shows held and unknown states in Thai and offers no enable for them", async () => {
    campaigns = [
      campaign({ state: "enabling" }),
      campaign({ draft_job_id: "55555555-5555-4555-8555-555555555555", campaign_id: "999", name: "petvet-search-3", state: "unknown" }),
    ];
    render(<CampaignsScreen me={owner} />);
    expect(within(await row("petvet-search-1")).getByText(/รอตรวจเพดาน/)).toBeTruthy();
    expect(within(await row("petvet-search-3")).getByText("ไม่ทราบผล รอตรวจสถานะ")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /ตรวจและเปิดใช้งาน/ })).toBeNull();
    fireEvent.click(within(await row("petvet-search-3")).getByRole("button", { name: "ตรวจสถานะ petvet-search-3" }));
    await waitFor(() => expect(requests.some((r) => r.method === "POST" && r.path === "/api/ads/campaigns/999/status-check")).toBe(true));
  });

  it("shows cap used and cap left per brand and in total", async () => {
    render(<CampaignsScreen me={employee} />);
    const caps = await screen.findByRole("table", { name: "เพดานงบต่อวัน" });
    const total = within(caps).getByText("รวมทุกแบรนด์").closest("tr")!;
    expect(total.textContent).toContain("฿3,000");
    expect(total.textContent).toContain("฿1,000");
    expect(total.textContent).toContain("฿2,000");
    const brand = within(caps).getByText("PetVetPay").closest("tr")!;
    expect(brand.textContent).toContain("฿1,000");
    expect(brand.textContent).toContain("฿2,000");
  });

  it("an employee sends a draft with the next campaign name for the brand", async () => {
    render(<CampaignsScreen me={employee} />);
    const form = await screen.findByRole("form", { name: "ร่างแคมเปญใหม่" });
    await screen.findByText("petvet-search-1");
    fireEvent.change(within(form).getByLabelText("แบรนด์"), { target: { value: "petvet" } });
    expect((within(form).getByLabelText("ชื่อแคมเปญ") as HTMLInputElement).value).toBe("petvet-search-3");
    fireEvent.change(within(form).getByLabelText("งบต่อวัน"), { target: { value: "300" } });
    fireEvent.change(within(form).getByLabelText("รหัสประเทศหรือรหัสเมือง"), { target: { value: "US" } });
    fireEvent.change(within(form).getByLabelText("คีย์เวิร์ด หนึ่งบรรทัดต่อคำ"), { target: { value: "pet loans\n vet bills \n\n" } });
    fireEvent.click(within(form).getByRole("button", { name: "ส่งร่างไป AdKit" }));
    await waitFor(() => expect(requests.find((r) => r.method === "POST")).toEqual({
      method: "POST", path: "/api/ads/campaigns/draft",
      body: {
        brand_id: "petvet", name: "petvet-search-3", daily_budget: 300, bid_strategy: "maximize_conversions",
        geo: { country: "US" }, keywords: ["pet loans", "vet bills"], final_url: "https://petvetpay.com/",
      },
    }));
  });

  it("a draft budget above the brand cap left disables the draft submit with the Thai reason", async () => {
    render(<CampaignsScreen me={employee} />);
    const form = await screen.findByRole("form", { name: "ร่างแคมเปญใหม่" });
    await screen.findByText("petvet-search-1");
    fireEvent.change(within(form).getByLabelText("แบรนด์"), { target: { value: "petvet" } });
    fireEvent.change(within(form).getByLabelText("งบต่อวัน"), { target: { value: "2000.01" } });
    expect(form.textContent).toContain("งบต่อวันเกินเพดานที่เหลือ");
    expect((within(form).getByRole("button", { name: "ส่งร่างไป AdKit" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the owner pauses an enabled campaign after a confirm", async () => {
    render(<CampaignsScreen me={owner} />);
    fireEvent.click(within(await row("petvet-search-2")).getByRole("button", { name: "หยุด petvet-search-2" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "หยุดแคมเปญ" }));
    await waitFor(() => expect(requests.some((r) => r.method === "POST" && r.path === "/api/ads/campaigns/777/pause")).toBe(true));
  });
});
