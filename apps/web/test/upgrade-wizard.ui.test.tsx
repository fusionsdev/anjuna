import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsScreen } from "../src/client/screens/Settings";
import { UpgradeWizard } from "../src/client/screens/UpgradeWizard";
import { answerConfirm } from "./confirm";

const owner = { id: "o", email: "o@example.test", role: "owner" as const };
const employee = { id: "e", email: "e@example.test", role: "employee" as const };
const version = (id: string, name: string, v: number, archived = false) => ({
  template_version_id: id, template_id: `t-${name}`, name, version: v, status: "approved", submitted_by_label: null,
  created_at: "2026-10-01T00:00:00Z", sealed_at: "2026-10-01T00:00:00Z", thumbnail_url: null, brands_using: 0, archived, category_id: null,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let calls: { method: string; path: string; body: unknown }[] = [];
let latestFails = 0;
const latestGets = () => calls.filter((c) => c.method === "GET" && c.path === "/api/upgrade-all/latest").length;

beforeEach(() => {
  calls = [];
  latestFails = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, path: input, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (input === "/api/templates?include_archived=1") return json({ templates: [version("tv-1", "old", 1, true), version("tv-2", "new", 2)], categories: [] });
    if (input === "/api/templates") return json({ templates: [version("tv-2", "new", 2)], categories: [] });
    if (input === "/api/settings/brands") return json({ rows: [], generated_at: "2026-10-01T00:00:00Z" });
    if (input === "/api/upgrade-all/latest") return latestFails-- > 0 ? json({ error: "boom" }, 500) : json({ upgrade: null });
    if (input === "/api/upgrade-all" && method === "POST") return json({ instance_id: "u1" }, 201);
    throw new Error(`Unexpected test HTTP request: ${input}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("UpgradeWizard", () => {
  it("sends the same body as the old card for the chosen versions", async () => {
    render(<UpgradeWizard me={owner} />);
    await screen.findByRole("option", { name: /old v1/ });
    fireEvent.change(screen.getByLabelText("เวอร์ชันเดิม"), { target: { value: "tv-1" } });
    fireEvent.change(screen.getByLabelText("เวอร์ชันใหม่"), { target: { value: "tv-2" } });
    fireEvent.change(screen.getByLabelText("รหัสอาร์ติแฟกต์ฟอร์ม"), { target: { value: "fa-1" } });
    fireEvent.change(screen.getByLabelText("รหัสแบรนด์ทดลอง"), { target: { value: "brand-c" } });
    await screen.findByText(/ยังไม่มีการอัปเกรดทุกแบรนด์ที่รับคำสั่ง/);
    const before = latestGets();
    fireEvent.click(screen.getByRole("button", { name: "เริ่มอัปเกรดทุกแบรนด์" }));
    const dialog = await answerConfirm(true);
    expect(dialog.textContent).toContain("tv-1");
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      from_template_version_id: "tv-1", to_template_version_id: "tv-2", form_artifact_id: "fa-1", canary_brand_id: "brand-c",
    });
    await waitFor(() => expect(latestGets()).toBeGreaterThan(before));
  });

  it("offers an archived sealed version as from but not as to", async () => {
    render(<UpgradeWizard me={owner} />);
    await screen.findByRole("option", { name: /old v1/ });
    expect(screen.getByLabelText("เวอร์ชันใหม่").textContent).not.toContain("old v1");
  });

  it("sends nothing when the dialog is cancelled", async () => {
    render(<UpgradeWizard me={owner} />);
    await screen.findAllByRole("option", { name: /new v2/ });
    fireEvent.change(screen.getByLabelText("เวอร์ชันใหม่"), { target: { value: "tv-2" } });
    fireEvent.click(screen.getByRole("button", { name: "เริ่มอัปเกรดทุกแบรนด์" }));
    const dialog = await answerConfirm(false);
    expect(dialog.textContent).toContain("tv-2");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("renders nothing for an employee and makes no request", () => {
    const { container } = render(<UpgradeWizard me={employee} />);
    expect(container.textContent).toBe("");
    expect(calls).toHaveLength(0);
  });

  it("shows upgrade outcomes under the wizard", async () => {
    render(<UpgradeWizard me={owner} />);
    await screen.findByText(/ยังไม่มีการอัปเกรดทุกแบรนด์ที่รับคำสั่ง/);
  });

  it("recovers failed outcomes with the refresh button and no new upgrade", async () => {
    latestFails = 1;
    render(<UpgradeWizard me={owner} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "รีเฟรช" }));
    await screen.findByText(/ยังไม่มีการอัปเกรดทุกแบรนด์ที่รับคำสั่ง/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("shows the wizard on Settings for the owner only", async () => {
    const view = render(<SettingsScreen me={owner} />);
    await screen.findByLabelText("เวอร์ชันเดิม");
    view.unmount();
    render(<SettingsScreen me={employee} />);
    await screen.findByText(/ยังไม่มีแบรนด์/);
    expect(screen.queryByLabelText("เวอร์ชันเดิม")).toBeNull();
  });
});
