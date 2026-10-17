import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import factory from "../src/index";
import type { Env } from "../src/env";

const NOW = "2026-10-17T00:00:00.000Z";
beforeAll(() => applyD1Migrations(env.FACTORY, env.MIGRATIONS));

async function seedVersion(id: string, opts: { status?: string; screenshots?: boolean } = {}) {
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT INTO templates (template_id, name, framework, created_by, created_at) VALUES (?1, ?2, 'react_spa', 'bk_1', ?3)").bind(`t-${id}`, `Template ${id}`, NOW),
    env.FACTORY.prepare("INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, created_by, created_at) VALUES (?1, ?2, 1, ?3, 'k', ?4, 'bk_1', ?5)")
      .bind(id, `t-${id}`, id.padEnd(64, "0"), opts.status ?? "certified", NOW),
    ...["lint", "identity_scan"].map((check) =>
      env.FACTORY.prepare("INSERT INTO certifications (template_version_id, check_name, result, details_json, created_at) VALUES (?1, ?2, 'pass', '{}', ?3)").bind(id, check, NOW)),
  ]);
  for (const viewport of ["screenshot_desktop", "screenshot_mobile"]) {
    const key = `screenshots/${id}/run/${viewport}.png`;
    if (opts.screenshots !== false) await env.ARTIFACTS.put(key, new Uint8Array([137, 80, 78, 71]), { httpMetadata: { contentType: "image/png" } });
    await env.FACTORY.prepare("INSERT INTO certifications (template_version_id, check_name, result, details_json, artifact_r2_key, created_at) VALUES (?1, ?2, 'pass', '{}', ?3, ?4)").bind(id, viewport, key, NOW).run();
  }
}

const seal = (body: unknown) => factory.fetch(
  new Request("https://factory/seal-template", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  env as unknown as Env,
);
const status = async (id: string) => (await env.FACTORY.prepare("SELECT status, sealed_by FROM template_versions WHERE template_version_id = ?1").bind(id).first());
const sealAudits = async (id: string) => (await env.FACTORY.prepare("SELECT actor_id, actor_role FROM audit_log WHERE action = 'template.seal' AND entity_id = ?1").bind(id).all()).results;

describe("POST /seal-template", () => {
  it("seals a certified version with the owner's user id, once", async () => {
    await seedVersion("tv-a");
    const first = await seal({ template_version_id: "tv-a", sealed_by: "usr_owner", sealed_role: "owner" });
    expect(first.status).toBe(200);
    const body = await first.json() as { sealed_at: string };
    expect(body).toMatchObject({ ok: true, template_version_id: "tv-a", sealed_by: "usr_owner", already_sealed: false });
    expect(await status("tv-a")).toEqual({ status: "sealed", sealed_by: "usr_owner" });
    const again = await seal({ template_version_id: "tv-a", sealed_by: "usr_other_owner", sealed_role: "owner" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, template_version_id: "tv-a", sealed_by: "usr_owner", sealed_at: body.sealed_at, already_sealed: true });
    expect(await sealAudits("tv-a")).toEqual([{ actor_id: "usr_owner", actor_role: "owner" }]);
  });

  it("refuses an employee and changes nothing", async () => {
    await seedVersion("tv-b");
    const response = await seal({ template_version_id: "tv-b", sealed_by: "usr_emp", sealed_role: "employee" });
    expect([response.status, ((await response.json()) as { error: string }).error]).toEqual([403, "owner_required"]);
    expect(await status("tv-b")).toEqual({ status: "certified", sealed_by: null });
  });

  it("refuses a version that is not certified or lacks screenshot evidence", async () => {
    await seedVersion("tv-c", { status: "rejected" });
    const rejected = await seal({ template_version_id: "tv-c", sealed_by: "usr_owner", sealed_role: "owner" });
    expect([rejected.status, ((await rejected.json()) as { error: string }).error]).toEqual([409, "not_certified"]);
    await seedVersion("tv-d", { screenshots: false });
    const missing = await seal({ template_version_id: "tv-d", sealed_by: "usr_owner", sealed_role: "owner" });
    expect([missing.status, ((await missing.json()) as { error: string }).error]).toEqual([409, "missing_evidence"]);
    expect(await status("tv-d")).toEqual({ status: "certified", sealed_by: null });
  });

  it("answers 404 for an unknown version and 400 for a bad body", async () => {
    expect((await seal({ template_version_id: "tv-none", sealed_by: "usr_owner", sealed_role: "owner" })).status).toBe(404);
    expect((await seal({ template_version_id: "tv-none" })).status).toBe(400);
  });
});
