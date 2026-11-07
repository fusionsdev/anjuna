import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdkitJob, type AdminRequestContext } from "@anjuna/contracts";
import { createHarness, DRAIN_TOKEN, fixtureText, type Harness } from "./helpers.js";

const owner: AdminRequestContext = { actor_id: "usr_owner_01", actor_role: "owner", request_id: "req_adkit_owner" };
const employee: AdminRequestContext = { actor_id: "usr_emp_01", actor_role: "employee", request_id: "req_adkit_emp" };

const ACCOUNT = "4811219623";
const PROJECT = "proj_a";
const ACTION = "7300000009";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  const at = "2026-11-01T00:00:00.000Z";
  await h.factory.batch([
    h.factory.prepare(`INSERT INTO templates (template_id, name, framework, created_by, created_at)
      VALUES ('tpl-adkit', 'AdKit test', 'astro', 'usr_owner_01', ?1)`).bind(at),
    h.factory.prepare(`INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at)
      VALUES ('tv-adkit', 'tpl-adkit', 1, 'adkit-sha', 'templates/adkit', 'sealed', 'usr_owner_01', ?1, 'usr_owner_01', ?1)`).bind(at),
    h.factory.prepare(`INSERT INTO form_artifacts (form_artifact_id, git_sha, r2_key, manifest_sha256, created_at, payload_version, bundle_form_version)
      VALUES ('fa-adkit', 'adkit-git', 'forms/adkit', 'adkit-manifest', ?1, '2026-01', 'form@adkit')`).bind(at),
  ]);
});
afterAll(async () => { await h?.mf.dispose(); });

beforeEach(async () => {
  await h.db.batch(["adkit_jobs", "adkit_directory"].map((table) => h.db.prepare(`DELETE FROM ${table}`)));
  await h.factory.batch([
    h.factory.prepare("DELETE FROM brand_revisions WHERE brand_id LIKE 'adkit-%'"),
    h.factory.prepare("DELETE FROM brands WHERE brand_id LIKE 'adkit-%'"),
  ]);
  await seedDraft("adkit-a", { google_ads_account: ACCOUNT, adkit_project: PROJECT });
  await seedDraft("adkit-b", { google_ads_account: "1234567890" });
  await seedDraft("adkit-none", null);
});

async function seedDraft(brandId: string, ads: Record<string, string> | null, status = "draft") {
  const at = "2026-11-01T00:00:00.000Z";
  const config = JSON.stringify({ keyword_default: "Loans", ...(ads ? { profile: { ads } } : {}) });
  await h.factory.batch([
    h.factory.prepare(`INSERT INTO brands (brand_id, name, account, domain, status, created_by, created_at, updated_at)
      VALUES (?1, ?1, 'account-a', ?2, ?3, 'usr_owner_01', ?4, ?4)`).bind(brandId, `${brandId}.example`, status, at),
    h.factory.prepare(`INSERT INTO brand_revisions (revision_id, brand_id, revision, template_version_id, form_artifact_id, config_json, created_by, created_at)
      VALUES (?1, ?2, 1, 'tv-adkit', 'fa-adkit', ?3, 'usr_owner_01', ?4)`).bind(`${brandId}_rev_1`, brandId, config, at),
  ]);
}

const auth = { Authorization: `Bearer ${DRAIN_TOKEN}` };
const vps = (path: string, body?: unknown, headers: Record<string, string> = auth) =>
  h.request(`/api/adkit/${path}`, body === undefined ? { headers } : {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const pending = () => vps("jobs/pending");
const claim = (job_id: string) => vps("jobs/claim", { job_id });
const result = (body: Record<string, unknown>) => vps("jobs/result", body);
const createJob = (body: Record<string, unknown>, context = owner) => h.admin("/admin/adkit/jobs", context, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const jobRow = (id: string) => h.db.prepare("SELECT * FROM adkit_jobs WHERE id = ?1").bind(id).first<Record<string, unknown>>();
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

async function queueJob(brand = "adkit-a") {
  const response = await createJob({ kind: "conversion_action.create", brand_draft_id: brand });
  expect(response.status).toBe(201);
  return AdkitJob.parse(((await response.json()) as { job: unknown }).job);
}

async function claimed(brand = "adkit-a") {
  const job = await queueJob(brand);
  const response = await claim(job.id);
  expect(response.status).toBe(200);
  const body = await response.json() as { claim_id: string };
  return { job, claimId: body.claim_id };
}

describe("auth", () => {
  it("VPS routes answer 401 without the drain token and ignore ?token=", async () => {
    for (const headers of [{}, { Authorization: "Bearer wrong" }] as Array<Record<string, string>>) {
      const responses = [
        await vps("directory/ingest", { items: [] }, headers),
        await vps("jobs/pending", undefined, headers),
        await vps("jobs/claim", { job_id: "11111111-1111-4111-8111-111111111111" }, headers),
        await vps("jobs/result", { job_id: "11111111-1111-4111-8111-111111111111", claim_id: "11111111-1111-4111-8111-111111111111", error: "x" }, headers),
      ];
      for (const response of responses) {
        expect(response.status).toBe(401);
        expect(await response.text()).toBe(fixtureText("drain/unauthorized.response.json"));
      }
    }
    const query = await h.request(`/api/adkit/jobs/pending?token=${DRAIN_TOKEN}`);
    expect(query.status).toBe(401);
  });

  it("admin routes are owner only", async () => {
    for (const [path, init] of [
      ["/admin/adkit/projects", {}],
      [`/admin/adkit/projects/${PROJECT}/accounts`, {}],
      [`/admin/adkit/accounts/${ACCOUNT}/conversion-actions`, {}],
      ["/admin/adkit/jobs", { method: "POST", body: JSON.stringify({ kind: "conversion_action.create", brand_draft_id: "adkit-a" }) }],
    ] as const) {
      const response = await h.admin(path, employee, init);
      expect(response.status, path).toBe(403);
    }
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM adkit_jobs").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("directory", () => {
  const items = [
    { kind: "project", id: PROJECT, parent_id: null, name: "Project A", currency: null },
    { kind: "account", id: ACCOUNT, parent_id: PROJECT, name: "Main account", currency: "THB" },
    { kind: "account", id: "1234567890", parent_id: "proj_b", name: "Other project", currency: "USD" },
    { kind: "conversion_action", id: "7300000001", parent_id: ACCOUNT, name: "cv-0123456789abcdef", currency: null },
  ];

  it("ingest upserts rows and the admin reads serve them by parent", async () => {
    const ingest = await vps("directory/ingest", { items });
    expect(ingest.status).toBe(200);
    expect(await ingest.json()).toEqual({ status: "ok", upserted: 4 });
    const again = await vps("directory/ingest", { items: [{ ...items[1], name: "Renamed" }] });
    expect(again.status).toBe(200);

    const projects = await (await h.admin("/admin/adkit/projects", owner)).json() as { items: Array<{ id: string }>; synced_at: string };
    expect(projects.items.map((i) => i.id)).toEqual([PROJECT]);
    expect(projects.synced_at).toMatch(/^\d{4}-/);
    const accounts = await (await h.admin(`/admin/adkit/projects/${PROJECT}/accounts`, owner)).json() as { items: unknown[] };
    expect(accounts.items).toEqual([expect.objectContaining({ id: ACCOUNT, name: "Renamed", currency: "THB" })]);
    const actions = await (await h.admin(`/admin/adkit/accounts/${ACCOUNT}/conversion-actions`, owner)).json() as { items: unknown[] };
    expect(actions.items).toEqual([expect.objectContaining({ id: "7300000001", name: "cv-0123456789abcdef", currency: null })]);
  });

  it("rows older than 2 hours are not served", async () => {
    await vps("directory/ingest", { items });
    await h.db.prepare("UPDATE adkit_directory SET updated_at = ?1 WHERE kind = 'account'").bind(minutesAgo(121)).run();
    const accounts = await (await h.admin(`/admin/adkit/projects/${PROJECT}/accounts`, owner)).json();
    expect(accounts).toEqual({ items: [], synced_at: null });
  });

  it("rejects a bad id, an unknown kind and a bad route parameter", async () => {
    expect((await vps("directory/ingest", { items: [{ ...items[1], id: "481-121-9623" }] })).status).toBe(400);
    expect((await vps("directory/ingest", { items: [{ ...items[0], kind: "campaign" }] })).status).toBe(400);
    expect((await vps("directory/ingest", "{not json")).status).toBe(400);
    expect((await h.admin("/admin/adkit/accounts/abc/conversion-actions", owner)).status).toBe(422);
  });
});

describe("POST /admin/adkit/jobs", () => {
  it("the same idempotency key posted twice yields one row", async () => {
    const first = await createJob({ kind: "conversion_action.create", brand_draft_id: "adkit-a" });
    const second = await createJob({ kind: "conversion_action.create", brand_draft_id: "adkit-a" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const a = await first.json() as { job: { id: string; idempotency_key: string; payload: Record<string, unknown> }; created: boolean };
    const b = await second.json() as { job: { id: string }; created: boolean };
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    expect(a.job.idempotency_key).toBe("conversion_action.create:adkit-a");
    expect(a.job.payload).toEqual({ brand_draft_id: "adkit-a", account: ACCOUNT, project: PROJECT, name: expect.stringMatching(/^cv-[0-9a-f]{16}$/) });
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM adkit_jobs").first<{ n: number }>())!.n).toBe(1);
    const audit = await h.factory.prepare("SELECT action, actor_id FROM audit_log WHERE entity_id = ?1").bind(a.job.id).all();
    expect(audit.results).toEqual([{ action: "adkit.job.create", actor_id: "usr_owner_01" }]);
  });

  it("a client key is honored; reusing it for another draft is a conflict", async () => {
    const key = "wizard:adkit-b:attempt-1";
    const first = await createJob({ kind: "conversion_action.create", brand_draft_id: "adkit-b", idempotency_key: key });
    expect(first.status).toBe(201);
    expect(((await first.json()) as { job: { payload: { project: string | null } } }).job.payload.project).toBeNull();
    const reused = await createJob({ kind: "conversion_action.create", brand_draft_id: "adkit-a", idempotency_key: key });
    expect(reused.status).toBe(409);
  });

  it("answers 404 for an unknown draft and 422 for a draft without a Google Ads account or an unknown kind", async () => {
    expect((await createJob({ kind: "conversion_action.create", brand_draft_id: "adkit-missing" })).status).toBe(404);
    expect((await createJob({ kind: "conversion_action.create", brand_draft_id: "adkit-none" })).status).toBe(422);
    expect((await createJob({ kind: "campaign.enable", brand_draft_id: "adkit-a" })).status).toBe(422);
  });
});

describe("claim", () => {
  it("is atomic: two concurrent claims, one wins", async () => {
    const job = await queueJob();
    const listed = await (await pending()).json() as { jobs: Array<{ id: string }> };
    expect(listed.jobs.map((j) => j.id)).toEqual([job.id]);
    const [a, b] = await Promise.all([claim(job.id), claim(job.id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const row = await jobRow(job.id);
    expect(row).toMatchObject({ status: "claimed", attempts: 1 });
    expect(((await (await pending()).json()) as { jobs: unknown[] }).jobs).toEqual([]);
  });

  it("answers 404 for an unknown job", async () => {
    expect((await claim("33333333-3333-4333-8333-333333333333")).status).toBe(404);
  });

  it("a crashed claim past the lease is claimed again; at the attempt limit it fails", async () => {
    const { job, claimId } = await claimed();
    await h.db.prepare("UPDATE adkit_jobs SET claimed_at = ?1 WHERE id = ?2").bind(minutesAgo(31), job.id).run();
    const retake = await claim(job.id);
    expect(retake.status).toBe(200);
    expect(((await retake.json()) as { claim_id: string }).claim_id).not.toBe(claimId);
    expect(await jobRow(job.id)).toMatchObject({ status: "claimed", attempts: 2 });

    await h.db.prepare("UPDATE adkit_jobs SET claimed_at = ?1, attempts = 5 WHERE id = ?2").bind(minutesAgo(31), job.id).run();
    expect(((await (await pending()).json()) as { jobs: unknown[] }).jobs).toEqual([]);
    expect(await jobRow(job.id)).toMatchObject({ status: "failed" });
    expect((await claim(job.id)).status).toBe(409);
  });
});

describe("result", () => {
  it("a conversions create result marks the job done with result.conversion_action_id", async () => {
    const { job, claimId } = await claimed();
    const body = { job_id: job.id, claim_id: claimId, result: { conversion_action_id: ACTION, name: job.payload.name, adopted: false } };
    const done = await result(body);
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ status: "done" });
    const row = await jobRow(job.id);
    expect(row).toMatchObject({ status: "done" });
    expect(JSON.parse(String(row!.result))).toEqual({ conversion_action_id: ACTION, name: job.payload.name, adopted: false });

    const actions = await (await h.admin(`/admin/adkit/accounts/${ACCOUNT}/conversion-actions`, owner)).json() as { items: unknown[] };
    expect(actions.items).toEqual([expect.objectContaining({ id: ACTION, name: job.payload.name })]);

    // The VPS retries the same result: a no-op 200, one directory row, one done audit.
    const retry = await result(body);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ status: "done", already: true });
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM adkit_directory").first<{ n: number }>())!.n).toBe(1);
    const audit = await h.factory.prepare("SELECT action FROM audit_log WHERE entity_id = ?1 ORDER BY id").bind(job.id).all();
    expect(audit.results.map((r) => r.action)).toEqual(["adkit.job.create", "adkit.job.done"]);

    // The job row is the answer to a repeated panel POST too.
    const repeat = await createJob({ kind: "conversion_action.create", brand_draft_id: "adkit-a" });
    expect(((await repeat.json()) as { job: { status: string } }).job.status).toBe("done");
  });

  it("rejects a result for another claim or a result whose name differs from the job", async () => {
    const { job, claimId } = await claimed();
    const other = "44444444-4444-4444-8444-444444444444";
    expect((await result({ job_id: job.id, claim_id: other, result: { conversion_action_id: ACTION, name: job.payload.name, adopted: false } })).status).toBe(409);
    expect((await result({ job_id: job.id, claim_id: claimId, result: { conversion_action_id: ACTION, name: "cv-ffffffffffffffff", adopted: false } })).status).toBe(409);
    expect(await jobRow(job.id)).toMatchObject({ status: "claimed" });
  });

  it("a retryable error queues the job after the backoff; a final error fails it", async () => {
    const { job, claimId } = await claimed();
    const retry = await result({ job_id: job.id, claim_id: claimId, error: "adkit timeout" });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ status: "queued" });
    const row = await jobRow(job.id);
    expect(row).toMatchObject({ status: "queued", claim_id: null });
    expect(Date.parse(String(row!.next_attempt_at))).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect(JSON.parse(String(row!.result))).toEqual({ error: "adkit timeout" });
    expect(((await (await pending()).json()) as { jobs: unknown[] }).jobs).toEqual([]);
    expect((await claim(job.id)).status).toBe(409);

    await h.db.prepare("UPDATE adkit_jobs SET next_attempt_at = ?1 WHERE id = ?2").bind(minutesAgo(1), job.id).run();
    const again = await claim(job.id);
    expect(again.status).toBe(200);
    const second = ((await again.json()) as { claim_id: string }).claim_id;
    const final = await result({ job_id: job.id, claim_id: second, error: "command not allowed", retryable: false });
    expect(await final.json()).toEqual({ status: "failed" });
    expect(await jobRow(job.id)).toMatchObject({ status: "failed", attempts: 2 });
    expect((await result({ job_id: job.id, claim_id: second, error: "late" })).status).toBe(409);
  });
});
