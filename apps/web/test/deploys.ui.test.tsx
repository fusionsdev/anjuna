import { LifecycleBrandSummary, type DeployEvent, type InstallWithReceipts } from "@anjuna/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
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

// Newest first, the order the feed answers with: brand-a install, brand-a audit, brand-b failed redeploy, a brand the factory
// does not know, then the two work-in-progress states (running and queued) that must both read blue.
const FEED: DeployEvent[] = [
  install(),
  audit(),
  install({
    event_id: "inst-2", brand_id: "brand-b", operation: "redeploy", status: "failed", started_by: "employee-1", started_role: "employee",
    from_revision_id: "brand-b_rev_1", to_revision_id: "brand-b_rev_2", started_at: "2026-10-21T01:00:00.000Z", finished_at: "2026-10-21T01:02:00.000Z", error: "smoke check failed",
  }),
  install({ event_id: "inst-3", brand_id: "brand-ghost", started_at: "2026-10-20T10:00:00.000Z", finished_at: "2026-10-20T10:00:30.000Z" }),
  install({ event_id: "inst-4", brand_id: "brand-a", status: "running", to_revision_id: "brand-a_rev_2", started_at: "2026-10-19T09:00:00.000Z", finished_at: null }),
  install({ event_id: "inst-5", brand_id: "brand-a", operation: "rollback", status: "queued", from_revision_id: "brand-a_rev_2", to_revision_id: "brand-a_rev_1", started_at: "2026-10-19T08:00:00.000Z", finished_at: null }),
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
// A failed install: `InstallProgress` renders Retry whenever `canRetry` is true, so this row proves the screen passes false.
const FAILED_DETAIL: InstallWithReceipts = {
  install_id: "inst-2", brand_id: "brand-b", revision_id: "brand-b_rev_2", operation: "redeploy", status: "failed",
  runtime_sync_status: "ready", receipts: [{ step: "smoke", status: "failed", error: "Smoke: apex missing expected landing content" }],
};

let requests: string[];
let feed: (params: URLSearchParams) => Response;
let lifecycle: () => Response;
let installReplies: Record<string, () => Response>;
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
  lifecycle = () => json({ brands: LIFECYCLE });
  installReplies = { "/api/installs/inst-1": () => json(INSTALL_DETAIL) };
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    requests.push(input);
    if (input === "/api/lifecycle/brands") return lifecycle();
    if (input === "/api/brands") return json({ brands: [], generated_at: "2026-10-21T00:00:00.000Z" });
    if (input.startsWith("/api/deploys")) return feed(paramsOf(input));
    if (input in installReplies) return installReplies[input]!();
    throw new Error(`Unexpected test HTTP request: ${input}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
    expect(rows()).toHaveLength(6);
    expect(within(table()).getAllByRole("columnheader").map((h) => h.textContent))
      .toEqual(["เวลา", "แบรนด์", "การทำงาน", "สถานะ", "ผู้เริ่ม", "ใช้เวลา", "revision"]);
    const [first, second, third] = rows() as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(first).getByText("a.test")).toBeTruthy();
    expect(within(first).getByText("ติดตั้ง (Install)")).toBeTruthy();
    // A ready install colours like a live brand; a muted badge means `ready` lost its tone.
    expect(within(first).getByText("พร้อมใช้งาน (ready)").className).toContain("p-live");
    expect(within(first).getByText("owner-1")).toBeTruthy();
    expect(within(first).getByText("Owner")).toBeTruthy();
    expect(within(first).getByText("4 นาที (4m)")).toBeTruthy();
    // The revision cell wraps; the full id stays available in a title.
    const revision = within(first).getAllByRole("cell")[6]!;
    expect(revision.textContent).toBe("— → brand-a_rev_1");
    expect(revision.querySelector(".deploy-revision")).toBeTruthy();
    expect(revision.querySelector('[title="brand-a_rev_1"]')).toBeTruthy();
    expect(within(second).getByText("brand.profile.update")).toBeTruthy();
    // The audit row reads its Thai label, not the raw `done` from the contract.
    expect(within(second).getByText("เสร็จแล้ว (done)")).toBeTruthy();
    // The audit row is unfinished, so its duration cell is the em dash.
    expect(within(second).getAllByRole("cell")[5]!.textContent).toBe("—");
    expect(within(third).getByText("ติดตั้งใหม่ (Redeploy)")).toBeTruthy();
    expect(within(third).getByText("ล้มเหลว (failed)")).toBeTruthy();
    expect(within(third).getByText("พนักงาน")).toBeTruthy();
    expect(within(third).getByText("2 นาที (2m)")).toBeTruthy();
    // Work in progress reads blue on both states, never the muted fallback.
    expect(within(rows()[4]!).getByText("กำลังทำงาน (running)").className).toContain("p-blue");
    expect(within(rows()[5]!).getByText("รอคิว (queued)").className).toContain("p-blue");
    // The expand control is the shell's button, not a bespoke small control.
    expect(toggleOf(first).className).toContain("btn");
    // `has_more` is false here, so the truncation hint must be absent.
    expect(screen.queryByText(/รายการล่าสุด/)).toBeNull();
    expect(screen.getByRole("link", { name: /ดูประวัติการแก้ไขทั้งหมด/ }).getAttribute("href")).toBe("/audit");
  });

  it("falls back to the brand id for a brand the lifecycle list does not know", async () => {
    render(<DeploysScreen me={owner} />);
    await screen.findByRole("table", { name: "ประวัติการติดตั้ง" });
    const ghost = within(table()).getByText("brand-ghost");
    expect(ghost.closest(".brand-label")).toBeTruthy();
    const select = screen.getByLabelText(/แบรนด์ \(Brand\)/) as unknown as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(["", "brand-a", "brand-b"]);
    // Options name the brand the way the แบรนด์ column does: the hostname, never the display name or the id.
    expect([...select.options].map((option) => option.textContent)).toEqual(["ทั้งหมด (All)", "a.test", "b.test"]);
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

  it("shows a filtered-empty state that clears all three filters", async () => {
    render(<DeploysScreen me={owner} />);
    await screen.findByRole("table", { name: "ประวัติการติดตั้ง" });
    const brandSelect = screen.getByLabelText(/แบรนด์ \(Brand\)/) as unknown as HTMLSelectElement;
    const sourceSelect = screen.getByLabelText(/แหล่งที่มา \(Source\)/) as unknown as HTMLSelectElement;
    const statusSelect = screen.getByLabelText(/สถานะ \(Status\)/) as unknown as HTMLSelectElement;

    fireEvent.change(brandSelect, { target: { value: "brand-b" } });
    await waitFor(() => expect(deploysPaths().at(-1)).toBe("/api/deploys?brand=brand-b"));
    fireEvent.change(sourceSelect, { target: { value: "install" } });
    await waitFor(() => expect(deploysPaths().at(-1)).toBe("/api/deploys?brand=brand-b&source=install"));
    fireEvent.change(statusSelect, { target: { value: "ready" } });
    await waitFor(() => expect(deploysPaths().at(-1)).toBe("/api/deploys?brand=brand-b&source=install&status=ready"));

    // A filtered-out list is not the same as a timeline that never had anything.
    expect(await screen.findByText("ไม่พบรายการที่ตรงกับตัวกรอง (No deploys match the filters)")).toBeTruthy();
    expect(screen.queryByText("ยังไม่มีรายการติดตั้ง (No deploys yet)")).toBeNull();
    expect(rows()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "ล้างตัวกรอง (Clear filters)" }));
    await waitFor(() => expect(deploysPaths().at(-1)).toBe("/api/deploys"));
    expect(brandSelect.value).toBe("");
    expect(sourceSelect.value).toBe("");
    expect(statusSelect.value).toBe("");
    expect(rows()).toHaveLength(6);
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

  it("renders the one expanded detail in a full-width region below the table, labelled with its row", async () => {
    render(<DeploysScreen me={owner} />);
    await screen.findByRole("table", { name: "ประวัติการติดตั้ง" });
    const toggle = toggleOf(rows()[0]!);
    fireEvent.click(toggle);
    const region = await screen.findByRole("region", { name: /รายละเอียด \(Details\)/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe(region.id);
    // The region is a sibling after the table, never a cell inside it.
    expect(region.closest("table")).toBeNull();
    expect(table().compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(region.getAttribute("aria-label")).toContain("a.test"));
    expect(region.getAttribute("aria-label")).toContain("ติดตั้ง (Install)");

    // Only one row is expanded at a time: the audit row replaces the install detail.
    fireEvent.click(toggleOf(rows()[1]!));
    const regions = screen.getAllByRole("region", { name: /รายละเอียด \(Details\)/ });
    expect(regions).toHaveLength(1);
    expect(regions[0]!.textContent).toContain("brand.profile.update");
  });

  it("offers no Retry on an expanded failed install row", async () => {
    installReplies["/api/installs/inst-2"] = () => json(FAILED_DETAIL);
    render(<DeploysScreen me={owner} />);
    await screen.findByRole("table", { name: "ประวัติการติดตั้ง" });
    fireEvent.click(toggleOf(rows()[2]!));
    expect(await screen.findByText("ทดสอบหน้าเว็บจริง (Smoke test)")).toBeTruthy();
    expect(detailCalls("inst-2")).toEqual(["/api/installs/inst-2"]);
    // The screen passes `canRetry={false}`; a failed install would show Retry if it ever passed true.
    expect(screen.queryByRole("button", { name: /ลองใหม่ \(Retry\)/ })).toBeNull();
  });

  it("keeps the table and shows the error below it when the install receipts fail", async () => {
    installReplies["/api/installs/inst-2"] = () => json({ error: "internal" }, 500);
    render(<DeploysScreen me={owner} />);
    await screen.findByRole("table", { name: "ประวัติการติดตั้ง" });
    fireEvent.click(toggleOf(rows()[2]!));
    expect(await screen.findByText(/โหลดรายละเอียดการติดตั้งไม่สำเร็จ/)).toBeTruthy();
    // The install row's own `error` still shows next to it.
    expect(screen.getByText("smoke check failed")).toBeTruthy();
    expect(screen.getByRole("table", { name: "ประวัติการติดตั้ง" })).toBeTruthy();
    expect(rows()).toHaveLength(6);
  });

  it("shows an install row's own error and canary flag, and no Error field on an audit row", async () => {
    const canary = install({ event_id: "inst-canary", status: "failed", is_canary: true, error: "row-level install failure", started_at: "2026-10-22T03:00:00.000Z" });
    // The feed never populates `error` on an audit row; the audit detail must render no Error field for it anyway.
    const auditWithError = audit({ event_id: "audit-99", error: "stale audit error", started_at: "2026-10-22T02:00:00.000Z" });
    feed = () => json({ events: [canary, auditWithError], has_more: false, unavailable: [] });
    installReplies["/api/installs/inst-canary"] = () => json({ ...FAILED_DETAIL, install_id: "inst-canary" });
    render(<DeploysScreen me={owner} />);
    await screen.findByRole("table", { name: "ประวัติการติดตั้ง" });

    fireEvent.click(toggleOf(rows()[0]!));
    const installDetail = await screen.findByText("row-level install failure");
    expect(installDetail.textContent).toContain("row-level install failure");
    expect(within(document.querySelector(".deploy-detail") as HTMLElement).getByText(/canary/i)).toBeTruthy();

    fireEvent.click(toggleOf(rows()[1]!));
    const auditDetail = document.querySelector(".deploy-detail") as HTMLElement;
    expect(auditDetail.textContent).toContain("brand.profile.update");
    expect(auditDetail.textContent).not.toContain("stale audit error");
    expect(auditDetail.textContent).not.toContain("ข้อผิดพลาด (Error)");
  });

  it("expands an audit row to its action, actor, audit link and before/after hint without a second request", async () => {
    render(<DeploysScreen me={owner} />);
    await screen.findByRole("table", { name: "ประวัติการติดตั้ง" });
    fireEvent.click(toggleOf(rows()[1]!));
    const [detail] = details();
    expect(detail).toContain("brand.profile.update");
    expect(detail).toContain("owner-1");
    // The full instant replaces the misleading `เดิม` / `ใหม่` revision rows.
    expect(detail).toContain("เวลาเริ่ม (Started at)");
    expect(detail).toContain("2026-10-21T03:00:00.000Z");
    expect(detail).not.toContain("เดิม (Old)");
    expect(detail).not.toContain("ใหม่ (New)");
    // Thai-first copy keeps the English gloss of the sentence around the link.
    expect(detail).toContain("ไม่ส่งค่าก่อน/หลัง");
    expect(detail).toContain("This feed carries no before/after values");
    const detailNode = document.querySelector(".deploy-detail") as HTMLElement;
    expect(within(detailNode).getByRole("link", { name: /ประวัติการแก้ไข/ }).getAttribute("href")).toBe("/audit");
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
    expect(note.textContent).toContain("core audit source is unavailable");
    expect(within(table()).getAllByRole("row").slice(1)).toHaveLength(6);
  });

  it("keeps the brand-load failure hint out of the select's accessible name", async () => {
    lifecycle = () => json({ error: "internal" }, 500);
    render(<DeploysScreen me={owner} />);
    const hint = await screen.findByText(/โหลดรายการแบรนด์ไม่สำเร็จ/);
    // The note is described, not named: the select's accessible name stays the label alone.
    const select = screen.getByRole("combobox", { name: "แบรนด์ (Brand)" }) as unknown as HTMLSelectElement;
    expect(select.getAttribute("aria-describedby")).toBe(hint.id);
    expect(hint.id).toBeTruthy();
    expect(screen.getByLabelText(/แบรนด์ \(Brand\)/)).toBe(select);
  });

  it("shows a hint next to the brand filter when the lifecycle list fails", async () => {
    lifecycle = () => json({ error: "internal" }, 500);
    render(<DeploysScreen me={owner} />);
    expect(await screen.findByText(/โหลดรายการแบรนด์ไม่สำเร็จ/)).toBeTruthy();
    expect(screen.getByRole("table", { name: "ประวัติการติดตั้ง" })).toBeTruthy();
    expect(rows()).toHaveLength(6);
  });
});
