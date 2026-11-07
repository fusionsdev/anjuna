import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import brandFixture from "@anjuna/contracts/fixtures/admin/brand.get.response.json";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;

// Core is down, so only the stored rows and the smoke receipt can tick an item. That keeps the expected rows exact.
const coreDown = makeEnv({ CORE: { fetch: async () => { throw new Error("core down"); } } as unknown as Fetcher, MOCK_CORE: "0" });

beforeAll(async () => { await setupDatabases(); });
beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id,name,framework,created_by,created_at) VALUES ('tpl-1','Starter','astro','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,created_by,created_at) VALUES ('tv-1','tpl-1',1,'sha-1','templates/tv-1','sealed','owner','2026-10-01T00:00:00Z','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,created_by,created_at) VALUES ('tv-cert','tpl-1',2,'sha-2','templates/tv-2','certified','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id,name,framework,created_by,created_at) VALUES ('tpl-3','Quiet','astro','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,created_by,created_at) VALUES ('tv-3','tpl-3',1,'sha-3','templates/tv-3','sealed','owner','2026-10-01T00:00:00Z','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES ('fa-1','abcdef1','forms/fa-1','manifest','2026-01','form@abcdef1','2026-10-01T00:00:00Z')"),
  ]);
});

async function draft(domain: string, templateVersionId = "tv-1"): Promise<string> {
  const response = await call("/api/brands/drafts", {
    cookie: employee, method: "POST",
    body: { domain, keyword_default: "Quick Loan", template_version_id: templateVersionId, profile: { contact: { phone: "+1 555 0100", address: "1 Main St, Dallas TX", email: `help@${domain}` } } },
  });
  expect(response.status).toBe(201);
  return (await response.json() as { brand: { brand_id: string } }).brand.brand_id;
}

const goLive = (brandId: string) => env.FACTORY.prepare("UPDATE brands SET status='live' WHERE brand_id=?1").bind(brandId).run();
const attest = (brandId: string, item: string) => env.FACTORY.prepare(
  "INSERT INTO brand_checklist (brand_id,item,evidence_json,confirmed_by,confirmed_role,confirmed_at) VALUES (?1,?2,?3,'owner','owner','2026-10-20T00:00:00.000Z')",
).bind(brandId, item, JSON.stringify({ brand_id: brandId, item, actor_id: "owner", verified_at: "2026-10-20T00:00:00.000Z" })).run();

type Entry = { checklist: Array<Record<string, unknown>>; template_approved: boolean; template_waiting_id: string | null; unknown?: boolean };
type Batch = { brands: Record<string, Entry> };
const batch = async (cookie: string, testEnv = coreDown) => {
  const response = await call("/api/brands/checklists", { cookie, env: testEnv });
  expect(response.status).toBe(200);
  return (await response.json()) as Batch;
};

describe("GET /api/brands/checklists", () => {
  it("needs a session", async () => {
    expect((await call("/api/brands/checklists", { env: coreDown })).status).toBe(401);
  });

  it("returns every live brand once, keyed by brand id, with the rows the per-brand route returns", async () => {
    const a = await draft("batch-a.example");
    const b = await draft("batch-b.example");
    const notLive = await draft("batch-draft.example");
    await goLive(a);
    await goLive(b);
    await attest(a, "test_sold");

    for (const cookie of [owner, employee]) {
      const body = await batch(cookie);
      expect(Object.keys(body.brands).sort()).toEqual([a, b].sort());
      expect(body.brands[notLive]).toBeUndefined();
      expect(body.brands[a]!.checklist.map((row) => row.item)).toEqual(["test_sold"]);
      expect(body.brands[b]!.checklist).toEqual([]);
      for (const id of [a, b]) {
        const single = await call(`/api/brands/${id}/checklist`, { cookie, env: coreDown });
        expect(body.brands[id]!.checklist).toEqual((await single.json() as { checklist: unknown[] }).checklist);
      }
    }
  });

  it("marks a brand whose own template version waits for approval", async () => {
    const waiting = await draft("batch-waiting.example");
    await goLive(waiting);
    await env.FACTORY.prepare("UPDATE brand_revisions SET template_version_id='tv-cert' WHERE brand_id=?1").bind(waiting).run();
    const entry = (await batch(owner)).brands[waiting]!;
    expect(entry.template_approved).toBe(false);
    expect(entry.template_waiting_id).toBe("tv-cert");
  });

  it("marks a brand on sealed v1 while v2 of the same template is certified and waiting", async () => {
    const upgrading = await draft("batch-upgrade.example", "tv-1");
    await goLive(upgrading);
    const entry = (await batch(owner)).brands[upgrading]!;
    // tv-1 is sealed v1 of tpl-1; tv-cert is v2 of tpl-1 and certified.
    expect(entry.template_approved).toBe(false);
    expect(entry.template_waiting_id).toBe("tv-cert");
  });

  it("offers no approval when a later sealed version supersedes the certified one", async () => {
    // tpl-4: v1 sealed (deployed), v2 certified, v3 sealed. The newest version is sealed, so nothing waits.
    await env.FACTORY.batch([
      env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id,name,framework,created_by,created_at) VALUES ('tpl-4','Newest','astro','owner','2026-10-01T00:00:00Z')"),
      env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,created_by,created_at) VALUES ('tv-4a','tpl-4',1,'sha-4a','templates/4a','sealed','owner','2026-10-01T00:00:00Z','owner','2026-10-01T00:00:00Z')"),
      env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,created_by,created_at) VALUES ('tv-4b','tpl-4',2,'sha-4b','templates/4b','certified','owner','2026-10-02T00:00:00Z')"),
      env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,created_by,created_at) VALUES ('tv-4c','tpl-4',3,'sha-4c','templates/4c','sealed','owner','2026-10-03T00:00:00Z','owner','2026-10-03T00:00:00Z')"),
    ]);
    const id = await draft("batch-superseded.example", "tv-4a");
    await goLive(id);
    const entry = (await batch(owner)).brands[id]!;
    expect(entry.template_approved).toBe(true);
    expect(entry.template_waiting_id).toBeNull();
  });

  it("approves a brand whose template has no certified version waiting", async () => {
    const quiet = await draft("batch-quiet.example", "tv-3");
    await goLive(quiet);
    const entry = (await batch(owner)).brands[quiet]!;
    expect(entry.template_approved).toBe(true);
    expect(entry.template_waiting_id).toBeNull();
  });

  it("marks a brand unknown when core is down and a computed row is open, and only that brand", async () => {
    const known = await draft("batch-known.example", "tv-3");
    const open = await draft("batch-open.example", "tv-3");
    await goLive(known);
    await goLive(open);
    // known has both core-computed rows attested in D1, so it never needs core.
    await attest(known, "drain_route");
    await attest(known, "leadsgate_postbacks");
    const body = await batch(owner);
    expect(body.brands[known]!.unknown).toBeUndefined();
    expect(body.brands[open]!.unknown).toBe(true);
    // The rows are still the stored ones: the outage adds no row and removes none.
    expect(body.brands[open]!.checklist).toEqual([]);
  });

  it("does not mark a brand unknown when core answers", async () => {
    const id = await draft("batch-core-up.example", "tv-3");
    await goLive(id);
    const coreUp = makeEnv({ CORE: { fetch: async () => Response.json({ brand: { ...brandFixture.brand, brand_id: id } }) } as unknown as Fetcher, MOCK_CORE: "0" });
    const body = await batch(owner, coreUp);
    expect(body.brands[id]!.unknown).toBeUndefined();
  });

  it("keeps at most 6 core reads in flight and still reads every live brand once", async () => {
    for (let i = 0; i < 8; i++) await goLive(await draft(`batch-cap-${i}.example`, "tv-3"));
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const slowCore = makeEnv({ CORE: { fetch: async () => {
      calls++; inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight--;
      return new Response("{}", { status: 502 });
    } } as unknown as Fetcher, MOCK_CORE: "0" });
    const body = await batch(owner, slowCore);
    const needCore = Object.values(body.brands).filter((entry) => entry.unknown).length;
    expect(needCore).toBeGreaterThanOrEqual(8);
    expect(calls).toBe(needCore);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
  });

  it("reads D1 in one batch whatever the number of live brands", async () => {
    const real = env.FACTORY;
    const counts = { prepare: 0, batch: 0 };
    const counted = new Proxy(real, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (key === "prepare") return (query: string) => { counts.prepare++; return target.prepare(query); };
        if (key === "batch") return (statements: D1PreparedStatement[]) => { counts.batch++; return target.batch(statements); };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const measure = async () => {
      counts.prepare = 0; counts.batch = 0;
      await batch(owner, makeEnv({ FACTORY: counted, CORE: { fetch: async () => new Response("{}", { status: 502 }) } as unknown as Fetcher, MOCK_CORE: "0" }));
      return { ...counts };
    };
    const before = await measure();
    for (let i = 0; i < 5; i++) await goLive(await draft(`batch-count-${i}.example`, "tv-3"));
    const after = await measure();
    // One batch of three statements. No statement per brand: a new live brand adds none.
    expect(after).toEqual(before);
    expect(after.batch).toBe(1);
    expect(after.prepare).toBeLessThanOrEqual(3);
  });

  it("sends an employee no money field", async () => {
    const id = await draft("batch-redact.example", "tv-3");
    await goLive(id);
    await attest(id, "test_sold");
    const response = await call("/api/brands/checklists", { cookie: employee, env: coreDown });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(id);
    expect(text).not.toMatch(/revenue|profit|cost_usd|payout/);
  });

  it("answers an empty map when no brand is live", async () => {
    // D1 keeps the brands of the earlier cases, so park them first.
    await env.FACTORY.prepare("UPDATE brands SET status='draft'").run();
    expect(await batch(owner)).toEqual({ brands: {} });
  });
});

describe("GET /api/brands/:id/checklist steps", () => {
  type Steps = { checklist: Array<{ item: string }>; steps: Array<{ item: string; done: boolean; evidence: string | null }> };
  const read = async (brandId: string) => {
    const response = await call(`/api/brands/${brandId}/checklist`, { cookie: owner, env: coreDown });
    expect(response.status).toBe(200);
    return (await response.json()) as Steps;
  };

  it("lists exactly the four steps as open, with null evidence, for a brand with nothing done", async () => {
    const id = await draft("steps-open.example");
    await goLive(id);
    const body = await read(id);
    expect(body.steps).toEqual([
      { item: "final_url", done: false, evidence: null },
      { item: "leadsgate_postbacks", done: false, evidence: null },
      { item: "test_sold", done: false, evidence: null },
      { item: "drain_route", done: false, evidence: null },
    ]);
    expect(body.checklist).toEqual([]);
  });

  it("marks every step done with a short evidence string for a complete brand and keeps the checklist rows", async () => {
    const id = await draft("steps-done.example");
    await goLive(id);
    for (const item of ["final_url", "leadsgate_postbacks", "test_sold", "drain_route"]) await attest(id, item);
    const body = await read(id);
    expect(body.steps.map((s) => [s.item, s.done])).toEqual([["final_url", true], ["leadsgate_postbacks", true], ["test_sold", true], ["drain_route", true]]);
    for (const step of body.steps) expect(step.evidence).toBe("owner · 2026-10-20T00:00:00.000Z");
    expect(body.checklist.map((r) => r.item).sort()).toEqual(["drain_route", "final_url", "leadsgate_postbacks", "test_sold"]);
  });

  it("marks only the attested step done for a partly finished brand", async () => {
    const id = await draft("steps-part.example");
    await goLive(id);
    await attest(id, "test_sold");
    const body = await read(id);
    expect(body.steps.filter((s) => s.done).map((s) => s.item)).toEqual(["test_sold"]);
    expect(body.steps.find((s) => s.item === "drain_route")).toEqual({ item: "drain_route", done: false, evidence: null });
  });
});
