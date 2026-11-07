import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleBrandSummary } from "@anjuna/contracts";
import { BrandLifecycle } from "../src/client/screens/BrandLifecycle";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const employee = { ...owner, id: "employee", role: "employee" as const };

const lifecycle = (id: string, host: string) => LifecycleBrandSummary.parse({
  brand_id: id, name: id, account: "test-account", hostnames: [host], status: "live", current_revision_id: "rev-1",
  runtime_sync_status: "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01",
  latest_install: { install_id: `inst-${id}`, operation: "install", status: "ready", started_at: "2026-10-05T00:00:00.000Z", finished_at: "2026-10-05T00:00:00.000Z", started_by: "owner" },
});
const runtimeRow = (id: string) => ({ brand_id: id, hostnames: [`${id}.test`], status: "live", flow_gate_mode: "param", ab_config: null, form_version: null, stats_7d: { leads: 0, sold: 0, pending: 0 } });
const ITEMS = ["drain_route", "leadsgate_postbacks", "test_sold", "final_url"] as const;
const rows = (items: readonly string[]) => items.map((item) => ({ item, evidence: {} }));
const everything = rows(ITEMS);

type Handler = (init?: RequestInit) => Response | Promise<Response>;
let routes: Map<string, Handler>;
let requests: string[];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Serves the given live brands and a batch checklist read; every brand also gets the detail routes the selected one asks for. */
type Entry = { checklist: Array<{ item: string; evidence: unknown }>; template_approved: boolean; template_waiting_id?: string | null; unknown?: boolean };
function serve(brandIds: string[], batch: Record<string, Entry> | "fail") {
  const list = brandIds.map((id) => lifecycle(id, `${id}.test`));
  routes.set("GET /api/lifecycle/brands", () => json({ brands: list }));
  routes.set("GET /api/brands", () => json({ brands: brandIds.map(runtimeRow), generated_at: "2026-10-06T00:00:00Z" }));
  routes.set("GET /api/brands/checklists", () => (batch === "fail" ? json({ error: "core_unavailable" }, 502) : json({ brands: batch })));
  for (const id of brandIds) {
    routes.set(`GET /api/brands/${id}/checklist`, () => json({ brand_id: id, checklist: [] }));
    routes.set(`GET /api/brands/${id}/installs`, () => json({ brand_id: id, installs: [] }));
    routes.set(`GET /api/brands/${id}/revisions`, () => json({ brand_id: id, current_revision_id: "rev-1", rollback_target_revision_id: null, revisions: [] }));
  }
}

beforeEach(() => {
  requests = [];
  routes = new Map<string, Handler>([["GET /api/upgrade-all/latest", () => json({ upgrade: null })]]);
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push(`${method} ${input}`);
    if (input.startsWith("/api/funnel?")) return json({ from: "2026-10-01T00:00:00.000Z", to: "2026-10-07T00:00:00.000Z", rows: [] });
    const handler = routes.get(`${method} ${input}`);
    if (!handler) throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
    return handler(init);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const tableRow = (host: string) => [...document.querySelectorAll<HTMLElement>(".brand-table tbody tr")].find((tr) => tr.querySelector("button.brand-pick b")?.textContent === host);
const primary = (host: string) => tableRow(host)?.querySelector<HTMLButtonElement>("button.row-primary");
const chipButton = (label: RegExp) => within(screen.getByRole("group", { name: "ตัวกรองแบรนด์" })).getByRole("button", { name: label });
const names = () => [...document.querySelectorAll(".brand-table button.brand-pick b")].map((b) => b.textContent);

describe("Brands screen reads the checklists in one request", () => {
  it("reads the batch once per list load and the per-brand checklist only for the selected brand", async () => {
    serve(["a", "b", "c"], { a: { checklist: everything, template_approved: true }, b: { checklist: everything, template_approved: true }, c: { checklist: everything, template_approved: true } });
    render(<BrandLifecycle me={owner} />);
    await waitFor(() => expect(primary("a.test")).toBeTruthy());
    const count = (path: string) => requests.filter((r) => r === `GET ${path}`).length;
    // Every list load carries one batch read, so the two counts match whatever the number of loads.
    expect(count("/api/brands/checklists")).toBeGreaterThan(0);
    expect(count("/api/brands/checklists")).toBe(count("/api/lifecycle/brands"));
    // One detail read for the selected brand; the other two brands are never asked for one.
    expect(new Set(requests.filter((r) => /^GET \/api\/brands\/[^/]+\/checklist$/.test(r))).size).toBe(1);
  });

  it("puts a live brand with any open checklist item under ต้องแก้ and keeps it under ใช้งาน", async () => {
    serve(["a", "b"], { a: { checklist: everything, template_approved: true }, b: { checklist: rows(["drain_route", "test_sold"]), template_approved: true } });
    render(<BrandLifecycle me={owner} />);
    await waitFor(() => expect(chipButton(/^ต้องแก้/).textContent).toContain("1"));
    expect(chipButton(/^ใช้งาน/).textContent).toContain("2");
    chipButton(/^ต้องแก้/).click();
    await waitFor(() => expect(names()).toEqual(["b.test"]));
  });

  it("leaves ต้องแก้ empty when every live brand has all four items", async () => {
    serve(["a", "b"], { a: { checklist: everything, template_approved: true }, b: { checklist: everything, template_approved: true } });
    render(<BrandLifecycle me={owner} />);
    await waitFor(() => expect(names()).toHaveLength(2));
    expect(chipButton(/^ต้องแก้/).textContent).toContain("0");
  });

  it("raises nothing when the checklist read fails: unknown never counts as failing", async () => {
    serve(["a", "b"], "fail");
    render(<BrandLifecycle me={owner} />);
    await waitFor(() => expect(names()).toHaveLength(2));
    expect(chipButton(/^ต้องแก้/).textContent).toContain("0");
    expect(primary("a.test")!.dataset.nextAction).toBe("open");
    expect(primary("b.test")!.dataset.nextAction).toBe("open");
  });

  it("offers set-route when a live brand has no drain route; an employee sees it disabled with the reason", async () => {
    serve(["a"], { a: { checklist: rows(["leadsgate_postbacks", "test_sold", "final_url"]), template_approved: true } });
    render(<BrandLifecycle me={owner} />);
    await waitFor(() => expect(primary("a.test")!.dataset.nextAction).toBe("set-route"));
    expect(primary("a.test")).toMatchObject({ textContent: "ตั้งเส้นทาง", disabled: false });
    cleanup();

    render(<BrandLifecycle me={employee} />);
    await waitFor(() => expect(primary("a.test")!.dataset.nextAction).toBe("set-route"));
    expect(primary("a.test")!.disabled).toBe(true);
    expect(primary("a.test")!.title).toBe("เฉพาะเจ้าของตั้งเส้นทางได้");
  });

  it("offers test-sold when the drain route is set and the test sale is not confirmed", async () => {
    serve(["a"], { a: { checklist: rows(["drain_route", "leadsgate_postbacks", "final_url"]), template_approved: true } });
    render(<BrandLifecycle me={employee} />);
    await waitFor(() => expect(primary("a.test")!.dataset.nextAction).toBe("test-sold"));
    expect(primary("a.test")).toMatchObject({ textContent: "ยืนยันขายทดสอบ", disabled: false });
  });

  it("offers approve-template while the brand's template waits for approval, to the owner only", async () => {
    serve(["a"], { a: { checklist: everything, template_approved: false } });
    render(<BrandLifecycle me={owner} />);
    await waitFor(() => expect(primary("a.test")!.dataset.nextAction).toBe("approve-template"));
    expect(primary("a.test")).toMatchObject({ textContent: "อนุมัติเทมเพลต", disabled: false });
    cleanup();

    render(<BrandLifecycle me={employee} />);
    await waitFor(() => expect(primary("a.test")!.dataset.nextAction).toBe("approve-template"));
    expect(primary("a.test")!.disabled).toBe(true);
  });

  it("raises nothing and offers no step for a brand whose checklist is unknown", async () => {
    serve(["a", "b"], { a: { checklist: [], template_approved: true, unknown: true }, b: { checklist: everything, template_approved: true } });
    render(<BrandLifecycle me={owner} />);
    await waitFor(() => expect(names()).toHaveLength(2));
    expect(chipButton(/^ต้องแก้/).textContent).toContain("0");
    expect(primary("a.test")!.dataset.nextAction).toBe("open");
    expect(primary("a.test")!.disabled).toBe(false);
  });

  it("shows the plain open button for a brand with every item done", async () => {
    serve(["a"], { a: { checklist: everything, template_approved: true } });
    render(<BrandLifecycle me={owner} />);
    await waitFor(() => expect(primary("a.test")).toBeTruthy());
    expect(primary("a.test")).toMatchObject({ textContent: "ดูแบรนด์", disabled: false });
    expect(primary("a.test")!.dataset.nextAction).toBe("open");
  });
});
