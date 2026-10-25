import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AddSuppressionResponse,
  RemoveSuppressionResponse,
  SuppressionsResponse,
  type AdminRequestContext,
} from "@anjuna/contracts";
import { createHarness, type Harness } from "./helpers.js";

const owner: AdminRequestContext = {
  actor_id: "usr_owner_01",
  actor_role: "owner",
  request_id: "req_01HZX9K2M4N6P8Q0",
};
const employee: AdminRequestContext = {
  actor_id: "usr_emp_01",
  actor_role: "employee",
  request_id: "req_01HZX9K2M4N6P8Q1",
};

/** First 16 hex chars of SHA-256 of the lowercased address, as core audits it. */
const auditId = (email: string) => createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 16);

function post(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

let sh: Harness;
beforeAll(async () => {
  sh = await createHarness();
});
afterAll(async () => {
  await sh?.mf.dispose();
});

describe("POST /admin/suppressions and /admin/suppressions/remove (FUS-382)", () => {
  it("addSuppression inserts a manual row with added_by and answers 201", async () => {
    const response = await sh.admin("/admin/suppressions", owner, post({ email: "  New@Example.COM " }));
    expect(response.status).toBe(201);
    const row = AddSuppressionResponse.parse(await response.json());
    expect(row).toEqual({
      email: "new@example.com",
      reason: "manual",
      source: "manual",
      added_by: owner.actor_id,
      created_at: row.created_at,
      updated_at: null,
    });

    const stored = await sh.db
      .prepare("SELECT email, reason, source, added_by FROM suppressions WHERE email = 'new@example.com'")
      .first<{ email: string; reason: string; source: string; added_by: string | null }>();
    expect(stored).toEqual({ email: "new@example.com", reason: "manual", source: "manual", added_by: owner.actor_id });
  });

  it("addSuppression on an existing address answers 409", async () => {
    const before = await sh.db
      .prepare("SELECT count(*) AS count FROM suppressions WHERE email = 'new@example.com'")
      .first<{ count: number }>();
    const response = await sh.admin("/admin/suppressions", owner, post({ email: "new@example.com", reason: "bounce" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "conflict" });
    const after = await sh.db
      .prepare("SELECT count(*) AS count FROM suppressions WHERE email = 'new@example.com'")
      .first<{ count: number }>();
    expect(after!.count).toBe(before!.count);
  });

  it("removeSuppression deletes the row and answers 200", async () => {
    await sh.admin("/admin/suppressions", owner, post({ email: "gone@example.com" }));
    const response = await sh.admin("/admin/suppressions/remove", owner, post({ email: "gone@example.com" }));
    expect(response.status).toBe(200);
    expect(RemoveSuppressionResponse.parse(await response.json())).toEqual({ removed: true });
    expect(await sh.db.prepare("SELECT email FROM suppressions WHERE email = 'gone@example.com'").first()).toBeNull();
  });

  it("removeSuppression on an unknown address answers 404", async () => {
    const response = await sh.admin("/admin/suppressions/remove", owner, post({ email: "nobody@example.com" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found" });
  });

  it("an employee gets 403 on both writes", async () => {
    for (const path of ["/admin/suppressions", "/admin/suppressions/remove"]) {
      const denied = await sh.admin(path, employee, post({ email: "emp@example.com" }));
      expect(denied.status, path).toBe(403);
      expect(await denied.json(), path).toMatchObject({ error: "forbidden_role", required_role: "owner" });
    }
    expect(await sh.db.prepare("SELECT email FROM suppressions WHERE email = 'emp@example.com'").first()).toBeNull();
  });

  it("listSuppressions filters by added_by and by system", async () => {
    await sh.admin("/admin/suppressions", owner, post({ email: "mine@example.com" }));
    await sh.db
      .prepare("INSERT INTO suppressions (email, reason, source, created_at, updated_at) VALUES ('sync@example.com', 'blocklisted', 'listmonk', '2026-10-01T00:00:00.000Z', NULL)")
      .run();

    const list = async (query: string) => {
      const response = await sh.admin(`/admin/suppressions${query}`, owner);
      expect(response.status, query).toBe(200);
      return SuppressionsResponse.parse(await response.json());
    };
    expect((await list(`?added_by=${owner.actor_id}`)).rows.map((row) => row.email)).toContain("mine@example.com");
    expect((await list(`?added_by=${owner.actor_id}`)).rows.map((row) => row.email)).not.toContain("sync@example.com");
    for (const row of (await list(`?added_by=${owner.actor_id}`)).rows) expect(row.added_by).toBe(owner.actor_id);

    const system = await list("?added_by=system");
    expect(system.rows.map((row) => row.email)).toContain("sync@example.com");
    expect(system.rows.map((row) => row.email)).not.toContain("mine@example.com");
    for (const row of system.rows) expect(row.added_by).toBeNull();
  });

  it("suppression audit rows hold no address", async () => {
    const address = "audit-me@example.com";
    await sh.admin("/admin/suppressions", owner, post({ email: address, reason: "complaint" }));
    await sh.admin("/admin/suppressions/remove", owner, post({ email: address }));

    const rows = await sh.factory
      .prepare("SELECT action, entity_type, entity_id, before_json, after_json FROM audit_log WHERE entity_id = ?1 ORDER BY id")
      .bind(auditId(address))
      .all<{ action: string; entity_type: string; entity_id: string; before_json: string | null; after_json: string | null }>();
    expect(rows.results.map((row) => row.action)).toEqual(["suppression.add", "suppression.remove"]);
    for (const row of rows.results) {
      expect(row.entity_type).toBe("suppression");
      expect(row.entity_id).toBe(auditId(address));
      for (const field of [row.entity_id, row.before_json, row.after_json]) {
        expect(field ?? "", row.action).not.toContain(address);
      }
    }
    expect(JSON.parse(rows.results[0]!.after_json!)).toEqual({ reason: "complaint", source: "manual" });
  });
});
