import { createHash, timingSafeEqual } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdkitJob, PanelCampaignsResponse, type AdminRequestContext } from "@anjuna/contracts";
import { handleJobClaim, handleJobResult, handleJobsPending } from "../src/adkit.js";
import { createCampaignJob, type CampaignJobHooks } from "../src/campaign-jobs.js";
import { recordCampaignBrand } from "../src/campaign-brand-map.js";
import type { Env } from "../src/env.js";
import { createHarness, DRAIN_TOKEN, type Harness } from "./helpers.js";

const owner: AdminRequestContext = { actor_id: "usr_owner_01", actor_role: "owner", request_id: "req_camp_owner" };
const employee: AdminRequestContext = { actor_id: "usr_emp_01", actor_role: "employee", request_id: "req_camp_emp" };

const THB_ACCOUNT = "4811219623";
const USD_ACCOUNT = "1234567890";
const NO_CURRENCY_ACCOUNT = "5555555555";
const PINNED_NOW = "2026-11-08T00:00:00.000Z";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  const subtle = crypto.subtle as unknown as { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean };
  subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(a, b);
});
afterAll(async () => { await h?.mf.dispose(); });

async function seedBrand(id: string, account: string | null) {
  await h.seedBrand(id, `token-${id}`);
  await h.db.prepare("UPDATE brand_runtime SET google_ads_account = ?2, adkit_project = 'proj_a' WHERE brand_id = ?1").bind(id, account).run();
}

async function setSetting(key: string, value: unknown) {
  await h.factory.prepare(`INSERT INTO panel_settings (key, value_json, updated_by, updated_at) VALUES (?1, ?2, 'usr_owner_01', '2026-11-01T00:00:00.000Z')
    ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`).bind(key, JSON.stringify(value)).run();
}

beforeEach(async () => {
  await h.db.prepare("DELETE FROM brand_runtime").run();
  await h.db.batch(["adkit_jobs", "adkit_directory", "campaign_brand_map"].map((t) => h.db.prepare(`DELETE FROM ${t}`)));
  await h.factory.prepare("DELETE FROM panel_settings").run();
  await seedBrand("petvet", THB_ACCOUNT);
  await seedBrand("bison", THB_ACCOUNT);
  await seedBrand("usdbrand", USD_ACCOUNT);
  await seedBrand("nocur", NO_CURRENCY_ACCOUNT);
  await seedBrand("noads", null);
  // Fixed clock: core reads the account currency whatever the row age, so no assertion depends on today.
  const at = PINNED_NOW;
  await h.db.batch([
    [THB_ACCOUNT, "THB"], [USD_ACCOUNT, "USD"], [NO_CURRENCY_ACCOUNT, null],
  ].map(([id, currency]) => h.db.prepare(`INSERT INTO adkit_directory (kind, id, parent_id, name, currency, updated_at)
    VALUES ('account', ?1, 'proj_a', 'acct', ?2, ?3)`).bind(id, currency, at)));
});

const auth = { Authorization: `Bearer ${DRAIN_TOKEN}` };
const vps = (path: string, body?: unknown) => h.request(`/api/adkit/${path}`, body === undefined ? { headers: auth } : {
  method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const post = (body: Record<string, unknown>, context = owner) => h.admin("/admin/adkit/campaign-jobs", context, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const jobCount = async () => (await h.db.prepare("SELECT COUNT(*) AS n FROM adkit_jobs").first<{ n: number }>())!.n;

const draftBody = (brand: string, n: number, budget: number, extra: Record<string, unknown> = {}) => ({
  kind: "campaign.draft.create", brand_id: brand, name: `${brand}-search-${n}`, daily_budget: budget,
  bid_strategy: "maximize_conversions", geo: { country: "US" }, keywords: ["personal loans", "loan online"],
  final_url: `https://${brand}.example/?src=ads`, ...extra,
});

async function queued(response: Response, status = 201) {
  expect(response.status, await response.clone().text()).toBe(status);
  return AdkitJob.parse(((await response.json()) as { job: unknown }).job);
}

/** Claim a job and post a result for it. Returns the result response. */
async function finish(jobId: string, result: Record<string, unknown>) {
  const claim = await vps("jobs/claim", { job_id: jobId });
  expect(claim.status).toBe(200);
  const { claim_id } = await claim.json() as { claim_id: string };
  return vps("jobs/result", { job_id: jobId, claim_id, result });
}

let nextCampaignId = 22000000001;
/** A done draft (campaign id assigned) for the brand. */
async function draftDone(brand: string, n: number, budget: number) {
  const job = await queued(await post(draftBody(brand, n, budget), employee));
  const campaignId = String(nextCampaignId++);
  const done = await finish(job.id, { campaign_id: campaignId, name: `${brand}-search-${n}`, adopted: false, status: "DRAFT", daily_budget: budget });
  expect(done.status).toBe(200);
  return campaignId;
}

async function enabled(campaignId: string) {
  const job = await queued(await post({ kind: "campaign.enable", campaign_id: campaignId }));
  expect((await finish(job.id, { campaign_id: campaignId, status: "ENABLED" })).status).toBe(200);
  return job;
}

describe("campaign.draft.create", () => {
  it("an employee queues a draft; account and project come from the brand; the key is sha256(kind|brand|account|name)", async () => {
    const job = await queued(await post(draftBody("petvet", 1, 500), employee));
    expect(job.kind).toBe("campaign.draft.create");
    expect(job.payload).toMatchObject({ brand_id: "petvet", account: THB_ACCOUNT, project: "proj_a", name: "petvet-search-1", daily_budget: 500 });
    const expected = createHash("sha256").update(`campaign.draft.create|petvet|${THB_ACCOUNT}|petvet-search-1`).digest("hex");
    expect(job.idempotency_key).toBe(expected);
  });

  it("two posts with the same name give one job", async () => {
    const first = await queued(await post(draftBody("petvet", 1, 500), employee));
    const again = await post(draftBody("petvet", 1, 700), owner);
    expect(again.status).toBe(200);
    const body = await again.json() as { job: { id: string }; created: boolean };
    expect(body).toMatchObject({ created: false, job: { id: first.id } });
    expect(await jobCount()).toBe(1);
  });

  it("a draft above the brand cap is 422 before a row exists", async () => {
    const response = await post(draftBody("petvet", 1, 3001), employee);
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain("brand_cap");
    expect(await jobCount()).toBe(0);
  });

  it("a draft that would pass the total cap with the enabled campaigns is 422", async () => {
    await enabled(await draftDone("petvet", 1, 2000));
    const before = await jobCount();
    const response = await post(draftBody("bison", 1, 1500), employee);
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain("total_cap");
    expect(await jobCount()).toBe(before);
  });

  it("an owner brand cap below the total cap is applied", async () => {
    await setSetting("ads_cap_brand_thb_day", 1000);
    expect((await post(draftBody("petvet", 1, 1000.01), employee)).status).toBe(422);
    expect((await post(draftBody("petvet", 1, 1000), employee)).status).toBe(201);
  });

  it.each([
    ["a negative budget", { daily_budget: -1 }],
    ["a zero budget", { daily_budget: 0 }],
    ["a budget above 1e6", { daily_budget: 1_000_001 }],
    ["a budget with 3 decimals", { daily_budget: 10.123 }],
    ["a budget that is not a number", { daily_budget: "NaN" }],
    ["a name of another brand", { name: "bison-search-1" }],
    ["a name without the search suffix", { name: "petvet-pmax-1" }],
    ["a Final URL on another host", { final_url: "https://bison.example/" }],
    ["an http Final URL", { final_url: "http://petvet.example/" }],
    ["an idempotency key from the client", { idempotency_key: "client-key-1" }],
    ["a publish flag", { publish: true }],
    ["an account from the client", { account: USD_ACCOUNT }],
  ])("refuses %s with 422 and no row", async (_label, extra) => {
    const response = await post(draftBody("petvet", 1, 500, extra), employee);
    expect(response.status).toBe(422);
    expect(await jobCount()).toBe(0);
  });

  it("converts a USD budget with fx_thb_per_usd before the cap check", async () => {
    expect((await post(draftBody("usdbrand", 1, 100), employee)).status).toBe(422); // 100 USD x 35 = 3500 THB
    await setSetting("fx_thb_per_usd", 20);
    expect((await post(draftBody("usdbrand", 2, 100), employee)).status).toBe(201); // 2000 THB
  });

  it("refuses an account whose currency core does not know", async () => {
    expect((await post(draftBody("nocur", 1, 10), employee)).status).toBe(422);
    expect(await jobCount()).toBe(0);
  });

  it("refuses a brand without a Google Ads account, and an unknown brand", async () => {
    expect((await post(draftBody("noads", 1, 10), employee)).status).toBe(422);
    expect((await post(draftBody("ghost", 1, 10), employee)).status).toBe(404);
  });
});

describe("campaign.enable and the other jobs", () => {
  it("an employee gets 403 for enable, pause and budget, and no row is written", async () => {
    const campaignId = await draftDone("petvet", 1, 500);
    const before = await jobCount();
    for (const body of [
      { kind: "campaign.enable", campaign_id: campaignId },
      { kind: "campaign.pause", campaign_id: campaignId },
      { kind: "campaign.update_budget", campaign_id: campaignId, daily_budget: 100 },
    ]) {
      const response = await post(body, employee);
      expect(response.status, body.kind).toBe(403);
      expect(await response.json()).toMatchObject({ error: "forbidden_role", required_role: "owner" });
    }
    expect(await jobCount()).toBe(before);
  });

  it("an owner enable copies the campaign from its draft job and is claimable at once; a repeat gives the same job", async () => {
    const campaignId = await draftDone("petvet", 1, 500);
    const job = await queued(await post({ kind: "campaign.enable", campaign_id: campaignId }));
    expect(job.payload).toEqual({ campaign_id: campaignId, brand_id: "petvet", account: THB_ACCOUNT, project: "proj_a", name: "petvet-search-1" });
    expect(job.next_attempt_at).toBeNull();
    const listed = await (await vps("jobs/pending")).json() as { jobs: Array<{ id: string }> };
    expect(listed.jobs.map((j) => j.id)).toContain(job.id);
    const again = await post({ kind: "campaign.enable", campaign_id: campaignId });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { job: { id: string } }).job.id).toBe(job.id);
  });

  it("enable is refused again at enable time when the caps were lowered after the draft", async () => {
    const campaignId = await draftDone("petvet", 1, 2000);
    await setSetting("ads_cap_total_thb_day", 1500);
    await setSetting("ads_cap_brand_thb_day", 1500);
    const before = await jobCount();
    const response = await post({ kind: "campaign.enable", campaign_id: campaignId });
    expect(response.status).toBe(422);
    expect(await jobCount()).toBe(before);
  });

  it("an enable still queued counts toward the total cap", async () => {
    const a = await draftDone("petvet", 1, 2000);
    const b = await draftDone("bison", 1, 1500);
    await queued(await post({ kind: "campaign.enable", campaign_id: a }));
    const response = await post({ kind: "campaign.enable", campaign_id: b });
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain("total_cap");
  });

  it("an enabled campaign cannot be enabled twice; pause, then enable again is a new job", async () => {
    const campaignId = await draftDone("petvet", 1, 500);
    const first = await enabled(campaignId);
    expect((await post({ kind: "campaign.enable", campaign_id: campaignId })).status).toBe(409);
    const pause = await queued(await post({ kind: "campaign.pause", campaign_id: campaignId }));
    expect((await finish(pause.id, { campaign_id: campaignId, status: "PAUSED" })).status).toBe(200);
    const second = await queued(await post({ kind: "campaign.enable", campaign_id: campaignId }));
    expect(second.id).not.toBe(first.id);
  });

  it("a budget raise on an enabled campaign above the cap is 422; within the cap it is queued", async () => {
    const campaignId = await draftDone("petvet", 1, 1000);
    await enabled(campaignId);
    expect((await post({ kind: "campaign.update_budget", campaign_id: campaignId, daily_budget: 3000.5 })).status).toBe(422);
    const job = await queued(await post({ kind: "campaign.update_budget", campaign_id: campaignId, daily_budget: 2500 }));
    expect(job.payload).toMatchObject({ campaign_id: campaignId, daily_budget: 2500 });
  });

  it("a second budget change with another amount while the first is pending is 409 naming the pending job", async () => {
    const campaignId = await draftDone("petvet", 1, 1000);
    await enabled(campaignId);
    const first = await queued(await post({ kind: "campaign.update_budget", campaign_id: campaignId, daily_budget: 1500 }));
    const same = await post({ kind: "campaign.update_budget", campaign_id: campaignId, daily_budget: 1500 });
    expect(same.status).toBe(200);
    const other = await post({ kind: "campaign.update_budget", campaign_id: campaignId, daily_budget: 1800 });
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ error: "conflict", message: expect.stringContaining(first.id) });
  });

  it("pause of a campaign that is not enabled is 409; an unknown campaign is 404", async () => {
    const campaignId = await draftDone("petvet", 1, 500);
    expect((await post({ kind: "campaign.pause", campaign_id: campaignId })).status).toBe(409);
    expect((await post({ kind: "campaign.enable", campaign_id: "99999999999" })).status).toBe(404);
  });
});

describe("results", () => {
  it("a result of the wrong kind or for another campaign never marks the job done", async () => {
    const campaignId = await draftDone("petvet", 1, 500);
    await enabled(campaignId);
    const pause = await queued(await post({ kind: "campaign.pause", campaign_id: campaignId }));
    const claim = await vps("jobs/claim", { job_id: pause.id });
    const { claim_id } = await claim.json() as { claim_id: string };
    expect((await vps("jobs/result", { job_id: pause.id, claim_id, result: { campaign_id: campaignId, status: "ENABLED" } })).status).toBe(409);
    expect((await vps("jobs/result", { job_id: pause.id, claim_id, result: { campaign_id: "1", status: "PAUSED" } })).status).toBe(409);
    expect((await vps("jobs/result", { job_id: pause.id, claim_id, result: { campaign_id: campaignId, status: "PAUSED" } })).status).toBe(200);
  });

  it("a draft result with another name is stale; the job's own result is done once, and a repeat is already done", async () => {
    const job = await queued(await post(draftBody("petvet", 1, 500), employee));
    const claim = await vps("jobs/claim", { job_id: job.id });
    const { claim_id } = await claim.json() as { claim_id: string };
    const wrong = { campaign_id: "22000000999", name: "petvet-search-2", adopted: false, status: "DRAFT", daily_budget: 500 };
    expect((await vps("jobs/result", { job_id: job.id, claim_id, result: wrong })).status).toBe(409);
    const right = { campaign_id: "22000000999", name: "petvet-search-1", adopted: true, status: "PAUSED", daily_budget: 500 };
    expect((await vps("jobs/result", { job_id: job.id, claim_id, result: right })).status).toBe(200);
    const repeat = await vps("jobs/result", { job_id: job.id, claim_id, result: right });
    expect(await repeat.json()).toEqual({ status: "done", already: true });
  });
});

describe("GET /admin/adkit/campaigns", () => {
  it("an employee reads campaigns with their state, the caps and the enabled total in baht", async () => {
    await enabled(await draftDone("petvet", 1, 1200));
    await draftDone("bison", 1, 300);
    await queued(await post(draftBody("usdbrand", 1, 10), employee));
    const response = await h.admin("/admin/adkit/campaigns", employee);
    expect(response.status).toBe(200);
    const body = PanelCampaignsResponse.parse(await response.json());
    expect(body.caps).toEqual({ total_thb_day: 3000, brand_thb_day: 3000 });
    expect(body.enabled_total_thb_day).toBe(1200);
    expect(body.campaigns.map((c) => [c.name, c.state, c.daily_budget_thb])).toEqual([
      ["petvet-search-1", "enabled", 1200],
      ["bison-search-1", "draft", 300],
      ["usdbrand-search-1", "drafting", 350],
    ]);
  });
});

describe("campaign_brand_map on a done draft (injected writer)", () => {
  const inProcess = (body: Record<string, unknown>, record: (db: D1Database, row: unknown) => Promise<void>) => handleJobResult(
    new Request("https://core.aduplift.ai/api/adkit/jobs/result", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    { LEADS: h.db, FACTORY: h.factory, DRAIN_TOKEN } as unknown as Env,
    { recordCampaignBrand: record },
  );

  async function claimedDraft() {
    const job = await queued(await post(draftBody("petvet", 1, 500), employee));
    const claim = await vps("jobs/claim", { job_id: job.id });
    return { job, claimId: ((await claim.json()) as { claim_id: string }).claim_id };
  }

  it("records account, campaign id and brand once when the draft is done, and again on a repeated done result", async () => {
    const { job, claimId } = await claimedDraft();
    const record = vi.fn(async () => {});
    const result = { campaign_id: "22000000777", name: "petvet-search-1", adopted: false, status: "DRAFT", daily_budget: 500 };
    expect((await inProcess({ job_id: job.id, claim_id: claimId, result }, record)).status).toBe(200);
    expect(record).toHaveBeenCalledTimes(1);
    expect((record.mock.calls[0] as unknown[])[1]).toEqual({ account: THB_ACCOUNT, campaign_id: "22000000777", brand_id: "petvet" });
    expect((await inProcess({ job_id: job.id, claim_id: claimId, result }, record)).status).toBe(200);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("records nothing for a stale result, and a failing writer still answers done", async () => {
    const { job, claimId } = await claimedDraft();
    const record = vi.fn(async () => { throw new Error("no such table: campaign_brand_map"); });
    const wrong = { campaign_id: "22000000777", name: "petvet-search-2", adopted: false, status: "DRAFT", daily_budget: 500 };
    expect((await inProcess({ job_id: job.id, claim_id: claimId, result: wrong }, record)).status).toBe(409);
    expect(record).not.toHaveBeenCalled();
    const right = { ...wrong, name: "petvet-search-1" };
    expect(await (await inProcess({ job_id: job.id, claim_id: claimId, result: right }, record)).json()).toEqual({ status: "done" });
    expect(record).toHaveBeenCalledTimes(1);
  });

});

describe("campaign_brand_map write (source = 'create')", () => {
  const mapRow = (campaignId: string) => h.db.prepare("SELECT brand_id, source FROM campaign_brand_map WHERE account = ?1 AND campaign_id = ?2")
    .bind(THB_ACCOUNT, campaignId).first<{ brand_id: string; source: string }>();

  it("a done draft job writes the map row through the real route", async () => {
    const campaignId = await draftDone("petvet", 1, 500);
    expect(await mapRow(campaignId)).toEqual({ brand_id: "petvet", source: "create" });
  });

  it("overwrites a click row and never a manual row", async () => {
    const at = "2026-11-01T00:00:00.000Z";
    await h.db.batch([
      h.db.prepare("INSERT INTO campaign_brand_map VALUES (?1, '31000000001', 'bison', 'click', ?2, ?2)").bind(THB_ACCOUNT, at),
      h.db.prepare("INSERT INTO campaign_brand_map VALUES (?1, '31000000002', 'bison', 'manual', ?2, ?2)").bind(THB_ACCOUNT, at),
    ]);
    await recordCampaignBrand(h.db, { account: THB_ACCOUNT, campaign_id: "31000000001", brand_id: "petvet" });
    await recordCampaignBrand(h.db, { account: THB_ACCOUNT, campaign_id: "31000000002", brand_id: "petvet" });
    expect(await mapRow("31000000001")).toEqual({ brand_id: "petvet", source: "create" });
    expect(await mapRow("31000000002")).toEqual({ brand_id: "bison", source: "manual" });
  });
});

describe("F1: an enable that has not passed the cap recheck is never claimable", () => {
  const NOW = Date.parse(PINNED_NOW);
  const LATER = NOW + 10 * 60_000;
  const coreEnv = () => ({ LEADS: h.db, FACTORY: h.factory, DRAIN_TOKEN }) as unknown as Env;
  const inProc = (env: Env, body: Record<string, unknown>, hooks: CampaignJobHooks = {}) => createCampaignJob(
    new Request("https://core.aduplift.ai/admin/adkit/campaign-jobs", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), env, owner, NOW, hooks,
  );
  const pendingAt = async (env: Env, nowMs: number) => {
    const response = await handleJobsPending(new Request("https://core.aduplift.ai/api/adkit/jobs/pending", { headers: auth }), env, nowMs);
    return ((await response.json()) as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id);
  };
  const claimAt = (env: Env, jobId: string, nowMs: number) => handleJobClaim(new Request("https://core.aduplift.ai/api/adkit/jobs/claim", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ job_id: jobId }),
  }), env, nowMs);
  const enableRows = async () => (await h.db.prepare("SELECT id, status FROM adkit_jobs WHERE kind = 'campaign.enable' ORDER BY created_at, id")
    .all<{ id: string; status: string }>()).results;
  const crash = async () => { throw new Error("worker died"); };

  it("two enables that both pass the first check: the later recheck refuses one", async () => {
    const a = await draftDone("petvet", 1, 2000);
    const b = await draftDone("bison", 1, 2000);
    const env = coreEnv();
    let bResponse: Response | undefined;
    const aResponse = await inProc(env, { kind: "campaign.enable", campaign_id: a }, {
      afterPrecheck: async () => { bResponse = await inProc(env, { kind: "campaign.enable", campaign_id: b }); },
    });
    expect(bResponse!.status).toBe(201);
    expect(aResponse.status).toBe(422);
    const rows = await enableRows();
    expect(rows.map((r) => r.status).sort()).toEqual(["failed", "queued"]);
    expect(await pendingAt(env, LATER)).toEqual(rows.filter((r) => r.status === "queued").map((r) => r.id));
  });

  it("a crash between insert and recheck on both: neither is claimable after 10 minutes until a recheck, then one is", async () => {
    const a = await draftDone("petvet", 1, 2000);
    const b = await draftDone("bison", 1, 2000);
    const env = coreEnv();
    await expect(inProc(env, { kind: "campaign.enable", campaign_id: a }, {
      afterPrecheck: async () => {
        await expect(inProc(env, { kind: "campaign.enable", campaign_id: b }, { beforeRecheck: crash })).rejects.toThrow("worker died");
      },
      beforeRecheck: crash,
    })).rejects.toThrow("worker died");
    const held = await enableRows();
    expect(held.map((r) => r.status)).toEqual(["held", "held"]);
    for (const row of held) expect((await claimAt(env, row.id, LATER)).status).toBe(409);

    const listed = await pendingAt(env, LATER);
    const after = await enableRows();
    expect(after.map((r) => r.status).sort()).toEqual(["failed", "queued"]);
    expect(listed).toEqual(after.filter((r) => r.status === "queued").map((r) => r.id));
    const failed = after.find((r) => r.status === "failed")!;
    expect((await claimAt(env, failed.id, LATER + 60 * 60_000)).status).toBe(409);
  });

  it("a D1 error inside the recheck leaves the row held and unclaimable; the next pending poll releases it", async () => {
    const a = await draftDone("petvet", 1, 500);
    const env = coreEnv();
    const realFactory = env.FACTORY;
    const broken = { prepare: () => { throw new Error("D1_ERROR: network"); } } as unknown as D1Database;
    const response = await inProc(env, { kind: "campaign.enable", campaign_id: a }, {
      beforeRecheck: async () => { (env as { FACTORY: D1Database }).FACTORY = broken; },
    });
    expect(response.status).toBe(201);
    const job = AdkitJob.parse(((await response.json()) as { job: unknown }).job);
    expect(job.status).toBe("held");
    (env as { FACTORY: D1Database }).FACTORY = realFactory;
    expect((await claimAt(env, job.id, LATER)).status).toBe(409);
    expect(await pendingAt(env, LATER)).toEqual([job.id]);
  });

  it("a held enable counts toward the caps of the next request", async () => {
    const a = await draftDone("petvet", 1, 2000);
    const b = await draftDone("bison", 1, 2000);
    const env = coreEnv();
    await expect(inProc(env, { kind: "campaign.enable", campaign_id: a }, { beforeRecheck: crash })).rejects.toThrow();
    expect((await inProc(env, { kind: "campaign.enable", campaign_id: b })).status).toBe(422);
  });
});

describe("F2: a lost enable result keeps the budget counted", () => {
  const LATE = Date.parse(PINNED_NOW) + 24 * 60 * 60_000;
  const coreEnv = () => ({ LEADS: h.db, FACTORY: h.factory, DRAIN_TOKEN }) as unknown as Env;
  const pendingAt = async (nowMs: number) => {
    const response = await handleJobsPending(new Request("https://core.aduplift.ai/api/adkit/jobs/pending", { headers: auth }), coreEnv(), nowMs);
    return ((await response.json()) as { jobs: Array<{ id: string; kind: string; payload: Record<string, unknown> }> }).jobs;
  };
  const status = async (id: string) => (await h.db.prepare("SELECT status FROM adkit_jobs WHERE id = ?1").bind(id).first<{ status: string }>())!.status;
  const stateOf = async (campaignId: string) => {
    const body = PanelCampaignsResponse.parse(await (await h.admin("/admin/adkit/campaigns", owner)).json());
    return body.campaigns.find((c) => c.campaign_id === campaignId)!.state;
  };
  /** The enable ran remotely, but every claim lost its result: the last lease expired. */
  async function lostEnable(campaignId: string) {
    const job = await queued(await post({ kind: "campaign.enable", campaign_id: campaignId }));
    await h.db.prepare(`UPDATE adkit_jobs SET status = 'claimed', claim_id = 'c-lost', claimed_at = ?2, attempts = 5 WHERE id = ?1`)
      .bind(job.id, PINNED_NOW).run();
    await pendingAt(LATE);
    return job;
  }

  it("a lease that expires on the last attempt leaves the enable unknown, still counted, and queues a status check", async () => {
    const a = await draftDone("petvet", 1, 2000);
    const b = await draftDone("bison", 1, 2000);
    const job = await lostEnable(a);
    expect(await status(job.id)).toBe("unknown");
    expect(await stateOf(a)).toBe("unknown");
    expect((await post({ kind: "campaign.enable", campaign_id: b })).status).toBe(422);
    const checks = (await pendingAt(LATE)).filter((j) => j.kind === "campaign.status_check");
    expect(checks.map((j) => j.payload)).toEqual([{ campaign_id: a, brand_id: "petvet", account: THB_ACCOUNT, project: "proj_a", name: "petvet-search-1" }]);
  });

  it("an error result on the last attempt is unknown; a non-retryable error is failed and frees the budget", async () => {
    const a = await draftDone("petvet", 1, 2000);
    const b = await draftDone("bison", 1, 2000);
    const first = await queued(await post({ kind: "campaign.enable", campaign_id: a }));
    await h.db.prepare("UPDATE adkit_jobs SET attempts = 4 WHERE id = ?1").bind(first.id).run();
    const claim = await vps("jobs/claim", { job_id: first.id });
    const { claim_id } = await claim.json() as { claim_id: string };
    expect((await vps("jobs/result", { job_id: first.id, claim_id, error: "timeout after 120 s" })).status).toBe(200);
    expect(await status(first.id)).toBe("unknown");
    expect((await post({ kind: "campaign.enable", campaign_id: b })).status).toBe(422);

    const c = await draftDone("usdbrand", 1, 10);
    const never = await queued(await post({ kind: "campaign.enable", campaign_id: c }));
    const claim2 = await vps("jobs/claim", { job_id: never.id });
    const { claim_id: claim2Id } = await claim2.json() as { claim_id: string };
    await vps("jobs/result", { job_id: never.id, claim_id: claim2Id, error: "adkit command not allowed", retryable: false, wrote: false });
    expect(await status(never.id)).toBe("failed");
  });

  it("a non-retryable budget error after the write (budget_not_applied) is unknown and keeps the larger budget counted", async () => {
    const a = await draftDone("petvet", 1, 1000);
    const b = await draftDone("bison", 1, 600);
    await enabled(a);
    const budget = await queued(await post({ kind: "campaign.update_budget", campaign_id: a, daily_budget: 2500 }));
    const claim = await vps("jobs/claim", { job_id: budget.id });
    const { claim_id } = await claim.json() as { claim_id: string };
    await vps("jobs/result", { job_id: budget.id, claim_id, error: "budget_not_applied: AdKit reports 1000", retryable: false });
    expect(await status(budget.id)).toBe("unknown");
    expect((await post({ kind: "campaign.enable", campaign_id: b })).status).toBe(422); // 2500 + 600 > 3000
  });

  it.each([
    ["PAUSED", "paused", 201],
    ["ENABLED", "enabled", 422],
    ["NOT_FOUND", "removed", 201],
  ] as const)("a confirming status check %s resolves the unknown enable to %s", async (observed, state, nextEnable) => {
    const a = await draftDone("petvet", 1, 2000);
    const b = await draftDone("bison", 1, 2000);
    await lostEnable(a);
    const check = (await pendingAt(LATE)).find((j) => j.kind === "campaign.status_check")!;
    const done = await finish(check.id, { campaign_id: a, observed_status: observed, daily_budget: observed === "NOT_FOUND" ? null : 2000 });
    expect(done.status).toBe(200);
    expect(await stateOf(a)).toBe(state);
    expect((await post({ kind: "campaign.enable", campaign_id: b })).status).toBe(nextEnable);
  });

  it("a confirmed pause resolves the unknown enable", async () => {
    const a = await draftDone("petvet", 1, 2000);
    const b = await draftDone("bison", 1, 2000);
    await lostEnable(a);
    const pause = await queued(await post({ kind: "campaign.pause", campaign_id: a }));
    expect((await finish(pause.id, { campaign_id: a, status: "PAUSED" })).status).toBe(200);
    expect(await stateOf(a)).toBe("paused");
    expect((await post({ kind: "campaign.enable", campaign_id: b })).status).toBe(201);
  });

  it("an unknown enable cannot be enabled again; the owner may queue a status check", async () => {
    const a = await draftDone("petvet", 1, 500);
    await lostEnable(a);
    expect((await post({ kind: "campaign.enable", campaign_id: a })).status).toBe(409);
    expect((await post({ kind: "campaign.status_check", campaign_id: a }, employee)).status).toBeLessThan(300);
  });
});

describe("F4: core stores a draft only when the result matches the job's budget and a draft or paused status", () => {
  async function claimedDraft(budget: number) {
    const job = await queued(await post(draftBody("petvet", 1, budget), employee));
    const claim = await vps("jobs/claim", { job_id: job.id });
    return { job, claim_id: ((await claim.json()) as { claim_id: string }).claim_id };
  }

  it("a result with another budget is stale and the job stays claimed", async () => {
    const { job, claim_id } = await claimedDraft(500);
    const result = { campaign_id: "9001", name: "petvet-search-1", adopted: true, status: "PAUSED", daily_budget: 9000 };
    expect((await vps("jobs/result", { job_id: job.id, claim_id, result })).status).toBe(409);
    expect((await h.db.prepare("SELECT status FROM adkit_jobs WHERE id = ?1").bind(job.id).first<{ status: string }>())!.status).toBe("claimed");
  });

  it("a result that says ENABLED is refused at the contract", async () => {
    const { job, claim_id } = await claimedDraft(500);
    const result = { campaign_id: "9001", name: "petvet-search-1", adopted: true, status: "ENABLED", daily_budget: 500 };
    expect((await vps("jobs/result", { job_id: job.id, claim_id, result })).status).toBe(400);
  });

  it("a matching paused adopt is stored with its status and budget", async () => {
    const { job, claim_id } = await claimedDraft(500);
    const result = { campaign_id: "9001", name: "petvet-search-1", adopted: true, status: "PAUSED", daily_budget: 500 };
    expect((await vps("jobs/result", { job_id: job.id, claim_id, result })).status).toBe(200);
    const row = await h.db.prepare("SELECT status, result FROM adkit_jobs WHERE id = ?1").bind(job.id).first<{ status: string; result: string }>();
    expect(row!.status).toBe("done");
    expect(JSON.parse(row!.result)).toEqual(result);
  });
});
