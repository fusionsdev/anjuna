import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LifecycleBrandSummary } from "@anjuna/contracts";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;

beforeAll(async () => {
  await setupDatabases();
});

const install = (id: string, brand: string, kind: string, status: string, to: string | null, startedAt: string, finishedAt: string | null) =>
  env.FACTORY.prepare("INSERT OR IGNORE INTO installs (install_id,brand_id,kind,status,to_revision_id,started_by,started_role,started_at,finished_at) VALUES (?1,?2,?3,?4,?5,'owner-1','owner',?6,?7)")
    .bind(id, brand, kind, status, to, startedAt, finishedAt);

const listBrands = async (testEnv = makeEnv()) => {
  const response = await call("/api/lifecycle/brands", { cookie: owner, env: testEnv });
  expect(response.status).toBe(200);
  return ((await response.json()) as { brands: unknown[] }).brands.map((row) => LifecycleBrandSummary.parse(row));
};

beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  await env.FACTORY.batch([
    env.FACTORY.prepare("DELETE FROM installs WHERE brand_id IN ('brand-a','brand-b')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id,name,framework,created_by,created_at) VALUES ('tpl-1','Starter','astro','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,created_by,created_at) VALUES ('tv-1','tpl-1',1,'sha-1','templates/tv-1','sealed','owner','2026-10-01T00:00:00Z','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES ('fa-1','abcdef1','forms/fa-1','manifest','2026-01','form@abcdef1','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO brands (brand_id,name,account,domain,status,current_revision_id,created_by,created_at,updated_at) VALUES ('brand-a','Brand A','test-account','a.test','live','brand-a_rev_1','owner','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO brands (brand_id,name,account,domain,status,current_revision_id,created_by,created_at,updated_at) VALUES ('brand-b','Brand B','test-account','b.test','live','brand-b_rev_1','owner','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES ('brand-a_rev_1','brand-a',1,'tv-1','fa-1','{}','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES ('brand-b_rev_1','brand-b',1,'tv-1','fa-1','{}','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES ('brand-a_redeploy_inst-a2','brand-a',2,'tv-1','fa-1','{}','owner','2026-10-01T00:00:00Z')"),
  ]);
});

describe("latest_install on the lifecycle brand rows", () => {
  it("carries the newest install of each brand", async () => {
    await env.FACTORY.batch([
      install("inst-a1", "brand-a", "install", "ready", "brand-a_rev_1", "2026-10-20T01:00:00.000Z", "2026-10-20T01:04:00.000Z"),
      install("inst-a2", "brand-a", "upgrade", "failed", "brand-a_redeploy_inst-a2", "2026-10-21T01:00:00.000Z", "2026-10-21T01:05:00.000Z"),
    ]);
    const brands = await listBrands();
    const a = brands.find((b) => b.brand_id === "brand-a")!;
    expect(a.latest_install).toMatchObject({ install_id: "inst-a2", operation: "redeploy", status: "failed", started_by: "owner-1" });
  });

  it("breaks a started_at tie by install_id, descending", async () => {
    // inst-a3 and inst-a4 share started_at; inst-a4 wins.
    await env.FACTORY.batch([
      install("inst-a3", "brand-a", "rollback", "ready", "brand-a_rev_1", "2026-10-22T01:00:00.000Z", "2026-10-22T01:03:00.000Z"),
      install("inst-a4", "brand-a", "install", "ready", "brand-a_rev_1", "2026-10-22T01:00:00.000Z", "2026-10-22T01:06:00.000Z"),
    ]);
    const brands = await listBrands();
    expect(brands.find((b) => b.brand_id === "brand-a")!.latest_install!.install_id).toBe("inst-a4");
  });

  it("is null for a brand with no install row", async () => {
    const brands = await listBrands();
    expect(brands.find((b) => b.brand_id === "brand-b")!.latest_install).toBeNull();
  });

  it("is null for a core-only brand", async () => {
    const core = { fetch: async () => Response.json({ brands: [
      { brand_id: "brand-core-only", account: "test-account", hostnames: ["core-only.test", "www.core-only.test"], applied_revision_id: null, paused: true, bundle_form_version: null },
    ] }) } as unknown as Fetcher;
    const brands = await listBrands(makeEnv({ CORE_LIFECYCLE: core }));
    const row = brands.find((b) => b.brand_id === "brand-core-only")!;
    expect(row.status).toBe("unmanaged");
    expect(row.latest_install).toBeNull();
  });

  it("falls back to null for one brand when its newest install row has an unparsable started_at, and keeps the other brands", async () => {
    await env.FACTORY.batch([
      install("inst-a5", "brand-a", "install", "ready", "brand-a_rev_1", "not a date", "2026-10-21T01:04:00.000Z"),
      install("inst-b1", "brand-b", "install", "ready", "brand-b_rev_1", "2026-10-20T01:00:00.000Z", "2026-10-20T01:04:00.000Z"),
    ]);
    const brands = await listBrands();
    expect(brands.find((b) => b.brand_id === "brand-a")!.latest_install).toBeNull();
    expect(brands.find((b) => b.brand_id === "brand-b")!.latest_install).toMatchObject({ install_id: "inst-b1", operation: "install", status: "ready", started_by: "owner-1" });
  });

  it("picks the newest instant across mixed offsets and reports it as a Z timestamp", async () => {
    // inst-b1 07:00+07:00 is 00:00Z on the 21st; inst-b2 23:30-05:00 on the 20th is 04:30Z on the 21st. Text order says inst-b1.
    await env.FACTORY.batch([
      install("inst-b1", "brand-b", "install", "ready", "brand-b_rev_1", "2026-10-21T07:00:00+07:00", "2026-10-21T07:05:00+07:00"),
      install("inst-b2", "brand-b", "install", "failed", "brand-b_rev_1", "2026-10-20T23:30:00-05:00", null),
    ]);
    const brands = await listBrands();
    const latest = brands.find((b) => b.brand_id === "brand-b")!.latest_install;
    expect(latest).toMatchObject({ install_id: "inst-b2", status: "failed", started_at: "2026-10-21T04:30:00.000Z", finished_at: null });
  });

  it("keeps latest_install with a null finished_at when finished_at is unparsable", async () => {
    await env.FACTORY.batch([install("inst-b3", "brand-b", "install", "ready", "brand-b_rev_1", "2026-10-21T01:00:00.000Z", "garbage")]);
    const brands = await listBrands();
    expect(brands.find((b) => b.brand_id === "brand-b")!.latest_install).toMatchObject({ install_id: "inst-b3", finished_at: null });
  });

  it("is set on the single-brand read too", async () => {
    await env.FACTORY.batch([
      install("inst-a3", "brand-a", "rollback", "ready", "brand-a_rev_1", "2026-10-22T01:00:00.000Z", "2026-10-22T01:03:00.000Z"),
      install("inst-a4", "brand-a", "install", "ready", "brand-a_rev_1", "2026-10-22T01:00:00.000Z", "2026-10-22T01:06:00.000Z"),
    ]);
    const response = await call("/api/lifecycle/brands/brand-a", { cookie: owner });
    expect(response.status).toBe(200);
    const brand = LifecycleBrandSummary.parse(((await response.json()) as { brand: unknown }).brand);
    expect(brand.latest_install?.install_id).toBe("inst-a4");
  });
});
