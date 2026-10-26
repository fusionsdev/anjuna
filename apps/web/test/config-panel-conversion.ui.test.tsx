import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
    expect((screen.getAllByRole("button", { name: "บันทึก (Save)" })[0] as HTMLButtonElement).disabled).toBe(false);
  });
});
