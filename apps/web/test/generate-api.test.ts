import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InstallWithReceipts } from "@anjuna/contracts";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let employee: string;

beforeAll(async () => { await setupDatabases(); });
beforeEach(async () => {
  resetState();
  employee = await sessions.employee();
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id,name,framework,created_by,created_at) VALUES ('tpl-1','Starter','astro','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,created_by,created_at) VALUES ('tv-1','tpl-1',1,'sha-1','templates/tv-1','sealed','owner','2026-10-01T00:00:00Z','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES ('fa-1','abcdef1','forms/fa-1','manifest','2026-01','form@abcdef1','2026-10-01T00:00:00Z')"),
  ]);
});

const profile = {
  contact: { phone: "+1 555 0100", address: "1 Main St, Dallas TX", email: "help@generate.example" },
  disclosures: { term_min_months: 3, term_max_months: 36, apr_max: 35.99 },
};

async function draft(domain: string, withProfile: Record<string, unknown> | undefined = profile): Promise<string> {
  const response = await call("/api/brands/drafts", { cookie: employee, method: "POST", body: { domain, keyword_default: "Quick Loan", template_version_id: "tv-1", ...(withProfile ? { profile: withProfile } : {}) } });
  expect(response.status).toBe(201);
  return (await response.json() as { brand: { brand_id: string } }).brand.brand_id;
}

function factory() {
  const dispatched: Array<Record<string, unknown>> = [];
  const worker = { fetch: async (request: Request) => {
    dispatched.push(await request.json());
    return Response.json({ ok: true });
  } } as unknown as Fetcher;
  return { dispatched, env: makeEnv({ FACTORY_WORKER: worker }) };
}

const generate = (brandId: string, testEnv: ReturnType<typeof makeEnv>, cookie = employee) =>
  call(`/api/brands/${brandId}/generate`, { cookie, method: "POST", body: {}, env: testEnv });

describe("POST /api/brands/:id/generate", () => {
  it("validates the draft and starts the install through the install path (201)", async () => {
    const brandId = await draft("generate-ok.example");
    const f = factory();
    const response = await generate(brandId, f.env);
    expect(response.status).toBe(201);
    const body = await response.json() as { install_id: string; status: string };
    expect(body).toMatchObject({ brand_id: brandId, status: "running" });
    expect(f.dispatched).toEqual([expect.objectContaining({ install_id: body.install_id, brand_id: brandId, revision_id: `${brandId}_rev_1` })]);
    expect(await env.FACTORY.prepare("SELECT kind,status FROM installs WHERE brand_id=?1").bind(brandId).all().then((r) => r.results))
      .toEqual([{ kind: "install", status: "running" }]);
  });

  it("is idempotent: a second call while the install runs returns the same install id and dispatches nothing", async () => {
    const brandId = await draft("generate-twice.example");
    const f = factory();
    const first = await (await generate(brandId, f.env)).json() as { install_id: string };
    const second = await generate(brandId, f.env);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ install_id: first.install_id, brand_id: brandId, status: "running", idempotent: true });
    // A queued install (dispatch not yet confirmed) counts too.
    await env.FACTORY.prepare("UPDATE installs SET status='queued' WHERE install_id=?1").bind(first.install_id).run();
    expect(await (await generate(brandId, f.env)).json()).toMatchObject({ install_id: first.install_id, status: "queued", idempotent: true });
    expect(f.dispatched).toHaveLength(1);
    expect(Number((await env.FACTORY.prepare("SELECT count(*) AS n FROM installs WHERE brand_id=?1").bind(brandId).first<{ n: number }>())!.n)).toBe(1);
  });

  it("answers concurrent calls with one install", async () => {
    const brandId = await draft("generate-race.example");
    const f = factory();
    const responses = await Promise.all([generate(brandId, f.env), generate(brandId, f.env), generate(brandId, f.env)]);
    const ids = new Set(await Promise.all(responses.map(async (r) => (await r.json() as { install_id: string }).install_id)));
    expect(ids.size).toBe(1);
    expect(responses.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(f.dispatched).toHaveLength(1);
  });

  it("refuses an incomplete draft with Thai + English issues and starts nothing", async () => {
    const brandId = await draft("generate-missing.example", { contact: { phone: "+1 555 0100" } });
    const f = factory();
    const response = await generate(brandId, f.env);
    expect(response.status).toBe(422);
    const body = await response.json() as { error: string; issues: Array<{ field: string; message: string }> };
    expect(body.error).toBe("draft_incomplete");
    expect(body.issues.map((issue) => issue.field)).toEqual([
      "profile.contact.address", "profile.contact.email",
      "profile.disclosures.term_min_months", "profile.disclosures.term_max_months", "profile.disclosures.apr_max",
    ]);
    expect(body.issues[0]!.message).toBe("ต้องระบุที่อยู่ (Address is required)");
    expect(f.dispatched).toEqual([]);
    expect(await env.FACTORY.prepare("SELECT count(*) AS n FROM installs WHERE brand_id=?1").bind(brandId).first()).toEqual({ n: 0 });
  });

  it("refuses a draft whose template is no longer sealed", async () => {
    const brandId = await draft("generate-unsealed.example");
    await env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,created_by,created_at) VALUES ('tv-draft','tpl-1',9,'sha-9','templates/tv-9','draft','owner','2026-10-01T00:00:00Z')").run();
    await env.FACTORY.prepare("UPDATE brand_revisions SET template_version_id='tv-draft' WHERE brand_id=?1").bind(brandId).run();
    const response = await generate(brandId, factory().env);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ issues: [{ field: "template_version_id" }] });
  });

  it("refuses a live brand, an unknown brand and another active operation", async () => {
    const f = factory();
    expect((await generate("brand_missing", f.env)).status).toBe(404);
    const live = await draft("generate-live.example");
    await env.FACTORY.prepare("UPDATE brands SET status='live' WHERE brand_id=?1").bind(live).run();
    expect((await generate(live, f.env)).status).toBe(409);
    const rolling = await draft("generate-rollback.example");
    await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,started_by,started_at) VALUES ('rb-1',?1,'rollback','running','owner',?2)").bind(rolling, new Date().toISOString()).run();
    const response = await generate(rolling, f.env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "lifecycle_operation_active", active_install_id: "rb-1", active_kind: "rollback" });
    expect(f.dispatched).toEqual([]);
  });
});

describe("install detail", () => {
  it("passes a step warning through next to the status", async () => {
    const brandId = await draft("warning-detail.example");
    await env.FACTORY.batch([
      env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,started_by,started_at) VALUES ('ins-warn',?1,'install','ready','employee',?2)").bind(brandId, new Date().toISOString()),
      env.FACTORY.prepare("INSERT INTO install_receipts (install_id,step,status,output_json,created_at) VALUES ('ins-warn','sync_runtime','ok',?1,?2)")
        .bind(JSON.stringify({ mailing_list: { state: "fallback", list_id: null }, warning: "Mailing list: listmonk down (502)" }), new Date().toISOString()),
    ]);
    const response = await call("/api/installs/ins-warn", { cookie: employee });
    expect(InstallWithReceipts.parse(await response.json()).receipts).toEqual([{ step: "sync_runtime", status: "ready", warning: "Mailing list: listmonk down (502)" }]);
  });
});

describe("final_url checklist computed from the smoke receipt", () => {
  const checklist = async (brandId: string) => {
    const response = await call(`/api/brands/${brandId}/checklist`, { cookie: employee, env: makeEnv({ CORE: { fetch: async () => { throw new Error("core down"); } } as unknown as Fetcher, MOCK_CORE: "0" }) });
    expect(response.status).toBe(200);
    return (await response.json() as { checklist: Array<Record<string, unknown>> }).checklist;
  };
  const smoke = (installId: string, brandId: string, status: string, output: Record<string, unknown>, at: string) => env.FACTORY.batch([
    env.FACTORY.prepare("INSERT OR IGNORE INTO installs (install_id,brand_id,kind,status,started_by,started_at) VALUES (?1,?2,'install','ready','employee',?3)").bind(installId, brandId, at),
    env.FACTORY.prepare("INSERT INTO install_receipts (install_id,step,status,output_json,created_at) VALUES (?1,'smoke',?2,?3,?4)").bind(installId, status, JSON.stringify(output), at),
  ]);

  it("ticks final_url when the newest smoke passed on the live URL, without a D1 checklist write", async () => {
    const brandId = await draft("final-url.example");
    await smoke("ins-fu-1", brandId, "ok", { apex_status: 200, final_url: "https://final-url.example/" }, "2026-10-20T00:00:00.000Z");
    expect(await checklist(brandId)).toEqual([{
      item: "final_url",
      evidence: { brand_id: brandId, item: "final_url", actor_id: "system:smoke", verified_at: "2026-10-20T00:00:00.000Z" },
      confirmed_by: "system:smoke", confirmed_role: "system", confirmed_at: "2026-10-20T00:00:00.000Z",
    }]);
    expect(await env.FACTORY.prepare("SELECT count(*) AS n FROM brand_checklist WHERE brand_id=?1").bind(brandId).first()).toEqual({ n: 0 });
  });

  it("leaves final_url open with no smoke, after a newer failed smoke, and ignores a paused-brand smoke", async () => {
    const brandId = await draft("final-url-open.example");
    expect(await checklist(brandId)).toEqual([]);
    await smoke("ins-fu-2", brandId, "ok", { apex_status: 200, final_url: "https://final-url-open.example/" }, "2026-10-20T00:00:00.000Z");
    await smoke("ins-fu-3", brandId, "failed", { error: "Smoke: apex returned 500 (expected 200; cf-ray=unknown)" }, "2026-10-21T00:00:00.000Z");
    expect(await checklist(brandId)).toEqual([]);
    await smoke("ins-fu-4", brandId, "ok", { apex_status: 200, final_url: "https://final-url-open.example/" }, "2026-10-22T00:00:00.000Z");
    // A later smoke of a paused brand checks the pause page, not the landing page: it neither ticks nor clears.
    await smoke("ins-fu-5", brandId, "ok", { apex_status: 503 }, "2026-10-23T00:00:00.000Z");
    expect((await checklist(brandId)).map((row) => [row.item, row.confirmed_at])).toEqual([["final_url", "2026-10-22T00:00:00.000Z"]]);
  });
});
