import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, resetState, sessions, setupDatabases } from "./helpers";

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

const post = (cookie: string, path: string, body: unknown) => call(path, { cookie, method: "POST", body });
const zipSha = "2a83bf2a297d404bfa7c9d9fa794b1d026256def0240343772d12ab69c2703c2";
const body = (id: string, extra: Record<string, unknown> = {}) => ({
  form_artifact_id: id, template_version_id: "tv-1", git_sha: Buffer.from(id).toString("hex"),
  bundle_form_version: "form@a3e15df", payload_version: "2026-01", ...extra,
});
const row = (id: string) => env.FACTORY.prepare("SELECT git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version FROM form_artifacts WHERE form_artifact_id=?").bind(id).first();

// The release workflow prints the ZIP SHA-256 and the owner registers it here (docs/runbooks/form-artifact-release.md).
describe("registering a released form ZIP", () => {
  it("stores the ZIP SHA-256 as manifest_sha256 and keys the ZIP at forms/<id>", async () => {
    const created = await post(owner, "/api/form-artifacts", body("form-hash-1", { manifest_sha256: zipSha }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ form_artifact: { form_artifact_id: "form-hash-1", manifest_sha256: zipSha } });
    expect(await row("form-hash-1")).toEqual({
      git_sha: body("form-hash-1").git_sha, r2_key: "forms/form-hash-1", manifest_sha256: zipSha,
      payload_version: "2026-01", bundle_form_version: "form@a3e15df",
    });
  });

  it("keeps the placeholder when manifest_sha256 is absent", async () => {
    const created = await post(owner, "/api/form-artifacts", body("form-hash-2"));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ form_artifact: { form_artifact_id: "form-hash-2" } });
    expect(await row("form-hash-2")).toMatchObject({ manifest_sha256: "registered", r2_key: "forms/form-hash-2" });
  });

  it("lowercases an upper-case hash", async () => {
    expect((await post(owner, "/api/form-artifacts", body("form-hash-3", { manifest_sha256: zipSha.toUpperCase() }))).status).toBe(201);
    expect(await row("form-hash-3")).toMatchObject({ manifest_sha256: zipSha });
  });

  it.each([["63 hex chars", "a".repeat(63)], ["65 hex chars", "a".repeat(65)], ["a non-hex char", `${"a".repeat(63)}g`], ["an empty string", ""]])(
    "refuses %s with 422 and writes nothing",
    async (_name, hash) => {
      const response = await post(owner, "/api/form-artifacts", body("form-hash-bad", { manifest_sha256: hash }));
      expect(response.status).toBe(422);
      expect(await row("form-hash-bad")).toBeNull();
    },
  );

  it("audits the registration, refuses an Employee and a duplicate id", async () => {
    expect((await post(employee, "/api/form-artifacts", body("form-hash-4", { manifest_sha256: zipSha }))).status).toBe(403);
    expect(await row("form-hash-4")).toBeNull();
    expect((await post(owner, "/api/form-artifacts", body("form-hash-1", { manifest_sha256: zipSha }))).status).toBe(409);
    expect(await env.FACTORY.prepare("SELECT count(*) AS n FROM audit_log WHERE action='form_artifact.register' AND entity_id='form-hash-1'").first()).toEqual({ n: 1 });
  });
});
