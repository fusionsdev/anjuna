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
  it("owner creates a key; the list and the D1 row carry the plaintext and the hash; the audit row holds only the label", async () => {
    const created = await post(owner, "/api/builder-keys", { label: "Somchai (bolt.new)" });
    expect(created.status).toBe(201);
    const { key } = BuilderKeyCreateResponse.parse(await created.json());
    expect(key.secret).toMatch(/^anj_mcp_[A-Za-z0-9_-]{43}$/);

    const listed = BuilderKeyListResponse.parse(await (await call("/api/builder-keys", { cookie: owner })).json());
    expect(listed.keys.find((k) => k.key_id === key.key_id)).toMatchObject({ label: "Somchai (bolt.new)", secret: key.secret, last_used_at: null, revoked_at: null });

    const stored = await env.FACTORY.prepare("SELECT secret, key_hash FROM builder_keys WHERE key_id = ?1").bind(key.key_id).first<{ secret: string; key_hash: string }>();
    expect(stored?.secret).toBe(key.secret);
    expect(stored?.key_hash).toHaveLength(64);
    expect(stored?.key_hash).toBe(createHash("sha256").update(key.secret!).digest("hex"));

    const revoked = await post(owner, `/api/builder-keys/${key.key_id}/revoke`);
    expect(revoked.status).toBe(200);
    const revokedAt = ((await revoked.json()) as { key: { revoked_at: string } }).key.revoked_at;
    expect(revokedAt).toEqual(expect.any(String));
    const again = await post(owner, `/api/builder-keys/${key.key_id}/revoke`);
    expect(((await again.json()) as { key: { revoked_at: string } }).key.revoked_at).toBe(revokedAt);
    expect((await post(owner, "/api/builder-keys/bk_missing/revoke")).status).toBe(404);

    const audit = await env.FACTORY.prepare("SELECT action, after_json FROM audit_log WHERE entity_id = ?1 ORDER BY id").bind(key.key_id).all<{ action: string; after_json: string }>();
    expect(audit.results.map((r) => r.action)).toEqual(["builder_key.create", "builder_key.revoke"]);
    expect(JSON.parse(audit.results[0]!.after_json)).toEqual({ label: "Somchai (bolt.new)" });
    expect(audit.results.map((r) => r.after_json).join("")).not.toContain(key.secret!);
  });

  it("employee lists and creates keys but cannot revoke", async () => {
    expect((await call("/api/builder-keys", { cookie: employee })).status).toBe(200);

    const created = await post(employee, "/api/builder-keys", { label: "Malee (bolt.new)" });
    expect(created.status).toBe(201);
    const { key } = BuilderKeyCreateResponse.parse(await created.json());
    expect(key.secret).toMatch(/^anj_mcp_[A-Za-z0-9_-]{43}$/);

    const denied = await post(employee, `/api/builder-keys/${key.key_id}/revoke`);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "forbidden_role", required_role: "owner" });

    expect((await post(owner, `/api/builder-keys/${key.key_id}/revoke`)).status).toBe(200);
  });

  it("rejects an empty or over-long label", async () => {
    for (const label of ["", "   ", "x".repeat(81)]) expect((await post(owner, "/api/builder-keys", { label })).status, label).toBe(422);
  });

  it("shows the last use the template MCP recorded", async () => {
    await env.FACTORY.prepare("INSERT OR IGNORE INTO builder_keys (key_id, label, key_hash, secret, created_by, created_at, last_used_at) VALUES ('bk_used', 'used', ?1, NULL, 'system', '2026-10-01T00:00:00.000Z', '2026-10-17T08:00:00.000Z')")
      .bind("c".repeat(64)).run();
    const listed = BuilderKeyListResponse.parse(await (await call("/api/builder-keys", { cookie: owner })).json());
    const used = listed.keys.find((k) => k.key_id === "bk_used");
    expect(used?.last_used_at).toBe("2026-10-17T08:00:00.000Z");
    expect(used?.secret).toBeNull();
  });
});
