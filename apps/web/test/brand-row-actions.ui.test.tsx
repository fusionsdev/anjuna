import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleBrandSummary, type InstallWithReceipts } from "@anjuna/contracts";
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

/** Every button and link label the detail aside shows. */
const detailLabels = () => {
  const aside = document.querySelector(".brands-aside")!;
  return [...aside.querySelectorAll("button, a")].map((el) => el.textContent ?? "").sort();
};
const openRowMenu = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "จัดการ (Actions)" }));
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
    fireEvent.click(within(rowB).getByRole("button", { name: "จัดการ (Actions)" }));
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
  ] as const)("the row menu shows exactly the detail panel actions for a %s brand, owner and employee", async (_name, row, installs, detail) => {
    for (const me of [owner, employee]) {
      serveBrand(row, installs, detail);
      render(<BrandLifecycle me={me} />);
      await screen.findByRole("button", { name: "จัดการ (Actions)" });
      // The failed install detail must have landed before reading the detail labels.
      if (detail) await screen.findByText("ins-f", { selector: "code" });
      else await waitFor(() => expect(detailLabels().length).toBeGreaterThan(0));
      const expected = detailLabels();
      const actual = await openRowMenu();
      expect({ role: me.role, actual }).toEqual({ role: me.role, actual: expected });
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
    await screen.findByRole("button", { name: "จัดการ (Actions)" });
    fireEvent.click(screen.getByRole("button", { name: "จัดการ (Actions)" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "ติดตั้งใหม่ (Redeploy)" }));
    const fromRow = (await answerConfirm(false)).textContent;
    expect(fromRow).toContain("Redeploy");
    fireEvent.click(within(document.querySelector(".brands-aside")!).getByRole("button", { name: "ติดตั้งใหม่ (Redeploy)" }));
    const fromDetail = (await answerConfirm(false)).textContent;
    expect(fromDetail).toBe(fromRow);
    fireEvent.click(screen.getByRole("button", { name: "จัดการ (Actions)" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "ติดตั้งใหม่ (Redeploy)" }));
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
      fireEvent.click(within(pickB.closest("tr")!).getByRole("button", { name: "จัดการ (Actions)" }));
      const menuB = within(await screen.findByRole("menu")).getAllByRole("menuitem").map((el) => el.textContent ?? "");
      expect(menuB).not.toContain("ลองใหม่ (Retry)");
      expect(menuB).not.toContain("กู้คืน (Recover, Owner)");
      fireEvent.click(document.body);
      const aside = detailLabels();
      if (me.role === "owner") {
        expect(aside).toContain("กู้คืน (Recover, Owner)");
        expect(aside).not.toContain("ลองใหม่ (Retry)");
      } else {
        expect(aside).not.toContain("กู้คืน (Recover, Owner)");
        expect(aside).not.toContain("ลองใหม่ (Retry)");
      }
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
  const chooseRowInstall = async (domain: string) => {
    fireEvent.click(within(await rowOf(domain)).getByRole("button", { name: "จัดการ (Actions)" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "ติดตั้ง (Install)" }));
  };
  const postsToB = () => requests.filter((r) => r.method === "POST" && r.path === "/api/brands/brand-b/install");

  it("a row deploy on another brand selects it and tracks the install like the detail button", async () => {
    serveTwoBrands(() => json({ install_id: "op-b", brand_id: "brand-b", status: "running" }, 201));
    render(<BrandLifecycle me={owner} />);
    await screen.findAllByRole("button", { name: "จัดการ (Actions)" });
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
    await screen.findAllByRole("button", { name: "จัดการ (Actions)" });
    await chooseRowInstall("brand-b.test");
    await waitFor(() => expect(postsToB()).toHaveLength(1));
    // Selecting the brand by row click mid-flight must not enable a second Install.
    fireEvent.click(await screen.findByRole("button", { name: /brand-b\.test/ }));
    await waitFor(() => expect(document.querySelector(".brands-aside")!.textContent).toContain("brand-b.test"));
    const detailInstall = [...document.querySelector(".brands-aside")!.querySelectorAll("button")].find((el) => el.textContent === "ติดตั้ง (Install)");
    expect(detailInstall === undefined || (detailInstall as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(await rowOf("brand-b.test")).getByRole("button", { name: "จัดการ (Actions)" }));
    expect(within(await screen.findByRole("menu")).queryByRole("menuitem", { name: "ติดตั้ง (Install)" })).toBeNull();
    fireEvent.mouseDown(document.body);
    expect(postsToB()).toHaveLength(1);
    releaseB(json({ install_id: "op-b", brand_id: "brand-b", status: "running" }, 201));
    await waitFor(() => expect(document.body.textContent).toContain("op-b"));
    expect(postsToB()).toHaveLength(1);
  });

  it("a brand without a form artifact has no menu Install and sends no POST", async () => {
    serveBrand(base("brand-c", "draft", { bundle_form_version: null, payload_version: null }));
    render(<BrandLifecycle me={owner} />);
    await screen.findByRole("button", { name: "จัดการ (Actions)" });
    expect(await openRowMenu()).not.toContain("ติดตั้ง (Install)");
    expect((within(document.querySelector(".brands-aside")!).getByRole("button", { name: "ติดตั้ง (Install)" }) as HTMLButtonElement).disabled).toBe(true);
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("Copy Final URL from the row copies the same URL as the detail button", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    serveBrand(base("brand-a", "live"));
    render(<BrandLifecycle me={owner} />);
    await screen.findByRole("button", { name: "จัดการ (Actions)" });
    fireEvent.click(screen.getByRole("button", { name: "จัดการ (Actions)" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /คัดลอก Final URL/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://brand-a.test/?keyword={keyword}"));
    writeText.mockClear();
    fireEvent.click(within(document.querySelector(".brands-aside")!).getByRole("button", { name: /คัดลอก Final URL/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://brand-a.test/?keyword={keyword}"));
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
      await screen.findAllByRole("button", { name: "จัดการ (Actions)" });
      fireEvent.click(within((await rowOf("brand-b.test"))).getByRole("button", { name: "จัดการ (Actions)" }));
      const menuB = within(await screen.findByRole("menu")).getAllByRole("menuitem").map((el) => el.textContent ?? "").sort();
      fireEvent.mouseDown(document.body);
      fireEvent.click(await screen.findByRole("button", { name: /brand-b\.test/ }));
      await waitFor(() => expect(document.querySelector(".brands-aside")!.textContent).toContain("brand-b.test"));
      // Retry needs the install detail only the selected row has, so it is the one label the detail adds for a failed install.
      // The detail hides deploy buttons while its history recovers, so wait until it settles on the menu's labels.
      await waitFor(() => expect(detailLabels().filter((label) => label !== "ลองใหม่ (Retry)")).toEqual(menuB));
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
    await screen.findAllByRole("button", { name: "จัดการ (Actions)" });
    fireEvent.click(within(await rowOf("brand-b.test")).getByRole("button", { name: "จัดการ (Actions)" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "ย้อนกลับ (Rollback)" }));
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
    await screen.findAllByRole("button", { name: "จัดการ (Actions)" });
    await chooseRowInstall("brand-b.test");
    await waitFor(() => expect(document.querySelector(".brands-aside")!.textContent).toContain("brand-b.test"));
    await waitFor(() => expect(requests.some((r) => r.path === "/api/brands/brand-b/installs")).toBe(true));
    expect(postsToB()).toHaveLength(0);
    releaseInstalls();
    await waitFor(() => expect(postsToB()).toHaveLength(1));
  });
});
