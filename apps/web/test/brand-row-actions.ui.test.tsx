import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleBrandSummary, type InstallWithReceipts } from "@anjuna/contracts";
import { nextAction, type LifecycleRow, type LifecycleRowStatus, type NextAction, type Role } from "../src/client/lifecycle-state";
import { BrandLifecycle } from "../src/client/screens/BrandLifecycle";
import { answerConfirm } from "./confirm";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const employee = { ...owner, id: "employee", role: "employee" as const };
const newerForm = { form_artifact_id: "fa-2", bundle_form_version: "form@abcdef2" };

const base = (id: string, status: string, extra: Record<string, unknown> = {}) => LifecycleBrandSummary.parse({
  brand_id: id, name: "Row Case", account: "test-account", hostnames: [`${id}.test`], status,
  current_revision_id: "rev-1", runtime_sync_status: "ready",
  bundle_form_version: "form@abcdef1", payload_version: "2026-01", ...extra,
});
const failedInstall = (id: string, recoveryRequired: boolean): InstallWithReceipts => ({
  install_id: "ins-f", brand_id: id, revision_id: "rev-1", status: "failed",
  runtime_sync_status: "failed", receipts: [], ...(recoveryRequired ? { recovery_required: true } : {}),
});

type Handler = (init?: RequestInit) => Response | Promise<Response>;
let routes: Map<string, Handler>;
let requests: Array<{ method: string; path: string }>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** One selected brand row with a runtime row, empty checklist and empty revisions. */
function serveBrand(row: LifecycleBrandSummary, installs: readonly unknown[] = [], detail?: InstallWithReceipts) {
  const id = row.brand_id;
  routes.set("GET /api/lifecycle/brands", () => json({ brands: [row] }));
  routes.set("GET /api/brands", () => json({ brands: [{
    brand_id: id, hostnames: row.hostnames, status: "live", flow_gate_mode: "param", ab_config: null,
    form_version: "form@abcdef1", stats_7d: { leads: 0, sold: 0, pending: 0 },
  }], generated_at: "2026-10-06T00:00:00Z" }));
  routes.set(`GET /api/brands/${id}/checklist`, () => json({ brand_id: id, checklist: [] }));
  routes.set(`GET /api/brands/${id}/installs`, () => json({ brand_id: id, installs }));
  routes.set(`GET /api/brands/${id}/revisions`, () => json({ brand_id: id, current_revision_id: null, rollback_target_revision_id: null, revisions: [] }));
  if (detail) routes.set(`GET /api/installs/${detail.install_id}`, () => json(detail));
}

beforeEach(() => {
  requests = [];
  routes = new Map<string, Handler>([
    ["GET /api/upgrade-all/latest", () => json({ upgrade: null })],
    ["GET /api/funnel", () => json({ from: "2026-10-01T00:00:00.000Z", to: "2026-10-07T00:00:00.000Z", rows: [] })],
  ]);
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, path: input });
    const handler = routes.get(`${method} ${input.startsWith("/api/funnel?") ? "/api/funnel" : input}`);
    if (!handler) throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
    return handler(init);
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/**
 * Every action button and link the detail aside shows, with its exact text. The sections below the actions (install progress,
 * revisions, checklist) are not row actions: InstallProgress is shared with Deploys and keeps its own "ลองใหม่ (Retry)".
 */
const detailLabels = () => {
  const aside = document.querySelector(".brands-aside")!;
  return [...aside.querySelectorAll("button, a")].filter((el) => !el.closest(".section")).map((el) => el.textContent ?? "").sort();
};
/** True when the install progress section offers its Retry button. */
const detailRetry = () => [...document.querySelectorAll(".brands-aside .section button.primary")].some((el) => el.textContent?.startsWith("ลองใหม่"));
/** The runtime toggle is a menu item only: the detail lists Pause and Resume in the runtime drawer. */
const MENU_ONLY = ["หยุดชั่วคราว", "เปิดใช้งานต่อ"];
/**
 * The row's primary button runs Install or Recover: the menu leaves that item out and the detail actions still list it, disabled or not.
 * Retry is the other case: the detail offers it in the install progress section (see detailRetry).
 */
const primaryInDetail = (tr: HTMLElement) => {
  const button = tr.querySelector<HTMLButtonElement>("button.row-primary");
  const label = button?.textContent ?? "";
  return button && (button.dataset.nextAction === "install" || (button.dataset.nextAction === "retry" && label === "กู้คืน")) ? [label] : [];
};
const primaryIsRetry = (tr: HTMLElement) => tr.querySelector<HTMLButtonElement>("button.row-primary")?.textContent === "ลองใหม่";
const openRowMenu = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "จัดการ" }));
  const menu = await screen.findByRole("menu");
  return within(menu).getAllByRole("menuitem").map((el) => el.textContent ?? "").sort();
};

describe("brand row actions menu", () => {
  it("opening the menu does not select the row", async () => {
    const a = base("brand-a", "live");
    const b = base("brand-b", "live");
    routes.set("GET /api/lifecycle/brands", () => json({ brands: [a, b] }));
    routes.set("GET /api/brands", () => json({ brands: [], generated_at: "2026-10-06T00:00:00Z" }));
    for (const row of [a, b]) {
      routes.set(`GET /api/brands/${row.brand_id}/checklist`, () => json({ brand_id: row.brand_id, checklist: [] }));
      routes.set(`GET /api/brands/${row.brand_id}/installs`, () => json({ brand_id: row.brand_id, installs: [] }));
      routes.set(`GET /api/brands/${row.brand_id}/revisions`, () => json({ brand_id: row.brand_id, current_revision_id: null, rollback_target_revision_id: null, revisions: [] }));
    }
    render(<BrandLifecycle me={owner} />);
    const rowOf = async (domain: string) => (await screen.findByRole("button", { name: new RegExp(domain.replace(".", "\\.")) })).closest("tr")!;
    const rowB = await rowOf("brand-b.test");
    fireEvent.click(within(rowB).getByRole("button", { name: "จัดการ" }));
    await screen.findByRole("menu");
    expect(within(rowB).getByRole("button", { name: /brand-b\.test/ }).getAttribute("aria-current")).toBeNull();
    expect(within(await rowOf("brand-a.test")).getByRole("button", { name: /brand-a\.test/ }).getAttribute("aria-current")).toBe("true");
  });

  it.each([
    ["draft", base("brand-s", "draft"), [], undefined],
    ["failed", base("brand-s", "failed"), [{ install_id: "ins-f", status: "failed", error: "boom" }], failedInstall("brand-s", false)],
    ["failed-recover", base("brand-s", "failed"), [{ install_id: "ins-f", status: "failed", error: "boom" }], failedInstall("brand-s", true)],
    ["live", base("brand-s", "live"), [], undefined],
    ["live-newer", base("brand-s", "live", { newer_form: newerForm }), [], undefined],
    ["paused", base("brand-s", "paused"), [], undefined],
    ["unmanaged", LifecycleBrandSummary.parse({
      brand_id: "brand-s", account: "test-account", hostnames: ["brand-s.test"], status: "unmanaged",
      current_revision_id: null, runtime_sync_status: "ready", bundle_form_version: null, payload_version: null,
    }), [], undefined],
  ] as const)("the row menu plus the primary button show exactly the detail panel actions for a %s brand, owner and employee", async (_name, row, installs, detail) => {
    for (const me of [owner, employee]) {
      serveBrand(row, installs, detail);
      render(<BrandLifecycle me={me} />);
      await screen.findByRole("button", { name: "จัดการ" });
      // The failed install detail must have landed before reading the detail labels.
      if (detail) await screen.findByText("ins-f", { selector: "code" });
      else await waitFor(() => expect(detailLabels().length).toBeGreaterThan(0));
      const expected = detailLabels();
      const tr = document.querySelector<HTMLElement>(".brand-table tbody tr.click")!;
      const actual = [...(await openRowMenu()).filter((label) => !MENU_ONLY.includes(label)), ...primaryInDetail(tr)].sort();
      expect({ role: me.role, actual }).toEqual({ role: me.role, actual: expected });
      expect({ role: me.role, retry: detailRetry() }).toEqual({ role: me.role, retry: primaryIsRetry(tr) });
      cleanup();
    }
  });

  it("Redeploy from the row asks the same confirm and calls api.redeploy", async () => {
    const row = base("brand-a", "live");
    serveBrand(row);
    routes.set("POST /api/brands/brand-a/redeploy", () => json({ install_id: "op-9", brand_id: "brand-a", status: "running" }, 201));
    routes.set("GET /api/installs/op-9", () => json({
      install_id: "op-9", brand_id: "brand-a", revision_id: "rev-1", status: "running",
      runtime_sync_status: "running", receipts: [],
    } satisfies InstallWithReceipts));
    render(<BrandLifecycle me={owner} />);
    await screen.findByRole("button", { name: "จัดการ" });
    fireEvent.click(screen.getByRole("button", { name: "จัดการ" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "ติดตั้งใหม่" }));
    const fromRow = (await answerConfirm(false)).textContent;
    expect(fromRow).toContain("Redeploy");
    fireEvent.click(within(document.querySelector(".brands-aside")!).getByRole("button", { name: "ติดตั้งใหม่" }));
    const fromDetail = (await answerConfirm(false)).textContent;
    expect(fromDetail).toBe(fromRow);
    fireEvent.click(screen.getByRole("button", { name: "จัดการ" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "ติดตั้งใหม่" }));
    await answerConfirm(true);
    await waitFor(() => expect(requests.filter((r) => r.method === "POST" && r.path === "/api/brands/brand-a/redeploy")).toHaveLength(1));
  });

  it("a non-selected failed row shows no Retry or Recover while the selected recovery detail gates the full install", async () => {
    const latestFailed = {
      install_id: "ins-brand-b", operation: "install", status: "failed",
      started_at: "2026-10-06T00:00:00Z", finished_at: "2026-10-06T00:01:00Z", started_by: "owner",
    };
    for (const me of [owner, employee]) {
      const a = base("brand-a", "failed");
      const b = base("brand-b", "failed", { latest_install: latestFailed });
      routes.set("GET /api/lifecycle/brands", () => json({ brands: [a, b] }));
      routes.set("GET /api/brands", () => json({ brands: [a, b].map((row) => ({
        brand_id: row.brand_id, hostnames: row.hostnames, status: "live", flow_gate_mode: "param", ab_config: null,
        form_version: "form@abcdef1", stats_7d: { leads: 0, sold: 0, pending: 0 },
      })), generated_at: "2026-10-06T00:00:00Z" }));
      for (const row of [a, b]) {
        const id = row.brand_id;
        routes.set(`GET /api/brands/${id}/checklist`, () => json({ brand_id: id, checklist: [] }));
        routes.set(`GET /api/brands/${id}/installs`, () => json({
          brand_id: id, installs: id === "brand-a" ? [{ install_id: "ins-f", status: "failed", error: "boom" }] : [],
        }));
        routes.set(`GET /api/brands/${id}/revisions`, () => json({ brand_id: id, current_revision_id: null, rollback_target_revision_id: null, revisions: [] }));
      }
      routes.set("GET /api/installs/ins-f", () => json(failedInstall("brand-a", true)));
      render(<BrandLifecycle me={me} />);
      // The selected brand's recovery detail must have landed first.
      await screen.findByText("ins-f", { selector: "code" });
      const pickB = await screen.findByRole("button", { name: /brand-b\.test/ });
      fireEvent.click(within(pickB.closest("tr")!).getByRole("button", { name: "จัดการ" }));
      const menuB = within(await screen.findByRole("menu")).getAllByRole("menuitem").map((el) => el.textContent ?? "");
      expect(menuB).not.toContain("ลองใหม่");
      expect(menuB).not.toContain("กู้คืน");
      fireEvent.click(document.body);
      const aside = detailLabels();
      // Recover is in the detail for both roles; the employee's is disabled with the reason.
      expect(aside).toContain("กู้คืน");
      expect(aside).not.toContain("ลองใหม่");
      const recover = [...document.querySelectorAll<HTMLButtonElement>(".brands-aside .side-actions button")].find((el) => el.textContent === "กู้คืน")!;
      expect(recover.disabled).toBe(me.role === "employee");
      expect(recover.title).toBe(me.role === "employee" ? "เฉพาะเจ้าของกู้คืนได้" : "");
      cleanup();
    }
  });

  /** Two draft brands; brand-a is auto-selected, brand-b is only a row. */
  function serveTwoBrands(postB: Handler) {
    const a = base("brand-a", "draft");
    const b = base("brand-b", "draft");
    routes.set("GET /api/lifecycle/brands", () => json({ brands: [a, b] }));
    routes.set("GET /api/brands", () => json({ brands: [a, b].map((row) => ({
      brand_id: row.brand_id, hostnames: row.hostnames, status: "live", flow_gate_mode: "param", ab_config: null,
      form_version: "form@abcdef1", stats_7d: { leads: 0, sold: 0, pending: 0 },
    })), generated_at: "2026-10-06T00:00:00Z" }));
    for (const row of [a, b]) {
      const id = row.brand_id;
      routes.set(`GET /api/brands/${id}/checklist`, () => json({ brand_id: id, checklist: [] }));
      routes.set(`GET /api/brands/${id}/installs`, () => json({ brand_id: id, installs: [] }));
      routes.set(`GET /api/brands/${id}/revisions`, () => json({ brand_id: id, current_revision_id: null, rollback_target_revision_id: null, revisions: [] }));
    }
    routes.set("POST /api/brands/brand-b/install", postB);
    routes.set("GET /api/installs/op-b", () => json({
      install_id: "op-b", brand_id: "brand-b", revision_id: "rev-1", status: "running",
      runtime_sync_status: "running", receipts: [],
    } satisfies InstallWithReceipts));
  }
  const rowOf = async (domain: string) => (await screen.findByRole("button", { name: new RegExp(domain.replace(".", "\.")) })).closest("tr")!;
  // Install is the primary button of a draft row, so the menu no longer repeats it.
  const chooseRowInstall = async (domain: string) => {
    fireEvent.click(within(await rowOf(domain)).getByRole("button", { name: "ติดตั้ง" }));
  };
  const postsToB = () => requests.filter((r) => r.method === "POST" && r.path === "/api/brands/brand-b/install");

  it("a row deploy on another brand selects it and tracks the install like the detail button", async () => {
    serveTwoBrands(() => json({ install_id: "op-b", brand_id: "brand-b", status: "running" }, 201));
    render(<BrandLifecycle me={owner} />);
    await screen.findAllByRole("button", { name: "จัดการ" });
    expect(document.querySelector(".brands-aside")!.textContent).toContain("brand-a.test");
    await chooseRowInstall("brand-b.test");
    // The brand is selected, the POST went out once, and the detail shows the tracked install.
    await waitFor(() => expect(document.querySelector(".brands-aside")!.textContent).toContain("brand-b.test"));
    await waitFor(() => expect(document.body.textContent).toContain("op-b"));
    expect(postsToB()).toHaveLength(1);
    // The poll reads the accepted install again (first read after the POST, then one per 3 s tick).
    await waitFor(() => expect(requests.filter((r) => r.path === "/api/installs/op-b").length).toBeGreaterThanOrEqual(2), { timeout: 6000 });
    expect(postsToB()).toHaveLength(1);
  }, 15000);

  it("choosing a row deploy while its POST hangs sends one POST only", async () => {
    let releaseB!: (value: Response) => void;
    serveTwoBrands(() => new Promise<Response>((resolve) => { releaseB = resolve; }));
    render(<BrandLifecycle me={owner} />);
    await screen.findAllByRole("button", { name: "จัดการ" });
    await chooseRowInstall("brand-b.test");
    await waitFor(() => expect(postsToB()).toHaveLength(1));
    // Selecting the brand by row click mid-flight must not enable a second Install.
    fireEvent.click(await screen.findByRole("button", { name: /brand-b\.test/ }));
    await waitFor(() => expect(document.querySelector(".brands-aside")!.textContent).toContain("brand-b.test"));
    const detailInstall = [...document.querySelector(".brands-aside")!.querySelectorAll("button")].find((el) => el.textContent === "ติดตั้ง");
    expect(detailInstall === undefined || (detailInstall as HTMLButtonElement).disabled).toBe(true);
    // The row's own Install button waits too: a second click cannot send a second POST.
    const primaryB = within(await rowOf("brand-b.test")).getByRole("button", { name: "ติดตั้ง" }) as HTMLButtonElement;
    expect(primaryB.disabled).toBe(true);
    fireEvent.click(primaryB);
    fireEvent.click(within(await rowOf("brand-b.test")).getByRole("button", { name: "จัดการ" }));
    expect(within(await screen.findByRole("menu")).queryByRole("menuitem", { name: "ติดตั้ง" })).toBeNull();
    fireEvent.mouseDown(document.body);
    expect(postsToB()).toHaveLength(1);
    releaseB(json({ install_id: "op-b", brand_id: "brand-b", status: "running" }, 201));
    await waitFor(() => expect(document.body.textContent).toContain("op-b"));
    expect(postsToB()).toHaveLength(1);
  });

  it("a brand without a form artifact has no menu Install and sends no POST", async () => {
    serveBrand(base("brand-c", "draft", { bundle_form_version: null, payload_version: null }));
    render(<BrandLifecycle me={owner} />);
    await screen.findByRole("button", { name: "จัดการ" });
    expect(await openRowMenu()).not.toContain("ติดตั้ง");
    // The row shows Install disabled, with the reason, instead of hiding it.
    const primary = within(await rowOf("brand-c.test")).getByRole("button", { name: "ติดตั้ง" }) as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
    expect(primary.title).toBe("ยังไม่มีฟอร์มที่ยืนยันแล้ว");
    expect((within(document.querySelector(".brands-aside")!).getByRole("button", { name: "ติดตั้ง" }) as HTMLButtonElement).disabled).toBe(true);
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("Copy Final URL from the row copies the same URL as the detail button", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    serveBrand(base("brand-a", "live"));
    render(<BrandLifecycle me={owner} />);
    await screen.findByRole("button", { name: "จัดการ" });
    fireEvent.click(screen.getByRole("button", { name: "จัดการ" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /คัดลอก Final URL/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://brand-a.test/?keyword={keyword}&utm_campaign={campaignid}"));
    writeText.mockClear();
    fireEvent.click(within(document.querySelector(".brands-aside")!).getByRole("button", { name: /คัดลอก Final URL/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://brand-a.test/?keyword={keyword}&utm_campaign={campaignid}"));
  });

  /** brand-a is a selected draft; brand-b is a non-selected failed brand whose latest_install has the given status. */
  function serveParity(status: "running" | "failed" | "ready") {
    const latest = {
      install_id: "ins-b", operation: "install", status,
      started_at: "2026-10-06T00:00:00Z", finished_at: status === "running" ? null : "2026-10-06T00:01:00Z", started_by: "owner",
    };
    const a = base("brand-a", "draft");
    const b = base("brand-b", "failed", { latest_install: latest });
    routes.set("GET /api/lifecycle/brands", () => json({ brands: [a, b] }));
    routes.set("GET /api/brands", () => json({ brands: [a, b].map((row) => ({
      brand_id: row.brand_id, hostnames: row.hostnames, status: "live", flow_gate_mode: "param", ab_config: null,
      form_version: "form@abcdef1", stats_7d: { leads: 0, sold: 0, pending: 0 },
    })), generated_at: "2026-10-06T00:00:00Z" }));
    for (const row of [a, b]) {
      const id = row.brand_id;
      routes.set(`GET /api/brands/${id}/checklist`, () => json({ brand_id: id, checklist: [] }));
      routes.set(`GET /api/brands/${id}/installs`, () => json({ brand_id: id, installs: id === "brand-b" ? [{ install_id: "ins-b", status, error: null }] : [] }));
      routes.set(`GET /api/brands/${id}/revisions`, () => json({ brand_id: id, current_revision_id: null, rollback_target_revision_id: null, revisions: [] }));
    }
    routes.set("GET /api/installs/ins-b", () => json({
      install_id: "ins-b", brand_id: "brand-b", revision_id: "rev-1", status,
      runtime_sync_status: status, receipts: [],
    } satisfies InstallWithReceipts));
  }

  it.each(["running", "failed", "ready"] as const)(
    "a non-selected row menu gated by latest_install %s equals the detail panel after selecting that row",
    async (status) => {
      serveParity(status);
      render(<BrandLifecycle me={owner} />);
      await screen.findAllByRole("button", { name: "จัดการ" });
      const trB = await rowOf("brand-b.test");
      fireEvent.click(within(trB).getByRole("button", { name: "จัดการ" }));
      const menuB = within(await screen.findByRole("menu")).getAllByRole("menuitem").map((el) => el.textContent ?? "").filter((label) => !MENU_ONLY.includes(label));
      // Install or Retry is the row's primary button, so the menu leaves it out and the detail lists it.
      const rowB = [...menuB, ...primaryInDetail(trB)].sort();
      const retryB = primaryIsRetry(trB);
      fireEvent.mouseDown(document.body);
      fireEvent.click(await screen.findByRole("button", { name: /brand-b\.test/ }));
      await waitFor(() => expect(document.querySelector(".brands-aside")!.textContent).toContain("brand-b.test"));
      // The detail hides deploy buttons while its history recovers, so wait until it settles on the row's labels.
      await waitFor(() => expect(detailLabels()).toEqual(rowB));
      await waitFor(() => expect(detailRetry()).toBe(retryB));
    },
  );

  it("a queued row Rollback waits for the brand's revisions and shows the real target", async () => {
    serveTwoBrands(() => json({}, 500));
    const a = base("brand-a", "draft");
    const b = base("brand-b", "live");
    routes.set("GET /api/lifecycle/brands", () => json({ brands: [a, b] }));
    let releaseRevisions!: () => void;
    const revisionsGate = new Promise<void>((resolve) => { releaseRevisions = resolve; });
    routes.set("GET /api/brands/brand-b/revisions", async () => {
      await revisionsGate;
      const revision = (n: number, current: boolean) => ({
        revision_id: `rev-${n}`, revision: n, template_version_id: "tpl-1", form_artifact_id: "fa-1", bundle_form_version: "form@abcdef1",
        worker_version_id: null, created_by: "owner", created_at: "2026-10-06T00:00:00Z", is_current: current,
      });
      return json({ brand_id: "brand-b", current_revision_id: "rev-2", rollback_target_revision_id: "rev-1", revisions: [revision(2, true), revision(1, false)] });
    });
    render(<BrandLifecycle me={owner} />);
    await screen.findAllByRole("button", { name: "จัดการ" });
    fireEvent.click(within(await rowOf("brand-b.test")).getByRole("button", { name: "จัดการ" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "ย้อนกลับ" }));
    await waitFor(() => expect(document.querySelector(".brands-aside")!.textContent).toContain("brand-b.test"));
    // Revisions still load: no confirm yet, so it cannot read "target unknown".
    await waitFor(() => expect(requests.some((r) => r.path === "/api/brands/brand-b/revisions")).toBe(true));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    releaseRevisions();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("#1 (rev-1)");
    expect(dialog.textContent).not.toContain("Rollback target unknown");
    await answerConfirm(false);
  });

  it("a queued row Install is not sent while the brand's history is still recovering", async () => {
    serveTwoBrands(() => json({ install_id: "op-b", brand_id: "brand-b", status: "running" }, 201));
    let releaseInstalls!: () => void;
    const installsGate = new Promise<void>((resolve) => { releaseInstalls = resolve; });
    routes.set("GET /api/brands/brand-b/installs", async () => { await installsGate; return json({ brand_id: "brand-b", installs: [] }); });
    render(<BrandLifecycle me={owner} />);
    await screen.findAllByRole("button", { name: "จัดการ" });
    await chooseRowInstall("brand-b.test");
    await waitFor(() => expect(document.querySelector(".brands-aside")!.textContent).toContain("brand-b.test"));
    await waitFor(() => expect(requests.some((r) => r.path === "/api/brands/brand-b/installs")).toBe(true));
    expect(postsToB()).toHaveLength(0);
    releaseInstalls();
    await waitFor(() => expect(postsToB()).toHaveLength(1));
  });
});

// Every state lifecycle-state.ts models: LifecycleUiStatus (draft, queued, running, ready, failed, rolled_back, detached,
// unmanaged, sync_error) and the brand statuses of LifecycleBrandSummary (installing, live, paused, retired). The Record
// type makes the compiler reject a new status that has no row here.
describe("nextAction", () => {
  const row = (over: Partial<LifecycleRow> = {}): LifecycleRow => ({
    status: "live", runtime_sync_status: "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01", latest_install: null, ...over,
  });
  const act = (kind: NextAction["kind"], label: string): NextAction => ({ kind, label, disabled: false });
  const look = act("open", "ดูแบรนด์");
  const watch = act("open", "ดูความคืบหน้า");
  const check = act("open", "ตรวจสอบ");
  const ownerOnly = (kind: NextAction["kind"], label: string, reason: string): [NextAction, NextAction] => [act(kind, label), { kind, label, disabled: true, reason }];

  const everyStatus: Record<LifecycleRowStatus, [NextAction, NextAction?]> = {
    draft: [act("install", "ติดตั้ง")],
    installing: [watch],
    queued: [watch],
    running: [watch],
    ready: [look],
    live: [look],
    failed: [act("install", "ติดตั้ง")],
    rolled_back: [check],
    detached: [check],
    unmanaged: [look],
    sync_error: [check],
    paused: [act("resume", "เปิดใช้งานต่อ")],
    retired: [look],
  };
  it.each(Object.entries(everyStatus) as Array<[LifecycleRowStatus, [NextAction, NextAction?]]>)(
    "a %s brand gets one next step, for the owner and the employee",
    (status, [forOwner, forEmployee = forOwner]) => {
      expect(nextAction(row({ status }), "owner")).toEqual(forOwner);
      expect(nextAction(row({ status }), "employee")).toEqual(forEmployee);
    },
  );

  const failedInstall = { status: "failed" as const };
  const noRoute = ownerOnly("set-route", "ตั้งเส้นทาง", "เฉพาะเจ้าของตั้งเส้นทางได้");
  const noApprove = ownerOnly("approve-template", "อนุมัติเทมเพลต", "เฉพาะเจ้าของอนุมัติเทมเพลตได้");
  const noRecover = ownerOnly("retry", "กู้คืน", "เฉพาะเจ้าของกู้คืนได้");
  const cases: Array<[string, LifecycleRow, [NextAction, NextAction?]]> = [
    ["a failed install gives retry, even on a live brand", row({ latest_install: failedInstall }), [act("retry", "ลองใหม่")]],
    ["a failed brand with a failed install gives retry", row({ status: "failed", latest_install: failedInstall }), [act("retry", "ลองใหม่")]],
    ["a failed install that needs recovery gives Recover, owner only", row({ status: "failed", latest_install: failedInstall, recovery_required: true }), noRecover],
    ["a running install beats a failed older read", row({ status: "failed", latest_install: { status: "running" } }), [watch]],
    ["a queued install on a live brand shows progress", row({ latest_install: { status: "queued" } }), [watch]],
    ["a paused core runtime gives resume on a live brand", row({ paused: true }), [act("resume", "เปิดใช้งานต่อ")]],
    ["a failed install beats a pause", row({ paused: true, latest_install: failedInstall }), [act("retry", "ลองใหม่")]],
    ["a live brand with a sync error is checked", row({ runtime_sync_status: "sync_error" }), [check]],
    ["a live brand whose runtime sync failed is checked", row({ runtime_sync_status: "failed" }), [check]],
    ["a core-only brand is not flagged for a sync error, which core state missing causes", row({ status: "unmanaged", runtime_sync_status: "sync_error" }), [look]],
    ["a draft with no form artifact has a disabled install with a reason", row({ status: "draft", bundle_form_version: null }), [{ kind: "install", label: "ติดตั้ง", disabled: true, reason: "ยังไม่มีฟอร์มที่ยืนยันแล้ว" }]],
    ["a draft with no payload version has a disabled install with a reason", row({ status: "draft", payload_version: null }), [{ kind: "install", label: "ติดตั้ง", disabled: true, reason: "ยังไม่มีฟอร์มที่ยืนยันแล้ว" }]],
    ["a draft whose template waits for approval gives approve-template, owner only", row({ status: "draft", template_approved: false }), noApprove],
    ["a live brand with no drain route gives set-route, owner only", row({ drain_route: false }), noRoute],
    ["a live brand without a confirmed test sold gives test-sold", row({ drain_route: true, test_sold: false }), [act("test-sold", "ยืนยันขายทดสอบ")]],
    ["no drain route comes before test sold", row({ drain_route: false, test_sold: false }), noRoute],
    ["unknown checklist data never blocks", row({ drain_route: undefined, test_sold: undefined, template_approved: undefined }), [look]],
    ["a live, healthy brand with every step done gives open", row({ drain_route: true, test_sold: true, template_approved: true }), [look]],
    ["a paused brand with no route still resumes first", row({ paused: true, drain_route: false }), [act("resume", "เปิดใช้งานต่อ")]],
  ];
  it.each(cases)("%s", (_name, input, [forOwner, forEmployee = forOwner]) => {
    expect(nextAction(input, "owner")).toEqual(forOwner);
    expect(nextAction(input, "employee")).toEqual(forEmployee);
  });

  it("never hides an action from a role: a refused action is disabled with a Thai reason", () => {
    const refused = [row({ status: "draft", template_approved: false }), row({ drain_route: false }), row({ status: "failed", latest_install: failedInstall, recovery_required: true })]
      .map((input) => nextAction(input, "employee"));
    for (const action of refused) {
      expect(action.disabled).toBe(true);
      expect(action.reason).toMatch(/^[ก-๙]/);
      expect(action.reason).not.toMatch(/\([A-Za-z]/);
    }
  });

  it("is pure: the same input gives equal output and the input is not changed", () => {
    const input = row({ status: "failed", latest_install: failedInstall });
    const snapshot = JSON.stringify(input);
    for (const role of ["owner", "employee"] as Role[]) expect(nextAction(input, role)).toEqual(nextAction(input, role));
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("brand row primary action", () => {
  const failedLatest = { install_id: "ins-f", operation: "install", status: "failed", started_at: "2026-10-06T00:00:00Z", finished_at: "2026-10-06T00:01:00Z", started_by: "owner" };
  const rowEl = async (domain: string) => (await screen.findByRole("button", { name: new RegExp(domain.replace(".", "\\.")) })).closest("tr")!;
  const primaryOf = (tr: HTMLElement) => tr.querySelectorAll<HTMLButtonElement>("button.row-primary");
  const runtimeStatus = (id: string, status: "live" | "paused") => routes.set("GET /api/brands", () => json({ brands: [{
    brand_id: id, hostnames: [`${id}.test`], status, flow_gate_mode: "param", ab_config: null, form_version: "form@abcdef1", stats_7d: { leads: 0, sold: 0, pending: 0 },
  }], generated_at: "2026-10-06T00:00:00Z" }));
  const menuLabels = async (tr: HTMLElement) => {
    fireEvent.click(within(tr).getByRole("button", { name: "จัดการ" }));
    const labels = within(await screen.findByRole("menu")).getAllByRole("menuitem").map((el) => el.textContent ?? "");
    fireEvent.mouseDown(document.body);
    return labels;
  };

  it("a failed install row has one primary button, Retry, and the other actions sit in the menu", async () => {
    serveBrand(base("brand-s", "failed", { latest_install: failedLatest }), [{ install_id: "ins-f", status: "failed", error: "boom" }], failedInstall("brand-s", false));
    routes.set("POST /api/installs/ins-f/retry", () => json({ install_id: "ins-r", brand_id: "brand-s", status: "running" }, 201));
    routes.set("GET /api/installs/ins-r", () => json({ install_id: "ins-r", brand_id: "brand-s", revision_id: "rev-1", status: "running", runtime_sync_status: "running", receipts: [] } satisfies InstallWithReceipts));
    render(<BrandLifecycle me={owner} />);
    const tr = await rowEl("brand-s.test");
    await screen.findByText("ins-f", { selector: "code" });
    const primary = primaryOf(tr);
    expect(primary).toHaveLength(1);
    expect(primary[0]!.textContent).toBe("ลองใหม่");
    expect(primary[0]!.dataset.nextAction).toBe("retry");
    // The row holds the select button, the one primary button and the menu button, nothing else.
    expect(within(tr).getAllByRole("button")).toHaveLength(3);
    const menu = await menuLabels(tr);
    expect(menu).not.toContain("ลองใหม่");
    expect(menu).toEqual(expect.arrayContaining(["ไทม์ไลน์", "ตั้งค่าแบรนด์"]));
    fireEvent.click(primary[0]!);
    await waitFor(() => expect(requests.filter((r) => r.method === "POST" && r.path === "/api/installs/ins-f/retry")).toHaveLength(1));
  });

  it("a failed install that needs recovery shows Recover as the one button: it asks first, owner only", async () => {
    serveBrand(base("brand-s", "failed", { latest_install: failedLatest }), [{ install_id: "ins-f", status: "failed", error: "boom" }], failedInstall("brand-s", true));
    routes.set("POST /api/brands/brand-s/recover", () => json({ install_id: "ins-c", brand_id: "brand-s", status: "running" }, 201));
    routes.set("GET /api/installs/ins-c", () => json({ install_id: "ins-c", brand_id: "brand-s", revision_id: "rev-1", status: "running", runtime_sync_status: "running", receipts: [] } satisfies InstallWithReceipts));
    render(<BrandLifecycle me={owner} />);
    const tr = await rowEl("brand-s.test");
    await waitFor(() => expect(primaryOf(tr)[0]?.textContent).toBe("กู้คืน"));
    expect(await menuLabels(tr)).not.toContain("กู้คืน");
    fireEvent.click(primaryOf(tr)[0]!);
    await answerConfirm(true);
    await waitFor(() => expect(requests.filter((r) => r.method === "POST" && r.path === "/api/brands/brand-s/recover")).toHaveLength(1));
    cleanup();

    serveBrand(base("brand-s", "failed", { latest_install: failedLatest }), [{ install_id: "ins-f", status: "failed", error: "boom" }], failedInstall("brand-s", true));
    render(<BrandLifecycle me={employee} />);
    const trE = await rowEl("brand-s.test");
    await waitFor(() => expect(primaryOf(trE)[0]?.textContent).toBe("กู้คืน"));
    expect(primaryOf(trE)[0]!.disabled).toBe(true);
    expect(trE.textContent).toContain("เฉพาะเจ้าของกู้คืนได้");
  });

  it("a paused brand has Resume as the one button and asks before it sends", async () => {
    serveBrand(base("brand-s", "live"));
    runtimeStatus("brand-s", "paused");
    routes.set("POST /api/brands/brand-s/resume", () => json({ brand_id: "brand-s", status: "live" }));
    for (const me of [owner, employee]) {
      render(<BrandLifecycle me={me} />);
      const tr = await rowEl("brand-s.test");
      await waitFor(() => expect(primaryOf(tr)[0]?.dataset.nextAction).toBe("resume"));
      expect(primaryOf(tr)).toHaveLength(1);
      expect(primaryOf(tr)[0]!.textContent).toBe("เปิดใช้งานต่อ");
      // Resume is the primary, so the menu does not repeat it and a paused brand has no Pause item.
      const labels = await menuLabels(tr);
      expect(labels).not.toContain("เปิดใช้งานต่อ");
      expect(labels).not.toContain("หยุดชั่วคราว");
      requests.length = 0;
      fireEvent.click(primaryOf(tr)[0]!);
      await answerConfirm(false);
      expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
      fireEvent.click(primaryOf(tr)[0]!);
      await answerConfirm(true);
      await waitFor(() => expect(requests.filter((r) => r.method === "POST" && r.path === "/api/brands/brand-s/resume")).toHaveLength(1));
      cleanup();
    }
  });

  it("a live, healthy brand has Open as the one button, and Pause sits in the menu for the owner only", async () => {
    serveBrand(base("brand-s", "live"));
    routes.set("POST /api/brands/brand-s/pause", () => json({ brand_id: "brand-s", status: "paused" }));
    render(<BrandLifecycle me={owner} />);
    const tr = await rowEl("brand-s.test");
    await waitFor(() => expect(primaryOf(tr)[0]?.dataset.nextAction).toBe("open"));
    expect(primaryOf(tr)).toHaveLength(1);
    expect(primaryOf(tr)[0]!.textContent).toBe("ดูแบรนด์");
    expect(await menuLabels(tr)).toContain("หยุดชั่วคราว");
    fireEvent.click(within(tr).getByRole("button", { name: "จัดการ" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "หยุดชั่วคราว" }));
    await answerConfirm(true);
    await waitFor(() => expect(requests.filter((r) => r.method === "POST" && r.path === "/api/brands/brand-s/pause")).toHaveLength(1));
    cleanup();

    serveBrand(base("brand-s", "live"));
    render(<BrandLifecycle me={employee} />);
    const trE = await rowEl("brand-s.test");
    await waitFor(() => expect(primaryOf(trE)[0]?.dataset.nextAction).toBe("open"));
    // The employee still sees Pause, disabled with the reason: only the Owner pauses.
    fireEvent.click(within(trE).getByRole("button", { name: "จัดการ" }));
    const pause = within(await screen.findByRole("menu")).getByRole("menuitem", { name: "หยุดชั่วคราว" });
    expect(pause.getAttribute("aria-disabled")).toBe("true");
    expect(pause.getAttribute("title")).toBe("เฉพาะเจ้าของหยุดแบรนด์ได้");
    requests.length = 0;
    fireEvent.click(pause);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("an employee sees Rollback and Redeploy of a live brand in the row menu and the detail, disabled with a reason, and sending nothing", async () => {
    serveBrand(base("brand-s", "live", { newer_form: newerForm }));
    render(<BrandLifecycle me={employee} />);
    const tr = await rowEl("brand-s.test");
    await waitFor(() => expect(detailLabels()).toContain("ย้อนกลับ"));
    const owners = ["ย้อนกลับ", "ติดตั้งใหม่", "ติดตั้งใหม่พร้อมฟอร์มล่าสุด"];
    const reasons: Record<string, string> = { "ย้อนกลับ": "เฉพาะเจ้าของย้อนกลับแบรนด์ได้", "ติดตั้งใหม่": "เฉพาะเจ้าของติดตั้งแบรนด์ใหม่ได้", "ติดตั้งใหม่พร้อมฟอร์มล่าสุด": "เฉพาะเจ้าของติดตั้งแบรนด์ใหม่ได้" };
    requests.length = 0;
    // Detail panel: disabled buttons with the reason as title, and one note that says why.
    const aside = within(document.querySelector<HTMLElement>(".brands-aside")!);
    for (const label of owners) {
      const button = aside.getByRole("button", { name: label }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe(reasons[label]);
      fireEvent.click(button);
    }
    expect(aside.getByRole("note").textContent).toContain("เฉพาะเจ้าของ");
    // Row menu: aria-disabled items with the same reasons; choosing one keeps the menu open and sends nothing.
    fireEvent.click(within(tr).getByRole("button", { name: "จัดการ" }));
    const menu = within(await screen.findByRole("menu"));
    for (const label of owners) {
      const item = menu.getByRole("menuitem", { name: label });
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(item.getAttribute("title")).toBe(reasons[label]);
      fireEvent.click(item);
    }
    expect(screen.queryByRole("menu")).not.toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
    cleanup();

    // The owner gets the same items enabled.
    serveBrand(base("brand-s", "live", { newer_form: newerForm }));
    render(<BrandLifecycle me={owner} />);
    const trO = await rowEl("brand-s.test");
    await waitFor(() => expect(detailLabels()).toContain("ย้อนกลับ"));
    fireEvent.click(within(trO).getByRole("button", { name: "จัดการ" }));
    const menuO = within(await screen.findByRole("menu"));
    for (const label of owners) expect(menuO.getByRole("menuitem", { name: label }).getAttribute("aria-disabled")).toBeNull();
  });

  it("Open selects the row of a brand that is not selected", async () => {
    const a = base("brand-a", "live");
    const b = base("brand-b", "live");
    routes.set("GET /api/lifecycle/brands", () => json({ brands: [a, b] }));
    routes.set("GET /api/brands", () => json({ brands: [], generated_at: "2026-10-06T00:00:00Z" }));
    for (const row of [a, b]) {
      routes.set(`GET /api/brands/${row.brand_id}/checklist`, () => json({ brand_id: row.brand_id, checklist: [] }));
      routes.set(`GET /api/brands/${row.brand_id}/installs`, () => json({ brand_id: row.brand_id, installs: [] }));
      routes.set(`GET /api/brands/${row.brand_id}/revisions`, () => json({ brand_id: row.brand_id, current_revision_id: null, rollback_target_revision_id: null, revisions: [] }));
    }
    render(<BrandLifecycle me={owner} />);
    const trB = await rowEl("brand-b.test");
    expect(within(trB).getByRole("button", { name: /brand-b\.test/ }).getAttribute("aria-current")).toBeNull();
    fireEvent.click(primaryOf(trB)[0]!);
    await waitFor(() => expect(within(trB).getByRole("button", { name: /brand-b\.test/ }).getAttribute("aria-current")).toBe("true"));
  });

  it("a draft has Install as the one button and sends one POST; without a form artifact it is disabled with the reason", async () => {
    serveBrand(base("brand-s", "draft"));
    routes.set("POST /api/brands/brand-s/install", () => json({ install_id: "op-s", brand_id: "brand-s", status: "running" }, 201));
    routes.set("GET /api/installs/op-s", () => json({ install_id: "op-s", brand_id: "brand-s", revision_id: "rev-1", status: "running", runtime_sync_status: "running", receipts: [] } satisfies InstallWithReceipts));
    render(<BrandLifecycle me={owner} />);
    const tr = await rowEl("brand-s.test");
    await waitFor(() => expect(detailLabels().length).toBeGreaterThan(0));
    expect(primaryOf(tr)[0]!.textContent).toBe("ติดตั้ง");
    expect(await menuLabels(tr)).not.toContain("ติดตั้ง");
    fireEvent.click(primaryOf(tr)[0]!);
    await waitFor(() => expect(requests.filter((r) => r.method === "POST" && r.path === "/api/brands/brand-s/install")).toHaveLength(1));
    cleanup();

    requests.length = 0;
    serveBrand(base("brand-c", "draft", { bundle_form_version: null, payload_version: null }));
    render(<BrandLifecycle me={owner} />);
    const trC = await rowEl("brand-c.test");
    expect(primaryOf(trC)[0]!.disabled).toBe(true);
    expect(trC.textContent).toContain("ยังไม่มีฟอร์มที่ยืนยันแล้ว");
    fireEvent.click(primaryOf(trC)[0]!);
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("Retry on a row that is not selected selects it and retries once its install detail is loaded", async () => {
    const a = base("brand-a", "live");
    const b = base("brand-b", "failed", { latest_install: { ...failedLatest, install_id: "ins-b" } });
    routes.set("GET /api/lifecycle/brands", () => json({ brands: [a, b] }));
    routes.set("GET /api/brands", () => json({ brands: [], generated_at: "2026-10-06T00:00:00Z" }));
    for (const row of [a, b]) {
      const id = row.brand_id;
      routes.set(`GET /api/brands/${id}/checklist`, () => json({ brand_id: id, checklist: [] }));
      routes.set(`GET /api/brands/${id}/installs`, () => json({ brand_id: id, installs: id === "brand-b" ? [{ install_id: "ins-b", status: "failed", error: "boom" }] : [] }));
      routes.set(`GET /api/brands/${id}/revisions`, () => json({ brand_id: id, current_revision_id: null, rollback_target_revision_id: null, revisions: [] }));
    }
    routes.set("GET /api/installs/ins-b", () => json({ ...failedInstall("brand-b", false), install_id: "ins-b" }));
    routes.set("POST /api/installs/ins-b/retry", () => json({ install_id: "ins-r", brand_id: "brand-b", status: "running" }, 201));
    routes.set("GET /api/installs/ins-r", () => json({ install_id: "ins-r", brand_id: "brand-b", revision_id: "rev-1", status: "running", runtime_sync_status: "running", receipts: [] } satisfies InstallWithReceipts));
    render(<BrandLifecycle me={owner} />);
    const trB = await rowEl("brand-b.test");
    await waitFor(() => expect(document.querySelector(".brands-aside")!.textContent).toContain("brand-a.test"));
    expect(primaryOf(trB)[0]!.dataset.nextAction).toBe("retry");
    fireEvent.click(primaryOf(trB)[0]!);
    await waitFor(() => expect(requests.filter((r) => r.method === "POST" && r.path === "/api/installs/ins-b/retry")).toHaveLength(1));
    expect(document.querySelector(".brands-aside")!.textContent).toContain("brand-b.test");
  });
});
