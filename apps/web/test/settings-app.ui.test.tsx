import { BrandConfig } from "@anjuna/contracts";
import brandFixture from "@anjuna/contracts/fixtures/admin/brand.get.response.json";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import { api } from "../src/client/api";
import { setLeaveGuard } from "../src/client/router";
import { answerConfirm } from "./confirm";

// The unsaved-change guard is proven here through the real App: sidebar link, browser Back and the Settings screen together.
vi.mock("../src/client/screens/BrandLifecycle", () => ({ BrandLifecycle: () => <h1>Brands screen</h1> }));

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const DISCARD_TITLE = "ทิ้งการแก้ไขที่ยังไม่บันทึก? (Discard unsaved changes?)";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const alpha = BrandConfig.parse({
  ...brandFixture.brand, brand_id: "brand-alpha", hostnames: ["alpha.example.test"], status: "live", aid: "111",
  prepop_base: "https://lg.example.test/alpha", drain_key: "dk_alpha", ab_config: null, flow_gate_mode: "param",
  amount_buckets: [500, 1000], keyword_default: "Quick Cash", updated_at: "2026-10-24T01:02:03.000Z",
});

beforeEach(() => {
  // /brands is the entry behind /settings, so Back has somewhere to go.
  window.history.replaceState(null, "", "/brands");
  window.history.pushState(null, "", "/settings");
  vi.spyOn(api, "me").mockResolvedValue(owner);
  vi.spyOn(api, "alerts").mockRejectedValue(new Error("alerts are not under test"));
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (input === "/api/settings/microsoft-ads") return json({ microsoft_ads_account: null, updated_at: null });
    if (input === "/api/settings/brands") {
      return json({ rows: [{ brand_id: alpha.brand_id, hostname: "alpha.example.test", brand: alpha, error: null }], generated_at: "2026-10-25T00:00:00.000Z" });
    }
    throw new Error(`Unexpected test HTTP request: ${input}`);
  }));
});

afterEach(() => {
  cleanup();
  setLeaveGuard(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const drainKey = () => screen.getByLabelText("ชื่อเส้นทางส่งยอดขาย") as HTMLInputElement;

async function openDirtyDraft() {
  render(<App />);
  const table = await screen.findByRole("table", { name: "ตั้งค่าแบรนด์ (Brand settings)" });
  fireEvent.click(within(table).getByRole("button", { name: /แก้ไข \(Edit\)/ }));
  fireEvent.change(drainKey(), { target: { value: "dk_new" } });
}

/** The question is on screen exactly once; the heading proves it is the discard question. */
async function expectOneDiscardQuestion() {
  const dialogs = await screen.findAllByRole("alertdialog");
  expect(dialogs).toHaveLength(1);
  expect(within(dialogs[0]!).getByRole("heading").textContent).toBe(DISCARD_TITLE);
}

async function expectNoFurtherQuestion() {
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await flush();
  expect(screen.queryByRole("alertdialog")).toBeNull();
}

async function back() {
  await act(async () => {
    window.history.back();
    await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
  });
}

describe("Settings unsaved-change guard inside the app", () => {
  it("the sidebar link asks once; Cancel keeps /settings and the draft", async () => {
    await openDirtyDraft();
    const nav = screen.getByRole("navigation", { name: "เมนูหลัก" });
    fireEvent.click(within(nav).getByRole("link", { name: "แบรนด์" }));
    await expectOneDiscardQuestion();
    await answerConfirm(false);
    await expectNoFurtherQuestion();
    expect(window.location.pathname).toBe("/settings");
    expect(screen.getByRole("complementary", { name: "แก้ไขตั้งค่า alpha.example.test (Edit settings)" })).toBeTruthy();
    expect(drainKey().value).toBe("dk_new");
    expect(screen.queryByText("Brands screen")).toBeNull();
  });

  it("the sidebar link asks once; Discard leaves for /brands", async () => {
    await openDirtyDraft();
    const nav = screen.getByRole("navigation", { name: "เมนูหลัก" });
    fireEvent.click(within(nav).getByRole("link", { name: "แบรนด์" }));
    await expectOneDiscardQuestion();
    await answerConfirm(true);
    expect(await screen.findByRole("heading", { name: "Brands screen" })).toBeTruthy();
    expect(window.location.pathname).toBe("/brands");
    await expectNoFurtherQuestion();
  });

  it("Back asks once; Cancel stays on /settings with the draft; Discard leaves", async () => {
    await openDirtyDraft();
    await back();
    await expectOneDiscardQuestion();
    expect(window.location.pathname).toBe("/settings");
    await answerConfirm(false);
    await expectNoFurtherQuestion();
    expect(window.location.pathname).toBe("/settings");
    expect(drainKey().value).toBe("dk_new");

    await back();
    await expectOneDiscardQuestion();
    await answerConfirm(true);
    expect(await screen.findByRole("heading", { name: "Brands screen" })).toBeTruthy();
    expect(window.location.pathname).toBe("/brands");
    await expectNoFurtherQuestion();
  });
});
