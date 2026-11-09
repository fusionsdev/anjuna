import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PANEL_ROLE_TABLE } from "../src/server/panel-roles";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;

beforeAll(async () => {
  await setupDatabases();
});
beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const AT = "2026-01-02T03:04:05.000Z";
const view = {
  id: JOB_ID, status: "queued", mode: "read", line: "manage google accounts list", output: null, error: null,
  requested_by: "u1", created_at: AT, updated_at: AT,
};

/** A core stand-in that records each request. */
function fakeCore() {
  const seen: Array<{ path: string; method: string; role: string | null; body: unknown }> = [];
  const fetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    const body = request.method === "GET" ? null : await request.json();
    seen.push({ path: url.pathname, method: request.method, role: request.headers.get("x-actor-role"), body });
    if (url.pathname === "/admin/adkit/terminal") {
      const mode = (body as { mode: string }).mode;
      return Response.json({ preview: false, argv: ["manage", "google", "accounts", "list", "--json"], mode, job: view }, { status: 201 });
    }
    return Response.json({ job: view });
  });
  return { seen, fetch, env: makeEnv({ MOCK_CORE: "0", CORE: { fetch } as unknown as Fetcher }) };
}

const line = { line: "manage google accounts list", mode: "read" };

describe("panel AdKit Terminal routes (T13-6)", () => {
  it("the panel role table makes the Terminal owner only", () => {
    expect(PANEL_ROLE_TABLE.useTerminal).toBe("owner");
  });

  it("an employee gets 403 on both routes and core is never called", async () => {
    const core = fakeCore();
    const post = await call("/api/adkit/terminal", { cookie: employee, method: "POST", body: line, env: core.env });
    expect(post.status).toBe(403);
    expect(await post.json()).toMatchObject({ error: "forbidden_role", required_role: "owner" });
    const get = await call(`/api/adkit/jobs/${JOB_ID}`, { cookie: employee, env: core.env });
    expect(get.status).toBe(403);
    expect(core.fetch).not.toHaveBeenCalled();
  });

  it("an owner line goes to core with the owner role; the job is read back by id", async () => {
    const core = fakeCore();
    const post = await call("/api/adkit/terminal", { cookie: owner, method: "POST", body: { ...line, dry_run: false }, env: core.env });
    expect(post.status).toBe(201);
    expect(core.seen[0]).toMatchObject({ path: "/admin/adkit/terminal", method: "POST", role: "owner", body: { ...line, dry_run: false } });
    const get = await call(`/api/adkit/jobs/${JOB_ID}`, { cookie: owner, env: core.env });
    expect(get.status).toBe(200);
    expect(core.seen[1]).toMatchObject({ path: `/admin/adkit/jobs/${JOB_ID}`, method: "GET", role: "owner" });
  });

  it("a body that is not {line, mode} is 422 and core is not called", async () => {
    const core = fakeCore();
    for (const body of [{}, { line: "x" }, { line: "x", mode: "root" }, { ...line, kind: "campaign.enable" }]) {
      const r = await call("/api/adkit/terminal", { cookie: owner, method: "POST", body, env: core.env });
      expect(r.status).toBe(422);
    }
    expect(core.fetch).not.toHaveBeenCalled();
  });
});
