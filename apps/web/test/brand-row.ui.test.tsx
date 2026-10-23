import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleBrandSummary } from "@anjuna/contracts";
import { BrandLifecycle } from "../src/client/screens/BrandLifecycle";
import { answerConfirm } from "./confirm";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const lifecycle = (id: string, host: string, status: string) => LifecycleBrandSummary.parse({
  brand_id: id, account: "test-account", hostnames: [host], status, current_revision_id: "rev-1",
  runtime_sync_status: "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01",
});
const rows = [lifecycle("b-live", "live.example", "live"), lifecycle("b-paused", "paused.example", "paused")];
const runtimeRow = (id: string, status: string, flow_gate_mode: string) => ({
  brand_id: id, hostnames: [`${id}.example`], status, flow_gate_mode, ab_config: null, form_version: null,
  stats_7d: { leads: 0, sold: 0, pending: 0 },
});
const pauseName = "หยุดชั่วคราว (Pause)";
const resumeName = "เปิดใช้งานต่อ (Resume)";

type Handler = (init?: RequestInit) => Response | Promise<Response>;
let routes: Map<string, Handler>;
let requests: Array<{ method: string; path: string }>;
let pauseStatus: number;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const rowOf = async (domain: string) => (await screen.findByRole("button", { name: new RegExp(domain.replace(".", "\\.")) })).closest("tr")!;
const posts = (path: string) => requests.filter((r) => r.method === "POST" && r.path === path);

beforeEach(() => {
  requests = [];
  pauseStatus = 200;
  routes = new Map<string, Handler>([
    ["GET /api/upgrade-all/latest", () => json({ upgrade: null })],
    ["GET /api/lifecycle/brands", () => json({ brands: rows })],
    ["GET /api/brands", () => json({ brands: [runtimeRow("b-live", "live", "param"), runtimeRow("b-paused", "paused", "signed_cookie")], generated_at: "2026-10-06T00:00:00Z" })],
    ["GET /api/funnel", () => json({ from: "2026-10-01T00:00:00.000Z", to: "2026-10-07T00:00:00.000Z", rows: [] })],
    ["POST /api/brands/b-live/pause", () => (pauseStatus === 200 ? json({ ok: true }) : json({ error: "internal" }, pauseStatus))],
    ["POST /api/brands/b-paused/resume", () => json({ ok: true })],
  ]);
  for (const row of rows) {
    routes.set(`GET /api/brands/${row.brand_id}/checklist`, () => json({ brand_id: row.brand_id, checklist: [] }));
    routes.set(`GET /api/brands/${row.brand_id}/installs`, () => json({ brand_id: row.brand_id, installs: [] }));
  }
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, path: input });
    const handler = routes.get(`${method} ${input.startsWith("/api/funnel?") ? "/api/funnel" : input}`);
    if (!handler) throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
    return handler(init);
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("brand row basics", () => {
  it("shows the flow-gate label on each row", async () => {
    render(<BrandLifecycle me={owner} />);
    expect(within(await rowOf("live.example")).getByText("Keyword Param")).toBeTruthy();
    expect(within(await rowOf("paused.example")).getByText("Single Page Cookie")).toBeTruthy();
  });

  it("pauses from the row after a confirm, without selecting the row", async () => {
    render(<BrandLifecycle me={owner} />);
    const live = await rowOf("live.example");
    fireEvent.click(within(live).getByRole("button", { name: pauseName }));
    await answerConfirm(false);
    expect(posts("/api/brands/b-live/pause")).toHaveLength(0);
    fireEvent.click(within(live).getByRole("button", { name: pauseName }));
    await answerConfirm(true);
    await waitFor(() => expect(posts("/api/brands/b-live/pause")).toHaveLength(1));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringContaining("หยุดแบรนด์แล้ว"));
  });

  it("a click on the row action does not select the row", async () => {
    render(<BrandLifecycle me={owner} />);
    const paused = await rowOf("paused.example");
    const pick = within(paused).getByRole("button", { name: /paused\.example/ });
    fireEvent.click(within(paused).getByRole("button", { name: resumeName }));
    await answerConfirm(false);
    expect(pick.getAttribute("aria-current")).toBeNull();
  });

  it("lets an Employee resume a paused brand but not pause a live one", async () => {
    render(<BrandLifecycle me={{ ...owner, role: "employee" }} />);
    expect(within(await rowOf("live.example")).queryByRole("button", { name: pauseName })).toBeNull();
    expect(within(await rowOf("paused.example")).getByRole("button", { name: resumeName })).toBeTruthy();
  });

  it("shows a failed pause as an error toast", async () => {
    pauseStatus = 500;
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(within(await rowOf("live.example")).getByRole("button", { name: pauseName }));
    await answerConfirm(true);
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
