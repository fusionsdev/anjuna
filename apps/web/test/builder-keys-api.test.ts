import { createHash } from "node:crypto";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BuilderKeyCreateResponse, BuilderKeyListResponse } from "@anjuna/contracts";
import { call, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;
beforeAll(setupDatabases);
beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
});

const post = (cookie: string, path: string, body: unknown = {}) => call(path, { cookie, method: "POST", body });

describe("builder keys API", () => {
  it("lets only an owner create, list and revoke keys; the secret is shown once and only its hash is stored", async () => {
    expect((await call("/api/builder-keys", { cookie: employee })).status).toBe(403);
    expect((await post(employee, "/api/builder-keys", { label: "x" })).status).toBe(403);

    const created = await post(owner, "/api/builder-keys", { label: "Somchai (bolt.new)" });
    expect(created.status).toBe(201);
    const { key, secret } = BuilderKeyCreateResponse.parse(await created.json());
    const stored = await env.FACTORY.prepare("SELECT key_hash, label FROM builder_keys WHERE key_id = ?1").bind(key.key_id).first();
    expect(stored).toEqual({ key_hash: createHash("sha256").update(secret).digest("hex"), label: "Somchai (bolt.new)" });

    const listed = BuilderKeyListResponse.parse(await (await call("/api/builder-keys", { cookie: owner })).json());
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(listed.keys.find((k) => k.key_id === key.key_id)).toMatchObject({ label: "Somchai (bolt.new)", last_used_at: null, revoked_at: null });

    const revoked = await post(owner, `/api/builder-keys/${key.key_id}/revoke`);
    expect(revoked.status).toBe(200);
    const revokedAt = ((await revoked.json()) as { key: { revoked_at: string } }).key.revoked_at;
    expect(revokedAt).toEqual(expect.any(String));
    const again = await post(owner, `/api/builder-keys/${key.key_id}/revoke`);
    expect(((await again.json()) as { key: { revoked_at: string } }).key.revoked_at).toBe(revokedAt);
    expect((await post(owner, "/api/builder-keys/bk_missing/revoke")).status).toBe(404);

    const audit = await env.FACTORY.prepare("SELECT action, after_json FROM audit_log WHERE entity_id = ?1 ORDER BY id").bind(key.key_id).all<{ action: string; after_json: string }>();
    expect(audit.results.map((r) => r.action)).toEqual(["builder_key.create", "builder_key.revoke"]);
    expect(audit.results.map((r) => r.after_json).join("")).not.toContain(secret);
  });

  it("rejects an empty or over-long label", async () => {
    for (const label of ["", "   ", "x".repeat(81)]) expect((await post(owner, "/api/builder-keys", { label })).status, label).toBe(422);
  });

  it("shows the last use the template MCP recorded", async () => {
    await env.FACTORY.prepare("INSERT OR IGNORE INTO builder_keys (key_id, label, key_hash, created_by, created_at, last_used_at) VALUES ('bk_used', 'used', ?1, 'system', '2026-10-01T00:00:00.000Z', '2026-10-17T08:00:00.000Z')")
      .bind("c".repeat(64)).run();
    const listed = BuilderKeyListResponse.parse(await (await call("/api/builder-keys", { cookie: owner })).json());
    expect(listed.keys.find((k) => k.key_id === "bk_used")?.last_used_at).toBe("2026-10-17T08:00:00.000Z");
  });
});
