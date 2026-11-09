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
let capError: { message: string } | null;
let brandsOverride: Array<Record<string, unknown>> | null;
let requests: Array<{ method: string; path: string; body: unknown }>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  campaigns = [campaign({}), running];
  enabledTotal = 1000;
  brandsOverride = null;
  capError = null;
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, path: input, body });
    if (method === "GET" && input === "/api/ads/campaigns") {
      // Default: every brand is a baht account; committed is the sum of its spending campaigns.
      const ids = [...new Set(campaigns.map((c) => c.brand_id as string))];
      const brands = brandsOverride ?? ids.map((id) => ({
        brand_id: id, currency: "THB", thb_per_unit: 1,
        committed_thb_day: campaigns.filter((c) => c.brand_id === id && c.state === "enabled").reduce((n, c) => n + (c.daily_budget_thb as number), 0),
      }));
      return json({ campaigns, brands, caps: { total_thb_day: 3000, brand_thb_day: 3000 }, enabled_total_thb_day: enabledTotal });
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
    if (method === "POST" && capError) return json({ error: "invalid", request_id: "r1", issues: [{ path: "daily_budget", message: capError.message }] }, 422);
    if (method === "POST" && input === "/api/ads/campaigns/draft") {
      const job = {
        id: "66666666-6666-4666-8666-666666666666", kind: "campaign.draft.create", status: "queued", attempts: 0,
        payload: { ...(body as object), account: "5381163935", project: null }, result: null, idempotency_key: "campaign:abcdefgh",
        requested_by: "u1", next_attempt_at: null, created_at: AT, updated_at: AT,
      };
      return json({ job, created: true }, 201);
    }
    if (method === "POST" && (input.startsWith("/api/ads/campaigns/") || input.startsWith("/api/v1/ads/campaigns/"))) return json({ job: {}, created: true }, 201);
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
    expect(screen.queryByRole("button", { name: /^หยุด petvet/ })).toBeNull();
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

  const fillDraft = async () => {
    const form = await screen.findByRole("form", { name: "ร่างแคมเปญใหม่" });
    await screen.findByText("petvet-search-1");
    fireEvent.change(within(form).getByLabelText("แบรนด์"), { target: { value: "petvet" } });
    fireEvent.change(within(form).getByLabelText("งบต่อวัน"), { target: { value: "300" } });
    fireEvent.change(within(form).getByLabelText("รหัสประเทศหรือรหัสเมือง"), { target: { value: "US" } });
    fireEvent.change(within(form).getByLabelText("คีย์เวิร์ด หนึ่งบรรทัดต่อคำ"), { target: { value: "pet loans" } });
    return form;
  };
  const brandValue = (form: HTMLElement) => (within(form).getByLabelText("แบรนด์") as unknown as HTMLSelectElement).value;
  const sendBtn = (form: HTMLElement) => within(form).getByRole("button", { name: "ส่งร่างไป AdKit" }) as HTMLButtonElement;

  it("a second click after a successful draft creates no second job", async () => {
    render(<CampaignsScreen me={employee} />);
    const form = await fillDraft();
    fireEvent.click(sendBtn(form));
    await waitFor(() => expect(requests.filter((r) => r.method === "POST")).toHaveLength(1));
    await waitFor(() => expect(brandValue(form)).toBe(""));
    expect(sendBtn(form).disabled).toBe(true);
    fireEvent.click(sendBtn(form));
    fireEvent.submit(form);
    await new Promise((r) => setTimeout(r, 50));
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("two clicks while the draft POST is pending send exactly one POST", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (init?.method === "POST") { requests.push({ method: "POST", path: String(input), body: null }); await gate; }
      return original(input, init);
    });
    render(<CampaignsScreen me={employee} />);
    const form = await fillDraft();
    fireEvent.click(sendBtn(form));
    await waitFor(() => expect(requests.filter((r) => r.method === "POST")).toHaveLength(1));
    fireEvent.click(sendBtn(form));
    fireEvent.submit(form);
    await new Promise((r) => setTimeout(r, 50));
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
    release();
    await waitFor(() => expect(brandValue(form)).toBe(""));
  });

  it("a null rate or committed figure shows the Thai reason", async () => {
    brandsOverride = [{ brand_id: "petvet", currency: "USD", thb_per_unit: null, committed_thb_day: null }];
    render(<CampaignsScreen me={employee} />);
    const form = await fillDraft();
    expect(form.textContent).toContain("ยังคำนวณเพดานเป็นบาทไม่ได้ ระบบจะตรวจตอนส่ง");
  });

  it("a failed draft keeps the form so the user can fix it", async () => {
    render(<CampaignsScreen me={employee} />);
    const form = await fillDraft();
    capError = { message: "brand_cap: x" };
    fireEvent.click(sendBtn(form));
    await screen.findByRole("alert");
    expect(brandValue(form)).toBe("petvet");
  });

  it("a brand_cap refusal from core reads in Thai", async () => {
    capError = { message: "brand_cap: 4000 THB/day is above ads_cap_brand_thb_day 3000 THB/day with the campaigns already enabled" };
    render(<CampaignsScreen me={employee} />);
    fireEvent.click(sendBtn(await fillDraft()));
    expect((await screen.findByRole("alert")).textContent).toBe("งบเกินเพดานต่อแบรนด์ ระบบไม่สร้างงาน");
  });

  it("a total_cap refusal from core reads in Thai", async () => {
    capError = { message: "total_cap: 4000 THB/day is above ads_cap_total_thb_day 3000 THB/day with the campaigns already enabled" };
    render(<CampaignsScreen me={employee} />);
    fireEvent.click(sendBtn(await fillDraft()));
    expect((await screen.findByRole("alert")).textContent).toBe("งบเกินเพดานรวมทุกแบรนด์ ระบบไม่สร้างงาน");
  });

  it("a first draft for a USD brand shows the currency and makes no baht cap claim while the rate is unknown", async () => {
    campaigns = [];
    brandsOverride = [{ brand_id: "bison", currency: "USD", thb_per_unit: null, committed_thb_day: 0 }];
    render(<CampaignsScreen me={employee} />);
    const form = await screen.findByRole("form", { name: "ร่างแคมเปญใหม่" });
    await screen.findByText("ยังไม่มีแคมเปญจากหน้านี้");
    fireEvent.change(within(form).getByLabelText("แบรนด์"), { target: { value: "bison" } });
    fireEvent.change(within(form).getByLabelText("งบต่อวัน"), { target: { value: "9999" } });
    fireEvent.change(within(form).getByLabelText("รหัสประเทศหรือรหัสเมือง"), { target: { value: "US" } });
    fireEvent.change(within(form).getByLabelText("คีย์เวิร์ด หนึ่งบรรทัดต่อคำ"), { target: { value: "cash" } });
    expect(form.textContent).toContain("USD");
    expect(form.textContent).not.toContain("งบต่อวันเกินเพดานที่เหลือ");
    expect(sendBtn(form).disabled).toBe(false);
  });

  it("a USD brand with a known rate checks the cap in baht", async () => {
    campaigns = [];
    enabledTotal = 0;
    brandsOverride = [{ brand_id: "bison", currency: "USD", thb_per_unit: 36, committed_thb_day: 0 }];
    render(<CampaignsScreen me={employee} />);
    const form = await screen.findByRole("form", { name: "ร่างแคมเปญใหม่" });
    await screen.findByText("ยังไม่มีแคมเปญจากหน้านี้");
    fireEvent.change(within(form).getByLabelText("แบรนด์"), { target: { value: "bison" } });
    fireEvent.change(within(form).getByLabelText("งบต่อวัน"), { target: { value: "100" } }); // 3,600 baht
    expect(form.textContent).toContain("งบต่อวันเกินเพดานที่เหลือ");
    fireEvent.change(within(form).getByLabelText("งบต่อวัน"), { target: { value: "80" } }); // 2,880 baht
    expect(form.textContent).not.toContain("งบต่อวันเกินเพดานที่เหลือ");
  });

  it("the brand used figure is the committed budget core returns, so pending budget jobs count", async () => {
    // Enabled at 1,000 baht but core holds a pending 2,500 baht budget job: 2,500 committed, 500 left.
    brandsOverride = [{ brand_id: "petvet", currency: "THB", thb_per_unit: 1, committed_thb_day: 2500 }];
    render(<CampaignsScreen me={employee} />);
    const caps = await screen.findByRole("table", { name: "เพดานงบต่อวัน" });
    const brand = within(caps).getByText("PetVetPay").closest("tr")!;
    expect(brand.textContent).toContain("฿2,500");
    expect(brand.textContent).toContain("฿500");
  });

  it("the owner pauses an enabled campaign after a confirm", async () => {
    render(<CampaignsScreen me={owner} />);
    fireEvent.click(within(await row("petvet-search-2")).getByRole("button", { name: "หยุด petvet-search-2" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "หยุดแคมเปญ" }));
    await waitFor(() => expect(requests.some((r) => r.method === "POST" && r.path === "/api/ads/campaigns/777/pause")).toBe(true));
  });
  it("counts campaigns in the status chips and filters the table by chip", async () => {
    render(<CampaignsScreen me={owner} />);
    await screen.findByText("petvet-search-1");
    const group = screen.getByRole("group", { name: "กรองสถานะแคมเปญ" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["ทั้งหมด2", "ร่าง1", "กำลังสร้าง0", "ทำงาน1", "หยุด0", "ล้มเหลว0"]);
    fireEvent.click(within(group).getByRole("button", { name: /^ทำงาน/ }));
    expect(screen.queryByText("petvet-search-1")).toBeNull();
    expect(screen.getByText("petvet-search-2")).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: /^หยุด/ }));
    expect(await screen.findByText("ไม่มีแคมเปญในสถานะนี้")).toBeTruthy();
  });

  it("opens the detail of a selected row and lets the owner send a new budget as a budget job", async () => {
    render(<CampaignsScreen me={owner} />);
    expect(await screen.findByText("เลือกแคมเปญในตารางเพื่อดูงบ คีย์เวิร์ดและบันทึกงาน")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "petvet-search-2" }));
    const detail = await screen.findByRole("complementary", { name: "รายละเอียดแคมเปญ" });
    expect(within(detail).getByText("PetVetPay")).toBeTruthy();
    expect(within(detail).getByText("บันทึกงาน")).toBeTruthy();
    const input = within(detail).getByLabelText(/^งบต่อวัน/) as HTMLInputElement;
    expect(input.value).toBe("1000");
    const save = within(detail).getByRole("button", { name: "บันทึกงบ" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "800" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(await screen.findByText(/ส่งคำสั่งเปลี่ยนงบแล้ว/)).toBeTruthy();
    expect(requests.find((r) => r.path === "/api/v1/ads/campaigns/777/budget")).toMatchObject({ method: "POST", body: { daily_budget: 800 } });
  });

  it("blocks a budget above the cap left in the detail panel and keeps it read-only for an employee", async () => {
    const view = render(<CampaignsScreen me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: "petvet-search-2" }));
    fireEvent.change(within(await screen.findByRole("complementary", { name: "รายละเอียดแคมเปญ" })).getByLabelText(/^งบต่อวัน/), { target: { value: "3500" } });
    expect(screen.getByRole("note").textContent).toContain("งบต่อวันเกินเพดาน");
    expect((screen.getByRole("button", { name: "บันทึกงบ" }) as HTMLButtonElement).disabled).toBe(true);
    view.unmount();
    render(<CampaignsScreen me={employee} />);
    fireEvent.click(await screen.findByRole("button", { name: "petvet-search-2" }));
    const detail = await screen.findByRole("complementary", { name: "รายละเอียดแคมเปญ" });
    expect(within(detail).queryByRole("button", { name: "บันทึกงบ" })).toBeNull();
    expect(within(detail).getByText("เฉพาะ owner แก้งบได้")).toBeTruthy();
  });
});
