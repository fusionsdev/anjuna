import { timingSafeEqual } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AdminRequestContext } from "@anjuna/contracts";
import { parseTerminalLine } from "../src/adkit-terminal.js";
import { createHarness, DRAIN_TOKEN, type Harness } from "./helpers.js";

const owner: AdminRequestContext = { actor_id: "usr_owner_01", actor_role: "owner", request_id: "req_term_owner" };
const employee: AdminRequestContext = { actor_id: "usr_emp_01", actor_role: "employee", request_id: "req_term_emp" };
const ACCOUNT = "4811219623";
const DRAFT_DATA = '{"campaigns":[{"name":"petvet-search-1","type":"SEARCH"}]}';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  const subtle = crypto.subtle as unknown as { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean };
  subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(a, b);
});
afterAll(async () => { await h?.mf.dispose(); });
beforeEach(async () => { await h.db.prepare("DELETE FROM adkit_jobs").run(); });

const rows = async () => (await h.db.prepare("SELECT COUNT(*) AS n FROM adkit_jobs").first<{ n: number }>())!.n;
const post = (body: Record<string, unknown>, context = owner) => h.admin("/admin/adkit/terminal", context, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const readJob = (id: string, context = owner) => h.admin(`/admin/adkit/jobs/${id}`, context);
const auth = { Authorization: `Bearer ${DRAIN_TOKEN}`, "Content-Type": "application/json" };
const vps = (path: string, body?: unknown) => h.request(`/api/adkit/${path}`, body === undefined ? { headers: auth } : {
  method: "POST", headers: auth, body: JSON.stringify(body),
});

describe("parseTerminalLine", () => {
  it("accepts manage google accounts list in read mode", () => {
    expect(parseTerminalLine("manage google accounts list", "read")).toEqual({
      ok: true, argv: ["manage", "google", "accounts", "list", "--json"], mode: "read",
    });
  });

  it("refuses campaigns create in read mode and says to switch to draft mode", () => {
    const v = parseTerminalLine(`manage google campaigns create --account ${ACCOUNT} --data '${DRAFT_DATA}'`, "read");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("สลับเป็นโหมดร่าง");
    const bare = parseTerminalLine("manage google campaigns create ...", "read");
    expect(!bare.ok && bare.reason).toContain("สลับเป็นโหมดร่าง");
  });

  it.each([
    "rm -rf /",
    "manage google platform-api-request --account 4811219623",
    "manage google accounts list; rm -rf /",
    "manage google accounts list && echo hi",
    "manage google accounts list | cat",
    "manage google accounts list `id`",
    "manage google accounts list\nmanage google accounts list",
    "manage google accounts list $(id)",
  ])("refuses %j in every mode", (line) => {
    for (const mode of ["read", "draft", "publish"] as const) expect(parseTerminalLine(line, mode).ok, mode).toBe(false);
  });

  it("draft mode takes a create, publish mode takes a pause and refuses an ENABLED update", () => {
    expect(parseTerminalLine(`manage google campaigns create --account ${ACCOUNT} --data '${DRAFT_DATA}'`, "draft").ok).toBe(true);
    const update = (status: string) => `manage google campaigns update --account ${ACCOUNT} --campaign 77 --data '{"status":"${status}"}' --publish`;
    expect(parseTerminalLine(update("PAUSED"), "publish").ok).toBe(true);
    expect(parseTerminalLine(update("PAUSED"), "draft").ok).toBe(false);
    expect(parseTerminalLine(update("ENABLED"), "publish").ok).toBe(false);
  });
});

describe("POST /admin/adkit/terminal", () => {
  it("an employee gets 403 and no row exists", async () => {
    const response = await post({ line: "manage google accounts list", mode: "read" }, employee);
    expect(response.status).toBe(403);
    expect(await rows()).toBe(0);
  });

  it.each([
    "rm -rf /",
    "manage google platform-api-request --account 4811219623",
    "manage google accounts list; ls",
    "manage google accounts list && ls",
    "manage google accounts list | cat",
    "manage google accounts list `id`",
  ])("refuses %j with 422 before a job row exists", async (line) => {
    const response = await post({ line, mode: "read" });
    expect(response.status).toBe(422);
    expect(await rows()).toBe(0);
  });

  it("a draft create in read mode is 422 with the Thai hint and no row", async () => {
    const response = await post({ line: `manage google campaigns create --account ${ACCOUNT} --data '${DRAFT_DATA}'`, mode: "read" });
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain("สลับเป็นโหมดร่าง");
    expect(await rows()).toBe(0);
  });

  it("a dry run answers the argv and writes nothing; publish needs confirm", async () => {
    const dry = await post({ line: "manage google accounts list", mode: "read", dry_run: true });
    expect(dry.status).toBe(200);
    expect(await dry.json()).toMatchObject({ preview: true, argv: ["manage", "google", "accounts", "list", "--json"], job: null });
    const line = `manage google campaigns update --account ${ACCOUNT} --campaign 77 --data '{"status":"PAUSED"}' --publish`;
    expect((await post({ line, mode: "publish" })).status).toBe(422);
    expect(await rows()).toBe(0);
    expect((await post({ line, mode: "publish", confirm: true })).status).toBe(201);
    expect(await rows()).toBe(1);
  });

  it("an allowed line queues a terminal.run job and an audit row, and the VPS can claim it", async () => {
    const response = await post({ line: "adkit manage google accounts list", mode: "read" });
    expect(response.status).toBe(201);
    const { job } = await response.json() as { job: { id: string; status: string; mode: string; output: string | null } };
    expect(job).toMatchObject({ status: "queued", mode: "read", output: null });
    const stored = await h.db.prepare("SELECT kind, payload, requested_by FROM adkit_jobs WHERE id = ?1").bind(job.id)
      .first<{ kind: string; payload: string; requested_by: string }>();
    expect(stored!.kind).toBe("terminal.run");
    expect(stored!.requested_by).toBe("usr_owner_01");
    expect(JSON.parse(stored!.payload).argv).toEqual(["manage", "google", "accounts", "list", "--json"]);
    const audit = await h.factory.prepare("SELECT actor_id FROM audit_log WHERE action = 'adkit.terminal.run' AND entity_id = ?1").bind(job.id).all();
    expect(audit.results).toHaveLength(1);

    const pending = await (await vps("jobs/pending")).json() as { jobs: Array<{ id: string; kind: string }> };
    expect(pending.jobs).toEqual([expect.objectContaining({ id: job.id, kind: "terminal.run" })]);
    expect((await vps("jobs/claim", { job_id: job.id })).status).toBe(200);
  });
});

describe("terminal job result", () => {
  async function claimedJob() {
    const created = await (await post({ line: "manage google accounts list", mode: "read" })).json() as { job: { id: string } };
    const claim = await (await vps("jobs/claim", { job_id: created.job.id })).json() as { claim_id: string };
    return { id: created.job.id, claimId: claim.claim_id };
  }

  it("stores a masked output, serves it cut at 20 KB, and an employee cannot read it", async () => {
    const { id, claimId } = await claimedJob();
    const output = `{"gclid":"CjwKCAjw-SECRET-CLICK","access_token":"ya29.SECRET"}\nBearer abc.SECRETDEF\n${"line of output\n".repeat(3000)}`;
    const done = await vps("jobs/result", { job_id: id, claim_id: claimId, result: { output } });
    expect(done.status).toBe(200);
    expect(await (await vps("jobs/result", { job_id: id, claim_id: claimId, result: { output } })).json()).toMatchObject({ status: "done", already: true });

    const read = await readJob(id);
    expect(read.status).toBe(200);
    const { job } = await read.json() as { job: { status: string; output: string } };
    expect(job.status).toBe("done");
    expect(job.output).not.toMatch(/SECRET/);
    expect(new TextEncoder().encode(job.output).length).toBeLessThanOrEqual(20 * 1024);
    const raw = await h.db.prepare("SELECT result FROM adkit_jobs WHERE id = ?1").bind(id).first<{ result: string }>();
    expect(raw!.result).not.toMatch(/SECRET/);

    expect((await readJob(id, employee)).status).toBe(403);
  });

  it("a failed terminal job is never retried and its error is masked", async () => {
    const { id, claimId } = await claimedJob();
    const failed = await vps("jobs/result", { job_id: id, claim_id: claimId, error: "boom token=ya29.SECRETTOKEN", retryable: true });
    expect(await failed.json()).toEqual({ status: "failed" });
    const { job } = await (await readJob(id)).json() as { job: { status: string; error: string } };
    expect(job).toMatchObject({ status: "failed" });
    expect(job.error).not.toContain("SECRETTOKEN");
    const pending = await (await vps("jobs/pending")).json() as { jobs: unknown[] };
    expect(pending.jobs).toEqual([]);
  });

  it("an expired claim fails the job and never hands it to a second claim", async () => {
    const { id } = await claimedJob();
    await h.db.prepare("UPDATE adkit_jobs SET claimed_at = ?2 WHERE id = ?1").bind(id, new Date(Date.now() - 3 * 3600_000).toISOString()).run();
    const pending = await (await vps("jobs/pending")).json() as { jobs: unknown[] };
    expect(pending.jobs).toEqual([]);
    expect((await vps("jobs/claim", { job_id: id })).status).toBe(409);
    const { job } = await (await readJob(id)).json() as { job: { status: string } };
    expect(job.status).toBe("failed");
  });

  it("GET /admin/adkit/jobs/:id is 404 for a job of another kind and for an unknown id", async () => {
    await h.db.prepare(`INSERT INTO adkit_jobs (id, kind, payload, status, attempts, idempotency_key, requested_by, created_at, updated_at, seq)
      VALUES ('99999999-9999-4999-8999-999999999999', 'conversion_action.create', '{}', 'queued', 0, 'k-other-kind', 'u', 'a', 'a', 1)`).run();
    expect((await readJob("99999999-9999-4999-8999-999999999999")).status).toBe(404);
    expect((await readJob("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await readJob("not-a-uuid")).status).toBe(404);
  });
});
