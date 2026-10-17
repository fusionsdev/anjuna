import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import brandFixture from "@anjuna/contracts/fixtures/admin/brand.get.response.json";
import { ConfigPanel } from "../src/client/screens/ConfigPanel";

const employee = { id: "employee", email: "emp1@example.test", role: "employee" as const };
const DEFAULTS = { brand_name: "Copperline", title: "Copperline | Funding Options", description: "Check your funding options." };
const brand = { ...brandFixture.brand, brand_name: null, site_title: "Edited Title", site_description: null };
let patches: unknown[];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  patches = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && input === "/api/brands/brand-a") return json({ brand });
    if (method === "GET" && input === "/api/brands/brand-a/site-text") return json({ brand_id: "brand-a", defaults: DEFAULTS });
    if (method === "PATCH" && input === "/api/brands/brand-a") {
      patches.push(JSON.parse(String(init!.body)));
      return json({ brand, changed: ["site_title"], audit_id: 1 });
    }
    throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: "บันทึกข้อความหน้าเว็บ (Save site text)" }) as HTMLButtonElement;

describe("Site text card", () => {
  it("prefills from the template, marks edited fields and counts characters", async () => {
    render(<ConfigPanel me={employee} brandId="brand-a" onClose={() => {}} onChanged={() => {}} />);
    await waitFor(() => expect(field("ชื่อแบรนด์ (Brand name)").value).toBe("Copperline"));
    expect(field("ชื่อหน้า (Page title)").value).toBe("Edited Title");
    expect(screen.getAllByText("จากเทมเพลต (From template)")).toHaveLength(2);
    expect(screen.getAllByText("แก้ไขแล้ว (Edited)")).toHaveLength(1);
    expect(screen.getByText("12/70")).toBeTruthy();
    expect(screen.getByLabelText("แท็บเบราว์เซอร์ (Browser tab)").textContent).toBe("Edited Title");
  });

  it("resets a field to the template and saves null for it", async () => {
    render(<ConfigPanel me={employee} brandId="brand-a" onClose={() => {}} onChanged={() => {}} />);
    await waitFor(() => expect(field("ชื่อหน้า (Page title)").value).toBe("Edited Title"));
    fireEvent.click(screen.getByRole("button", { name: "รีเซ็ต ชื่อหน้า (Page title) (Reset to template)" }));
    expect(field("ชื่อหน้า (Page title)").value).toBe(DEFAULTS.title);
    fireEvent.click(saveButton());
    await waitFor(() => expect(patches).toEqual([{ site_title: null, expected_updated_at: brand.updated_at }]));
  });

  it("blocks saving text with markup characters and shows the reason", async () => {
    render(<ConfigPanel me={employee} brandId="brand-a" onClose={() => {}} onChanged={() => {}} />);
    await waitFor(() => expect(field("คำอธิบาย (Meta description)").value).toBe(DEFAULTS.description));
    fireEvent.change(field("คำอธิบาย (Meta description)"), { target: { value: "Funding <today>" } });
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/Use plain text without/)).toBeTruthy();
  });

  it("blocks saving banned wording", async () => {
    render(<ConfigPanel me={employee} brandId="brand-a" onClose={() => {}} onChanged={() => {}} />);
    await waitFor(() => expect(field("คำอธิบาย (Meta description)").value).toBe(DEFAULTS.description));
    fireEvent.change(field("คำอธิบาย (Meta description)"), { target: { value: "Personal loans today" } });
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/personal loan/)).toBeTruthy();
  });

  it("renders entity-like text as text, not HTML", async () => {
    render(<ConfigPanel me={employee} brandId="brand-a" onClose={() => {}} onChanged={() => {}} />);
    await waitFor(() => expect(field("ชื่อหน้า (Page title)").value).toBe("Edited Title"));
    fireEvent.change(field("ชื่อแบรนด์ (Brand name)"), { target: { value: "A&amp;B" } });
    expect(screen.getByLabelText("ตัวอย่าง (Preview)").textContent).toContain("A&amp;B");
  });
});
