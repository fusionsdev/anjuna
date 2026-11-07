import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversionSetupState } from "@anjuna/contracts";
import brandFixture from "@anjuna/contracts/fixtures/admin/brand.get.response.json";
import conversionFixture from "@anjuna/contracts/fixtures/admin/conversion-setup.response.json";
import { ConfigPanel } from "../src/client/screens/ConfigPanel";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
let setup: () => Response;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const state = (over: Partial<ConversionSetupState>) => json({ conversion_setup: { ...conversionFixture.conversion_setup, ...over } });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && input === "/api/brands/brand-a") return json({ brand: brandFixture.brand });
    if (method === "GET" && input === "/api/brands/brand-a/site-text") return json({ error: "not_found" }, 404);
    if (method === "GET" && input === "/api/brands/brand-a/conversion-setup") return setup();
    if (method === "PATCH" && input === "/api/brands/brand-a") return json({ brand: brandFixture.brand, changed: true });
    throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const open = () => render(<ConfigPanel me={owner} brandId="brand-a" onClose={() => {}} onChanged={() => {}} />);

describe("Conversion action status in the money section", () => {
  it("money section shows pending, created with name, and failed with error and attempts", async () => {
    setup = () => state({ status: "pending", name: null, conversion_action_id: null, attempts: 0 });
    open();
    expect((await screen.findByText(/รอสร้างอัตโนมัติ \(Pending\)/)).getAttribute("role")).toBe("status");
    cleanup();

    setup = () => state({ status: "created" });
    open();
    const created = await screen.findByText(/สร้างแล้ว \(Created\)/);
    expect(created.getAttribute("role")).toBe("status");
    expect(created.textContent).toContain("cv-0123456789abcdef");
    cleanup();

    setup = () => state({ status: "failed", error: "customer not enabled", name: "cv-0123456789abcdef", conversion_action_id: null, attempts: 3 });
    open();
    const failed = await screen.findByText(/สร้างไม่สำเร็จ \(Failed\)/);
    expect(failed.getAttribute("role")).toBe("status");
    expect(failed.textContent).toContain("customer not enabled");
    expect(failed.textContent).toContain("ครั้งที่ 3/5");
  });

  it("money section shows no status line for none", async () => {
    setup = () => state({ status: "none", name: null, conversion_action_id: null, attempts: 0, updated_at: null });
    open();
    await screen.findByText("เส้นทางเงิน (Money-path, Owner เท่านั้น)");
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => u === "/api/brands/brand-a/conversion-setup")).toBe(true));
    expect(screen.queryByText(/Pending|Created|Failed/)).toBeNull();
  });

  it("a failed status call renders nothing and the money form stays usable", async () => {
    setup = () => json({ error: "boom" }, 500);
    open();
    await screen.findByText("เส้นทางเงิน (Money-path, Owner เท่านั้น)");
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => u === "/api/brands/brand-a/conversion-setup")).toBe(true));
    expect(screen.queryByText(/Pending|Created|Failed/)).toBeNull();
    const money = (await screen.findByText("เส้นทางเงิน (Money-path, Owner เท่านั้น)")).closest("section") as HTMLElement;
    const save = within(money).getByRole("button", { name: "บันทึก (Save)" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    fireEvent.change(within(money).getByLabelText(/รหัส LeadsGate/), { target: { value: "aid-changed" } });
    fireEvent.click(save);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u, init]) => u === "/api/brands/brand-a" && init?.method === "PATCH")).toBe(true));
    const patch = vi.mocked(fetch).mock.calls.find(([u, init]) => u === "/api/brands/brand-a" && init?.method === "PATCH")!;
    expect(JSON.parse(String(patch[1]?.body))).toMatchObject({ aid: "aid-changed" });
  });
});

describe("Pause for an employee", () => {
  it("shows Pause disabled with a Thai reason instead of hiding it", async () => {
    setup = () => state({ status: "none", name: null, conversion_action_id: null, attempts: 0, updated_at: null });
    render(<ConfigPanel me={{ id: "e", email: "e@example.test", role: "employee" as never }} brandId="brand-a" onClose={() => {}} onChanged={() => {}} />);
    const pause = (await screen.findByRole("button", { name: /หยุดชั่วคราว/ })) as HTMLButtonElement;
    expect(pause.disabled).toBe(true);
    expect(pause.title).toBe("เฉพาะเจ้าของหยุดแบรนด์ได้");
  });

  it("keeps Pause enabled for the owner", async () => {
    setup = () => state({ status: "none", name: null, conversion_action_id: null, attempts: 0, updated_at: null });
    open();
    const pause = (await screen.findByRole("button", { name: /หยุดชั่วคราว/ })) as HTMLButtonElement;
    expect(pause.disabled).toBe(false);
  });
});
