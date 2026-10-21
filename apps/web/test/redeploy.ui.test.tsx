import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleBrandSummary, type InstallWithReceipts } from "@anjuna/contracts";
import { BrandLifecycle } from "../src/client/screens/BrandLifecycle";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const employee = { ...owner, id: "employee", role: "employee" as const };
const redeployName = "ติดตั้งใหม่ (Redeploy)";
const latestName = "ติดตั้งใหม่พร้อมฟอร์มล่าสุด (Redeploy with latest form)";
const newerForm = { form_artifact_id: "fa-2", bundle_form_version: "form@abcdef2" };
const liveBrand = LifecycleBrandSummary.parse({
  brand_id: "brand-a", account: "test-account", hostnames: ["renderable.test", "www.renderable.test"],
  status: "live", current_revision_id: "rev-1", runtime_sync_status: "ready",
  bundle_form_version: "form@abcdef1", payload_version: "2026-01",
});
const running: InstallWithReceipts = {
  install_id: "redeploy-ins", brand_id: "brand-a", revision_id: "rev-2", status: "running",
  runtime_sync_status: "running", receipts: [{ step: "validate", status: "ready" }, { step: "render", status: "running" }],
};

type Handler = (init?: RequestInit) => Response | Promise<Response>;
let routes: Map<string, Handler>;
let requests: Array<{ method: string; path: string }>;
let confirm: ReturnType<typeof vi.fn>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const showBrand = (overrides: Partial<LifecycleBrandSummary>, installs: unknown[] = []) => {
  routes.set("GET /api/lifecycle/brands", () => json({ brands: [{ ...liveBrand, ...overrides }] }));
  routes.set("GET /api/brands/brand-a/installs", () => json({ brand_id: "brand-a", installs }));
};
const redeployPosts = () => requests.filter((r) => r.method === "POST" && r.path === "/api/brands/brand-a/redeploy");

beforeEach(() => {
  requests = [];
  confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  routes = new Map<string, Handler>([
    ["GET /api/upgrade-all/latest", () => json({ upgrade: null })],
    ["GET /api/templates/sealed", () => json({ templates: [] })],
    ["GET /api/brands", () => json({ brands: [], generated_at: "2026-10-06T00:00:00Z" })],
    ["GET /api/brands/brand-a/checklist", () => json({ brand_id: "brand-a", checklist: [] })],
    ["GET /api/installs/redeploy-ins", () => json(running)],
    ["POST /api/brands/brand-a/redeploy", () => json({ install_id: "redeploy-ins", brand_id: "brand-a", status: "running" }, 201)],
  ]);
  showBrand({});
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, path: input });
    const handler = routes.get(`${method} ${input}`);
    if (!handler) throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
    return handler(init);
  }));
});

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Redeploy button in the brand detail", () => {
  it("is offered to an Owner for a live brand", async () => {
    render(<BrandLifecycle me={owner} />);
    expect(await screen.findByRole("button", { name: redeployName })).toBeTruthy();
  });

  it("is not offered to an Employee", async () => {
    render(<BrandLifecycle me={employee} />);
    await screen.findByRole("heading", { name: /renderable.test/ });
    expect(screen.queryByRole("button", { name: redeployName })).toBeNull();
  });

  it.each(["draft", "failed", "installing", "paused"] as const)("is not offered to an Owner for a %s brand", async (status) => {
    showBrand({ status } as Partial<LifecycleBrandSummary>);
    render(<BrandLifecycle me={owner} />);
    await screen.findByRole("heading", { name: /renderable.test/ });
    expect(screen.queryByRole("button", { name: redeployName })).toBeNull();
  });

  it("is hidden while an install of the brand is running", async () => {
    showBrand({}, [{ install_id: "redeploy-ins", status: "running", error: null }]);
    render(<BrandLifecycle me={owner} />);
    await screen.findAllByText("redeploy-ins", { selector: "code" });
    expect(screen.queryByRole("button", { name: redeployName })).toBeNull();
  });

  it("asks for confirmation and sends nothing when the Owner declines", async () => {
    confirm.mockReturnValue(false);
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: redeployName }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String(confirm.mock.calls[0]![0])).toContain("Redeploy");
    expect(redeployPosts()).toHaveLength(0);
  });

  it("posts the redeploy once after confirmation and shows the new install with its receipts", async () => {
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: redeployName }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect((await screen.findAllByText("redeploy-ins", { selector: "code" })).length).toBeGreaterThan(0);
    expect(redeployPosts()).toHaveLength(1);
    expect(await screen.findByText("สร้างหน้าเว็บ (Render)")).toBeTruthy();
    expect(screen.getByText("ตรวจสอบข้อมูล (Validate)")).toBeTruthy();
    expect(requests.some((r) => r.path === "/api/installs/redeploy-ins")).toBe(true);
    // The run is active, so no second redeploy can be started from the screen.
    await waitFor(() => expect(screen.queryByRole("button", { name: redeployName })).toBeNull());
  });
});

describe("Redeploy with the latest form in the brand detail", () => {
  let bodies: unknown[];
  beforeEach(() => {
    bodies = [];
    showBrand({ newer_form: newerForm });
    routes.set("POST /api/brands/brand-a/redeploy", (init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json({ install_id: "redeploy-ins", brand_id: "brand-a", status: "running" }, 201);
    });
  });

  it("is offered next to Redeploy to an Owner when a newer compatible form exists", async () => {
    render(<BrandLifecycle me={owner} />);
    expect(await screen.findByRole("button", { name: latestName })).toBeTruthy();
    expect(screen.getByRole("button", { name: redeployName })).toBeTruthy();
  });

  it("is not offered when the brand already runs the newest form", async () => {
    showBrand({});
    render(<BrandLifecycle me={owner} />);
    await screen.findByRole("button", { name: redeployName });
    expect(screen.queryByRole("button", { name: latestName })).toBeNull();
  });

  it("is not offered to an Employee", async () => {
    render(<BrandLifecycle me={employee} />);
    await screen.findByRole("heading", { name: /renderable.test/ });
    expect(screen.queryByRole("button", { name: latestName })).toBeNull();
  });

  it.each(["draft", "failed", "installing", "paused"] as const)("is not offered to an Owner for a %s brand", async (status) => {
    showBrand({ status, newer_form: newerForm } as Partial<LifecycleBrandSummary>);
    render(<BrandLifecycle me={owner} />);
    await screen.findByRole("heading", { name: /renderable.test/ });
    expect(screen.queryByRole("button", { name: latestName })).toBeNull();
  });

  it("is hidden while an install of the brand is running", async () => {
    showBrand({ newer_form: newerForm }, [{ install_id: "redeploy-ins", status: "running", error: null }]);
    render(<BrandLifecycle me={owner} />);
    await screen.findAllByText("redeploy-ins", { selector: "code" });
    expect(screen.queryByRole("button", { name: latestName })).toBeNull();
  });

  it("names the target form version and the current one in the confirm text, and sends nothing when declined", async () => {
    confirm.mockReturnValue(false);
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: latestName }));
    expect(confirm).toHaveBeenCalledTimes(1);
    const text = String(confirm.mock.calls[0]![0]);
    expect(text).toContain("form@abcdef2");
    expect(text).toContain("form@abcdef1");
    expect(text).toContain("Redeploy");
    expect(redeployPosts()).toHaveLength(0);
  });

  it("posts the chosen artifact once after confirmation and shows the new install", async () => {
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: latestName }));
    expect((await screen.findAllByText("redeploy-ins", { selector: "code" })).length).toBeGreaterThan(0);
    expect(redeployPosts()).toHaveLength(1);
    expect(bodies).toEqual([{ form_artifact_id: "fa-2" }]);
    await waitFor(() => expect(screen.queryByRole("button", { name: latestName })).toBeNull());
  });

  it("the plain Redeploy button still keeps the current form", async () => {
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: redeployName }));
    expect((await screen.findAllByText("redeploy-ins", { selector: "code" })).length).toBeGreaterThan(0);
    expect(bodies).toEqual([{}]);
  });
});

describe("the operation label in the receipts panel", () => {
  // The first line under the Install progress heading, not the install ID line that tracks a pending operation.
  const receiptsLine = async () => (await screen.findByRole("heading", { name: /Install progress/ })).parentElement!.querySelector("p")!;
  it.each([
    ["install", "ติดตั้ง (Install)"],
    ["rollback", "ย้อนกลับ (Rollback)"],
    ["upgrade", "อัปเกรดทุกแบรนด์ (Upgrade-all)"],
    ["redeploy", "ติดตั้งใหม่ (Redeploy)"],
  ] as const)("shows %s as %s next to the install ID", async (operation, label) => {
    showBrand({}, [{ install_id: "redeploy-ins", status: "ready", error: null, operation }]);
    routes.set("GET /api/installs/redeploy-ins", () => json({ ...running, status: "ready", runtime_sync_status: "ready", operation }));
    render(<BrandLifecycle me={owner} />);
    expect((await receiptsLine()).textContent).toBe(`รหัสติดตั้ง (Install ID): redeploy-ins · ${label}`);
  });

  it("shows no label for an install the server did not label", async () => {
    showBrand({}, [{ install_id: "redeploy-ins", status: "ready", error: null }]);
    routes.set("GET /api/installs/redeploy-ins", () => json({ ...running, status: "ready", runtime_sync_status: "ready" }));
    render(<BrandLifecycle me={owner} />);
    expect((await receiptsLine()).textContent).toBe("รหัสติดตั้ง (Install ID): redeploy-ins");
  });
});

describe("Redeploy of a brand that core reports as paused", () => {
  // Pause lives in core. The factory brand stays live, so the lifecycle row says live and only the runtime row says paused.
  const pausedInCore = () => routes.set("GET /api/brands", () => json({ brands: [{
    brand_id: "brand-a", hostnames: ["renderable.test"], status: "paused", flow_gate_mode: "param", ab_config: null,
    form_version: "form@abcdef1", stats_7d: { leads: 0, sold: 0, pending: 0 },
  }], generated_at: "2026-10-06T00:00:00Z" }));
  const stays = "ยังคงหยุดชั่วคราว (The brand stays paused.)";
  let bodies: unknown[];
  beforeEach(() => {
    bodies = [];
    showBrand({ newer_form: newerForm });
    pausedInCore();
    routes.set("POST /api/brands/brand-a/redeploy", (init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json({ install_id: "redeploy-ins", brand_id: "brand-a", status: "running" }, 201);
    });
  });

  it("offers both buttons to an Owner", async () => {
    render(<BrandLifecycle me={owner} />);
    expect(await screen.findByRole("button", { name: redeployName })).toBeTruthy();
    expect(screen.getByRole("button", { name: latestName })).toBeTruthy();
    expect(await screen.findByText("สถานะ runtime: paused")).toBeTruthy();
  });

  it("offers neither to an Employee", async () => {
    render(<BrandLifecycle me={employee} />);
    await screen.findByRole("heading", { name: /renderable.test/ });
    expect(screen.queryByRole("button", { name: redeployName })).toBeNull();
    expect(screen.queryByRole("button", { name: latestName })).toBeNull();
  });

  it.each(["draft", "failed", "installing"] as const)("still offers neither for a %s brand", async (status) => {
    showBrand({ status, newer_form: newerForm } as Partial<LifecycleBrandSummary>);
    render(<BrandLifecycle me={owner} />);
    await screen.findByRole("heading", { name: /renderable.test/ });
    expect(screen.queryByRole("button", { name: redeployName })).toBeNull();
    expect(screen.queryByRole("button", { name: latestName })).toBeNull();
  });

  it("says in the Redeploy confirm text that the brand stays paused", async () => {
    confirm.mockReturnValue(false);
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: redeployName }));
    expect(String(confirm.mock.calls[0]![0])).toContain(stays);
  });

  it("says in the Redeploy with latest form confirm text that the brand stays paused", async () => {
    confirm.mockReturnValue(false);
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: latestName }));
    expect(String(confirm.mock.calls[0]![0])).toContain(stays);
  });

  it("does not say it for a brand that is not paused", async () => {
    routes.set("GET /api/brands", () => json({ brands: [], generated_at: "2026-10-06T00:00:00Z" }));
    confirm.mockReturnValue(false);
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: redeployName }));
    expect(String(confirm.mock.calls[0]![0])).not.toContain("paused");
  });

  it("posts the redeploy for a paused brand", async () => {
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: redeployName }));
    expect((await screen.findAllByText("redeploy-ins", { selector: "code" })).length).toBeGreaterThan(0);
    expect(redeployPosts()).toHaveLength(1);
    expect(bodies).toEqual([{}]);
  });
});
