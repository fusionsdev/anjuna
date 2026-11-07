import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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

type Batch = { brands: Record<string, { checklist: Array<Record<string, unknown>>; template_approved: boolean }> };
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

  it("marks a brand whose template still waits for approval", async () => {
    const waiting = await draft("batch-waiting.example");
    const approved = await draft("batch-approved.example");
    await goLive(waiting);
    await goLive(approved);
    await env.FACTORY.prepare("UPDATE brand_revisions SET template_version_id='tv-cert' WHERE brand_id=?1").bind(waiting).run();
    const body = await batch(owner);
    expect(body.brands[waiting]!.template_approved).toBe(false);
    expect(body.brands[approved]!.template_approved).toBe(true);
  });

  it("answers an empty map when no brand is live", async () => {
    // D1 keeps the brands of the earlier cases, so park them first.
    await env.FACTORY.prepare("UPDATE brands SET status='draft'").run();
    expect(await batch(owner)).toEqual({ brands: {} });
  });
});
