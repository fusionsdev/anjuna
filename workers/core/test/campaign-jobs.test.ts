import { createHash, timingSafeEqual } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdkitJob, PanelCampaignsResponse, type AdminRequestContext } from "@anjuna/contracts";
import { createHarness, DRAIN_TOKEN, type Harness } from "./helpers.js";

const owner: AdminRequestContext = { actor_id: "usr_owner_01", actor_role: "owner", request_id: "req_camp_owner" };
const employee: AdminRequestContext = { actor_id: "usr_emp_01", actor_role: "employee", request_id: "req_camp_emp" };

const THB_ACCOUNT = "4811219623";
const USD_ACCOUNT = "1234567890";
const NO_CURRENCY_ACCOUNT = "5555555555";

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
  await h.db.batch(["adkit_jobs", "adkit_directory"].map((t) => h.db.prepare(`DELETE FROM ${t}`)));
  await h.factory.prepare("DELETE FROM panel_settings").run();
  await seedBrand("petvet", THB_ACCOUNT);
  await seedBrand("bison", THB_ACCOUNT);
  await seedBrand("usdbrand", USD_ACCOUNT);
  await seedBrand("nocur", NO_CURRENCY_ACCOUNT);
  await seedBrand("noads", null);
  const at = new Date().toISOString();
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
  const done = await finish(job.id, { campaign_id: campaignId, name: `${brand}-search-${n}`, adopted: false });
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
    const wrong = { campaign_id: "22000000999", name: "petvet-search-2", adopted: false };
    expect((await vps("jobs/result", { job_id: job.id, claim_id, result: wrong })).status).toBe(409);
    const right = { campaign_id: "22000000999", name: "petvet-search-1", adopted: true };
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
