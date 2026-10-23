import { LifecycleBrandSummary, type DeployEvent, type InstallWithReceipts } from "@anjuna/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeploysScreen } from "../src/client/screens/Deploys";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const install = (over: Partial<DeployEvent> = {}): DeployEvent => ({
  source: "install", event_id: "inst-1", brand_id: "brand-a", operation: "install", action: null,
  status: "ready", from_revision_id: null, to_revision_id: "brand-a_rev_1", is_canary: false,
  started_by: "owner-1", started_role: "owner", started_at: "2026-10-21T03:00:00.000Z",
  finished_at: "2026-10-21T03:04:00.000Z", error: null, ...over,
});
const audit = (over: Partial<DeployEvent> = {}): DeployEvent => ({
  ...install(), source: "audit", event_id: "audit-12", operation: null, action: "brand.profile.update",
  status: "done", from_revision_id: null, to_revision_id: null, finished_at: null, ...over,
});

// Newest first, the order the feed answers with: brand-a install, brand-a audit, brand-b failed redeploy, a brand the factory does not know.
const FEED: DeployEvent[] = [
  install(),
  audit(),
  install({
    event_id: "inst-2", brand_id: "brand-b", operation: "redeploy", status: "failed", started_by: "employee-1", started_role: "employee",
    from_revision_id: "brand-b_rev_1", to_revision_id: "brand-b_rev_2", started_at: "2026-10-21T01:00:00.000Z", finished_at: "2026-10-21T01:02:00.000Z", error: "smoke check failed",
  }),
  install({ event_id: "inst-3", brand_id: "brand-ghost", started_at: "2026-10-20T10:00:00.000Z", finished_at: "2026-10-20T10:00:30.000Z" }),
];

const brandRow = (id: string, name: string, host: string) => LifecycleBrandSummary.parse({
  brand_id: id, name, account: "test-account", hostnames: [host], status: "live", current_revision_id: "rev-1",
  runtime_sync_status: "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01",
});
// brand-ghost is deliberately absent: core audit can name a brand the factory list does not hold.
const LIFECYCLE = [brandRow("brand-a", "Brand A", "a.test"), brandRow("brand-b", "Brand B", "b.test")];

const INSTALL_DETAIL: InstallWithReceipts = {
  install_id: "inst-1", brand_id: "brand-a", revision_id: "brand-a_rev_1", operation: "install", status: "ready",
  runtime_sync_status: "ready", receipts: [{ step: "smoke", status: "ready" }],
};

let requests: string[];
let feed: (params: URLSearchParams) => Response;
const paramsOf = (path: string) => new URLSearchParams(path.includes("?") ? path.split("?")[1]! : "");

beforeEach(() => {
  requests = [];
  feed = (params) => json({
    events: FEED.filter((e) =>
      (!params.get("brand") || e.brand_id === params.get("brand"))
      && (!params.get("source") || e.source === params.get("source"))
      && (!params.get("status") || e.status === params.get("status"))),
    has_more: false,
    unavailable: [],
  });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    requests.push(input);
    if (input === "/api/lifecycle/brands") return json({ brands: LIFECYCLE });
    if (input === "/api/brands") return json({ brands: [], generated_at: "2026-10-21T00:00:00.000Z" });
    if (input.startsWith("/api/deploys")) return feed(paramsOf(input));
    if (input === "/api/installs/inst-1") return json(INSTALL_DETAIL);
    throw new Error(`Unexpected test HTTP request: ${input}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const table = () => screen.getByRole("table", { name: "ประวัติการติดตั้ง" });
const rows = () => within(table()).getAllByRole("row").slice(1);
const deploysPaths = () => requests.filter((p) => p.startsWith("/api/deploys"));
const detailCalls = (id: string) => requests.filter((p) => p === `/api/installs/${id}`);
const details = () => [...document.querySelectorAll(".deploy-detail")].map((node) => node.textContent ?? "");
const toggleOf = (row: HTMLElement) => within(row).getByRole("button", { name: "รายละเอียด (Details)" });

describe("deploy history screen", () => {
  it("renders the timeline newest first with domain, operation, status, actor and duration", async () => {
    render(<DeploysScreen me={owner} />);
    await screen.findByRole("table", { name: "ประวัติการติดตั้ง" });
    expect(rows()).toHaveLength(4);
    const [first, second, third] = rows() as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(first).getByText("a.test")).toBeTruthy();
    expect(within(first).getByText("ติดตั้ง (Install)")).toBeTruthy();
    expect(within(first).getByText("พร้อมใช้งาน (ready)")).toBeTruthy();
    expect(within(first).getByText("owner-1")).toBeTruthy();
    expect(within(first).getByText("Owner")).toBeTruthy();
    expect(within(first).getByText("4 นาที (4m)")).toBeTruthy();
    expect(within(first).getByText("— → brand-a_rev_1")).toBeTruthy();
    expect(within(second).getByText("brand.profile.update")).toBeTruthy();
    expect(within(third).getByText("ติดตั้งใหม่ (Redeploy)")).toBeTruthy();
    expect(within(third).getByText("ล้มเหลว (failed)")).toBeTruthy();
    expect(within(third).getByText("พนักงาน")).toBeTruthy();
    expect(within(third).getByText("2 นาที (2m)")).toBeTruthy();
    expect(screen.getByRole("link", { name: /ดูประวัติการแก้ไขทั้งหมด/ }).getAttribute("href")).toBe("/audit");
  });

  it("falls back to the brand id for a brand the lifecycle list does not know", async () => {
    render(<DeploysScreen me={owner} />);
    await screen.findByRole("table", { name: "ประวัติการติดตั้ง" });
    const ghost = within(table()).getByText("brand-ghost");
    expect(ghost.closest(".brand-label")).toBeTruthy();
    const select = screen.getByLabelText(/แบรนด์ \(Brand\)/) as unknown as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(["", "brand-a", "brand-b"]);
    expect([...select.options].map((option) => option.textContent)).not.toContain("brand-ghost");
  });

  it("filters by brand, by source and by status", async () => {
    render(<DeploysScreen me={owner} />);
    await screen.findByRole("table", { name: "ประวัติการติดตั้ง" });
    expect(deploysPaths()).toEqual(["/api/deploys"]);
    const brandSelect = screen.getByLabelText(/แบรนด์ \(Brand\)/) as unknown as HTMLSelectElement;
    const sourceSelect = screen.getByLabelText(/แหล่งที่มา \(Source\)/) as unknown as HTMLSelectElement;
    const statusSelect = screen.getByLabelText(/สถานะ \(Status\)/) as unknown as HTMLSelectElement;

    fireEvent.change(brandSelect, { target: { value: "brand-b" } });
    await waitFor(() => expect(deploysPaths().at(-1)).toBe("/api/deploys?brand=brand-b"));
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]!).getByText("b.test")).toBeTruthy();
    fireEvent.change(brandSelect, { target: { value: "" } });
    await waitFor(() => expect(deploysPaths().at(-1)).toBe("/api/deploys"));

    fireEvent.change(sourceSelect, { target: { value: "audit" } });
    await waitFor(() => expect(deploysPaths().at(-1)).toBe("/api/deploys?source=audit"));
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]!).getByText("brand.profile.update")).toBeTruthy();
    fireEvent.change(sourceSelect, { target: { value: "" } });
    await waitFor(() => expect(deploysPaths().at(-1)).toBe("/api/deploys"));

    fireEvent.change(statusSelect, { target: { value: "failed" } });
    await waitFor(() => expect(deploysPaths().at(-1)).toBe("/api/deploys?status=failed"));
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]!).getByText("ล้มเหลว (failed)")).toBeTruthy();
  });

  it("expands an install row to its receipts and caches them across a second expand", async () => {
    render(<DeploysScreen me={owner} />);
    await screen.findByRole("table", { name: "ประวัติการติดตั้ง" });
    fireEvent.click(toggleOf(rows()[0]!));
    expect(await screen.findByText("ทดสอบหน้าเว็บจริง (Smoke test)")).toBeTruthy();
    expect(detailCalls("inst-1")).toEqual(["/api/installs/inst-1"]);
    expect(screen.getByRole("progressbar", { name: /ความคืบหน้าการติดตั้ง/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /ลองใหม่ \(Retry\)/ })).toBeNull();

    fireEvent.click(toggleOf(rows()[0]!));
    expect(screen.queryByText("ทดสอบหน้าเว็บจริง (Smoke test)")).toBeNull();
    fireEvent.click(toggleOf(rows()[0]!));
    expect(await screen.findByText("ทดสอบหน้าเว็บจริง (Smoke test)")).toBeTruthy();
    expect(detailCalls("inst-1")).toHaveLength(1);
  });

  it("expands an audit row to its changed fields without a second request", async () => {
    render(<DeploysScreen me={owner} />);
    await screen.findByRole("table", { name: "ประวัติการติดตั้ง" });
    fireEvent.click(toggleOf(rows()[1]!));
    const [detail] = details();
    expect(detail).toContain("brand.profile.update");
    expect(detail).toContain("เดิม (Old)");
    expect(detail).toContain("ใหม่ (New)");
    expect(detail).toContain("owner-1");
    expect(detail).toContain("before/after");
    expect(requests.filter((p) => p.startsWith("/api/installs/"))).toEqual([]);
  });

  it("shows the truncation hint when has_more is true", async () => {
    feed = () => json({ events: FEED.slice(0, 2), has_more: true, unavailable: [] });
    render(<DeploysScreen me={owner} />);
    expect(await screen.findByText("แสดง 2 รายการล่าสุด")).toBeTruthy();
  });

  it("shows an empty state with no events", async () => {
    feed = () => json({ events: [], has_more: false, unavailable: [] });
    render(<DeploysScreen me={owner} />);
    expect(await screen.findByText("ยังไม่มีรายการติดตั้ง (No deploys yet)")).toBeTruthy();
  });

  it("shows an error and does not crash when the feed fails", async () => {
    feed = () => json({ error: "internal" }, 500);
    render(<DeploysScreen me={owner} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("เกิดข้อผิดพลาด (500)");
    expect(screen.getByRole("heading", { name: "ประวัติการติดตั้ง (Deploy history)" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("names the unavailable core audit source", async () => {
    feed = (params) => json({ events: FEED.filter((e) => !params.get("brand") || e.brand_id === params.get("brand")), has_more: false, unavailable: ["core_audit"] });
    render(<DeploysScreen me={owner} />);
    const note = await screen.findByText(/core_audit/);
    expect(note.textContent).toContain("ไทม์ไลน์ไม่ครบ");
    expect(within(table()).getAllByRole("row").slice(1)).toHaveLength(4);
  });
});
