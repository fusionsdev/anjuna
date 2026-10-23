import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrandRevisionsResponse, LifecycleBrandSummary } from "@anjuna/contracts";
import { BrandLifecycle } from "../src/client/screens/BrandLifecycle";
import { answerConfirm } from "./confirm";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const URL_CG = "https://creditsgene.test/?keyword={keyword}";

const lifecycle = (id: string, host: string, extra: Record<string, unknown> = {}) => LifecycleBrandSummary.parse({
  brand_id: id, name: "Credit Genie", account: "test-account", hostnames: [host], status: "live", current_revision_id: `${id}_rev_3`,
  runtime_sync_status: "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01", ...extra,
});
const revision = (n: number, extra: Record<string, unknown> = {}) => ({
  revision_id: `brand-cg_rev_${n}`, revision: n, template_version_id: `tpl-v${n}`, form_artifact_id: `fa-${n}`,
  bundle_form_version: `form@000000${n}`, worker_version_id: `wv-${n}`, created_by: "owner", created_at: `2026-10-0${n}T00:00:00.000Z`,
  is_current: n === 3, ...extra,
});
const revisions = BrandRevisionsResponse.parse({
  brand_id: "brand-cg", current_revision_id: "brand-cg_rev_3", rollback_target_revision_id: "brand-cg_rev_2",
  // Newest first, as the route returns them.
  revisions: [revision(3), revision(2), revision(1)],
});

type Handler = () => Response | Promise<Response>;
let routes: Map<string, Handler>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Serves one brand row (raw, so a test can hand the screen a shape the contract would refuse). */
function serve(row: Record<string, unknown>, revisionsHandler?: Handler) {
  const id = row.brand_id as string;
  routes.set("GET /api/lifecycle/brands", () => json({ brands: [row] }));
  routes.set(`GET /api/brands/${id}/checklist`, () => json({ brand_id: id, checklist: [] }));
  routes.set(`GET /api/brands/${id}/installs`, () => json({ brand_id: id, installs: [] }));
  routes.set(`GET /api/brands/${id}/revisions`, revisionsHandler ?? (() => json(revisions)));
}

beforeEach(() => {
  routes = new Map<string, Handler>([
    ["GET /api/upgrade-all/latest", () => json({ upgrade: null })],
    ["GET /api/brands", () => json({ brands: [], generated_at: "2026-10-06T00:00:00Z" })],
  ]);
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (input.startsWith("/api/funnel?")) return json({ from: "2026-10-01", to: "2026-10-07", rows: [] });
    const handler = routes.get(`${method} ${input}`);
    if (!handler) throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
    return handler();
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const copyButton = () => screen.findByRole("button", { name: /คัดลอก Final URL/ });

describe("brand card: Copy Final URL, Open site and revision history", () => {
  it("copies https://<apex>/?keyword={keyword} and confirms with a toast", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    serve(lifecycle("brand-cg", "creditsgene.test"));
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await copyButton());
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_CG));
    expect((await screen.findByRole("status")).textContent).toContain("creditsgene.test");
    expect(screen.queryByDisplayValue(URL_CG)).toBeNull();
  });

  it("shows the URL in a read-only input when the clipboard is missing", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
      serve(lifecycle("brand-cg", "creditsgene.test"));
      render(<BrandLifecycle me={owner} />);
      fireEvent.click(await copyButton());
      expect((await screen.findByDisplayValue(URL_CG)).hasAttribute("readonly")).toBe(true);
      const toast = document.querySelector(".toast");
      expect(toast?.getAttribute("role")).toBe("alert");
      expect(toast?.classList.contains("toast-err")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("shows the URL in a read-only input when the clipboard rejects", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const writeText = vi.fn(async () => { throw new Error("denied"); });
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      serve(lifecycle("brand-cg", "creditsgene.test"));
      render(<BrandLifecycle me={owner} />);
      fireEvent.click(await copyButton());
      expect((await screen.findByDisplayValue(URL_CG)).hasAttribute("readonly")).toBe(true);
      expect(writeText).toHaveBeenCalledWith(URL_CG);
      const toast = document.querySelector(".toast");
      expect(toast?.getAttribute("role")).toBe("alert");
      expect(toast?.classList.contains("toast-err")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("opens the site at the apex in a new tab, safely", async () => {
    serve(lifecycle("brand-cg", "creditsgene.test"));
    render(<BrandLifecycle me={owner} />);
    const link = await screen.findByRole("link", { name: /เปิดเว็บไซต์/ });
    expect(link.getAttribute("href")).toBe("https://creditsgene.test");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("copies the core hostname for a brand with no factory domain", async () => {
    // Review Focus 3: hostnames[0] as core returned it, with no www. stripping.
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    // A core-only brand has no factory revisions, so the revisions request fails (404); the side panel must still work.
    serve(
      lifecycle("brand-b", "www.b.test", { name: undefined, status: "unmanaged", current_revision_id: null, bundle_form_version: null, payload_version: null }),
      () => json({ error: "not_found", resource: "brand" }, 404),
    );
    render(<BrandLifecycle me={owner} />);
    expect((await screen.findByRole("link", { name: /เปิดเว็บไซต์/ })).getAttribute("href")).toBe("https://www.b.test");
    fireEvent.click(await copyButton());
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://www.b.test/?keyword={keyword}"));
  });

  it("lists revisions newest first and marks the current one and the rollback target", async () => {
    serve(lifecycle("brand-cg", "creditsgene.test"));
    render(<BrandLifecycle me={owner} />);
    const section = (await screen.findByRole("heading", { name: /ประวัติเวอร์ชัน/ })).closest("section")!;
    await waitFor(() => expect(within(section).getAllByRole("listitem").length).toBe(3));
    const [first, second, third] = within(section).getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(first).toContain("#3");
    expect(first).toContain("ใช้งานอยู่");
    expect(first).not.toContain("เป้าหมายการย้อนกลับ");
    expect(first).toContain("2026-10-03T00:00:00.000Z");
    expect(first).toContain("owner");
    expect(first).toContain("tpl-v3");
    expect(first).toContain("form@0000003");
    expect(first).toContain("wv-3");
    expect(second).toContain("#2");
    expect(second).toContain("เป้าหมายการย้อนกลับ");
    expect(second).not.toContain("ใช้งานอยู่");
    expect(third).toContain("#1");
    expect(third).not.toContain("ใช้งานอยู่");
    expect(third).not.toContain("เป้าหมายการย้อนกลับ");
  });

  it("names the rollback target in the Rollback confirm", async () => {
    serve(lifecycle("brand-cg", "creditsgene.test"));
    render(<BrandLifecycle me={owner} />);
    await screen.findByRole("heading", { name: /ประวัติเวอร์ชัน/ });
    await waitFor(() => expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0));
    fireEvent.click(await screen.findByRole("button", { name: /ย้อนกลับ \(Rollback\)/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("brand-cg_rev_2");
  });

  it("fetches the revisions again when current_revision_id moves while the first fetch is in flight", async () => {
    serve(lifecycle("brand-cg", "creditsgene.test"));
    let release!: (response: Response) => void;
    let calls = 0;
    const afterRollback = BrandRevisionsResponse.parse({
      brand_id: "brand-cg", current_revision_id: "brand-cg_rev_4", rollback_target_revision_id: "brand-cg_rev_3",
      revisions: [revision(4, { is_current: true }), revision(3, { is_current: false })],
    });
    routes.set("GET /api/brands/brand-cg/revisions", () => {
      calls += 1;
      return calls === 1 ? new Promise<Response>((resolve) => { release = resolve; }) : json(afterRollback);
    });
    let rolledBack = false;
    routes.set("GET /api/lifecycle/brands", () => json({ brands: [lifecycle("brand-cg", "creditsgene.test", { current_revision_id: rolledBack ? "brand-cg_rev_4" : "brand-cg_rev_3" })] }));
    routes.set("POST /api/brands/brand-cg/rollback", () => { rolledBack = true; return json({ install_id: "op-1", brand_id: "brand-cg", status: "ready" }, 201); });
    routes.set("GET /api/installs/op-1", () => json({ install_id: "op-1", brand_id: "brand-cg", revision_id: "brand-cg_rev_4", status: "ready", runtime_sync_status: "ready", receipts: [] }));
    render(<BrandLifecycle me={owner} />);
    await waitFor(() => expect(calls).toBe(1));
    fireEvent.click(await screen.findByRole("button", { name: /ย้อนกลับ \(Rollback\)/ }));
    await answerConfirm(true);
    // The selection moved to rev_4 while the first fetch (issued for rev_3) is still pending.
    await waitFor(() => expect(calls).toBe(2));
    release(json(revisions));
    const section = (await screen.findByRole("heading", { name: /ประวัติเวอร์ชัน/ })).closest("section")!;
    await waitFor(() => expect(within(section).getAllByRole("listitem").length).toBe(2));
    expect(within(section).getAllByRole("listitem")[0]!.textContent).toContain("#4");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(2);
  });

  it("still shows the read-only input and the error toast when a copy fails while a rollback is dispatched", async () => {
    let reject!: (error: Error) => void;
    const writeText = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    serve(lifecycle("brand-cg", "creditsgene.test"));
    let posted = false;
    routes.set("POST /api/brands/brand-cg/rollback", () => { posted = true; return json({ install_id: "op-1", brand_id: "brand-cg", status: "ready" }, 201); });
    routes.set("GET /api/installs/op-1", () => json({ install_id: "op-1", brand_id: "brand-cg", revision_id: "brand-cg_rev_2", status: "ready", runtime_sync_status: "ready", receipts: [] }));
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await copyButton());
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: /ย้อนกลับ \(Rollback\)/ }));
    await answerConfirm(true);
    await waitFor(() => expect(posted).toBe(true));
    reject(new Error("denied"));
    expect((await screen.findByDisplayValue(URL_CG)).hasAttribute("readonly")).toBe(true);
    expect(document.querySelector(".toast.toast-err")).toBeTruthy();
  });

  it("says the rollback target is unknown when the revisions did not load", async () => {
    serve(lifecycle("brand-cg", "creditsgene.test"), () => json({ error: "not_found", resource: "brand" }, 404));
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: /ย้อนกลับ \(Rollback\)/ }));
    const text = (await answerConfirm(false)).textContent ?? "";
    expect(text).toContain("ยังไม่ทราบเวอร์ชันเป้าหมาย");
    expect(text).toContain("Rollback target unknown");
  });

  it("says there is no rollback target when the response has none", async () => {
    serve(lifecycle("brand-cg", "creditsgene.test"), () => json({ ...revisions, rollback_target_revision_id: null }));
    render(<BrandLifecycle me={owner} />);
    await waitFor(() => expect(screen.getAllByRole("listitem").length).toBe(3));
    fireEvent.click(await screen.findByRole("button", { name: /ย้อนกลับ \(Rollback\)/ }));
    const text = (await answerConfirm(false)).textContent ?? "";
    expect(text).toContain("ไม่มีเวอร์ชันเป้าหมาย");
    expect(text).toContain("No rollback target");
  });

  it("hides Copy Final URL and Open site when the brand has no hostname", async () => {
    serve({ ...lifecycle("brand-cg", "creditsgene.test"), hostnames: [] });
    render(<BrandLifecycle me={owner} />);
    await screen.findByRole("heading", { name: /ประวัติเวอร์ชัน/ });
    expect(screen.queryByRole("button", { name: /คัดลอก Final URL/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /เปิดเว็บไซต์/ })).toBeNull();
  });
});
