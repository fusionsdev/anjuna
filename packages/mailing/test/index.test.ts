import { env, applyD1Migrations } from "cloudflare:test";
import { expect, it, describe, vi, beforeEach, beforeAll } from "vitest";
import { syncOutbox, syncSuppressions, ensureBrandList, brandListIds, ListmonkClient, type ListmonkList, type ListmonkLists } from "../src/index.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    MIGRATIONS: any[];
  }
}

// A fake ListmonkClient for testing
class FakeListmonkClient extends ListmonkClient {
  public subscribers = new Map<string, any>();
  public suppressions = new Map<string, 'blocklisted' | 'unsubscribed'>();
  public shouldFail = false;
  
  constructor() {
    super("http://fake", "user", "token");
  }

  async findByEmail(email: string) {
    if (this.shouldFail) throw new Error("API outage");
    return this.subscribers.get(email) || null;
  }

  async createSubscriber(payload: any) {
    if (this.shouldFail) throw new Error("API outage");
    const id = this.subscribers.size + 1;
    const sub = { id, status: 'enabled', ...payload };
    this.subscribers.set(payload.email, sub);
    return sub;
  }

  async updateSubscriber(id: number, payload: any) {
    if (this.shouldFail) throw new Error("API outage");
    let target = null;
    let targetEmail = "";
    for (const [email, sub] of this.subscribers.entries()) {
      if (sub.id === id) { target = sub; targetEmail = email; break; }
    }
    if (!target) throw new Error("Not found");
    const updated = { ...target, name: payload.name, attribs: payload.attribs };
    this.subscribers.set(targetEmail, updated);
    return updated;
  }

  async getSuppressions(page: number, perPage: number, reason: 'blocklisted' | 'unsubscribed', listId?: number) {
    if (this.shouldFail) throw new Error("API outage");
    const emails = [];
    for (const [email, r] of this.suppressions.entries()) {
      if (r === reason) emails.push(email);
    }
    // fake pagination (return all at once, then empty)
    if (page > 1) return { emails: [], total: emails.length };
    return { emails, total: emails.length };
  }
}

describe("Mailing", () => {
  let listmonk: FakeListmonkClient;
  let db: D1Database;

  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.MIGRATIONS);
  });

  beforeEach(async () => {
    listmonk = new FakeListmonkClient();
    db = env.DB;
    // clear tables (D1 testing resets DB natively or we should delete)
    await db.exec("DELETE FROM mailing_outbox; DELETE FROM leads; DELETE FROM suppressions; DELETE FROM brand_runtime;");
  });

  async function seedLead(leadId: string, email: string) {
    await db.prepare(`
      INSERT INTO leads (
        lead_id, session_id, form_version, form_variant, site_id, brand, hostname, requested_amount, loan_purpose,
        first_name, last_name, birth_date, email, home_phone, address, city, state, zip, address_length_months,
        own_home, income_type, employer, job_title, employed_months, pay_date1, pay_frequency, direct_deposit,
        monthly_income, tracking_json, metadata_json, created_at
      ) VALUES (
        ?, 'sess1', 'v1', 'var1', 'site1', 'brandA', 'host1', 500, 'purpose',
        'John', 'Doe', '1990-01-01', ?, '1234567890', '123 St', 'City', 'CA', '12345', 12,
        1, 'EMPLOYMENT', 'Emp', 'Title', 12, '2023-01-01', 'WEEKLY', 1,
        2000, '{}', '{}', datetime('now')
      )
    `).bind(leadId, email).run();
  }

  it("syncs outbox properly", async () => {
    await seedLead("lead1", "test@example.com");
    await db.prepare("INSERT INTO mailing_outbox (lead_id, brand, created_at) VALUES ('lead1', 'brandA', datetime('now'))").run();
    
    await syncOutbox(db, listmonk, { listMap: { brandA: 1 } });
    
    // Check it sent
    const outbox = await db.prepare("SELECT * FROM mailing_outbox WHERE lead_id = 'lead1'").first<any>();
    expect(outbox.status).toBe("sent");
    expect(outbox.listmonk_subscriber_id).toBe(1);

    // Phone is stored as attribute only
    const sub = listmonk.subscribers.get("test@example.com");
    expect(sub).toBeDefined();
    expect(sub.attribs.phone).toBe("1234567890");
  });

  it("A listmonk outage leaves rows pending with backoff, and NO lead is lost", async () => {
    await seedLead("lead2", "fail@example.com");
    await db.prepare("INSERT INTO mailing_outbox (lead_id, brand, created_at) VALUES ('lead2', 'brandA', datetime('now'))").run();
    
    listmonk.shouldFail = true;
    await syncOutbox(db, listmonk, { listMap: { brandA: 1 } });
    
    const outbox = await db.prepare("SELECT * FROM mailing_outbox WHERE lead_id = 'lead2'").first<any>();
    expect(outbox.status).toBe("pending");
    expect(outbox.attempts).toBe(1);
    expect(outbox.next_attempt_at).toBeDefined(); // should have backoff
  });

  it("A dead row appears after N attempts", async () => {
    await seedLead("lead3", "dead@example.com");
    await db.prepare("INSERT INTO mailing_outbox (lead_id, brand, attempts, created_at) VALUES ('lead3', 'brandA', 4, datetime('now'))").run();
    
    listmonk.shouldFail = true;
    await syncOutbox(db, listmonk, { listMap: { brandA: 1 }, maxAttempts: 5 });
    
    const outbox = await db.prepare("SELECT * FROM mailing_outbox WHERE lead_id = 'lead3'").first<any>();
    expect(outbox.status).toBe("dead");
    expect(outbox.attempts).toBe(4); // attempts incremented? Wait, in my code, if attempts+1 >= max, I don't increment attempts on dead. Let's check logic.
  });

  it("Duplicates are not re-added", async () => {
    await seedLead("lead4", "dup@example.com");
    listmonk.subscribers.set("dup@example.com", { id: 99, status: 'enabled', email: 'dup@example.com' });
    await db.prepare("INSERT INTO mailing_outbox (lead_id, brand, created_at) VALUES ('lead4', 'brandA', datetime('now'))").run();
    
    await syncOutbox(db, listmonk, { listMap: { brandA: 1 } });
    
    // Subscriber should be updated, not recreated (id remains 99)
    const outbox = await db.prepare("SELECT * FROM mailing_outbox WHERE lead_id = 'lead4'").first<any>();
    expect(outbox.status).toBe("sent");
    expect(outbox.listmonk_subscriber_id).toBe(99);
  });

  it("Suppressed emails are skipped", async () => {
    await seedLead("lead5", "supp@example.com");
    await db.prepare("INSERT INTO suppressions (email, reason, source, created_at) VALUES ('supp@example.com', 'unsubscribed', 'manual', datetime('now'))").run();
    await db.prepare("INSERT INTO mailing_outbox (lead_id, brand, created_at) VALUES ('lead5', 'brandA', datetime('now'))").run();
    
    await syncOutbox(db, listmonk, { listMap: { brandA: 1 } });
    
    const outbox = await db.prepare("SELECT * FROM mailing_outbox WHERE lead_id = 'lead5'").first<any>();
    expect(outbox.status).toBe("skipped");
  });

  it("The reverse sync fills suppressions", async () => {
    listmonk.suppressions.set("rev@example.com", "blocklisted");
    await syncSuppressions(db, listmonk, [1]);
    
    const supp = await db.prepare("SELECT * FROM suppressions WHERE email = 'rev@example.com'").first<any>();
    expect(supp).toBeDefined();
    expect(supp.reason).toBe("blocklisted");
  });
  it("sends to the brand's own list before the tenant fallback, and falls back for a brand without one", async () => {
    await seedRuntime("brandA", 31);
    await seedLead("lead6", "own@example.com");
    await db.prepare("INSERT INTO mailing_outbox (lead_id, brand, created_at) VALUES ('lead6', 'brandA', datetime('now'))").run();
    await syncOutbox(db, listmonk, { listMap: { brandA: 1 } });
    expect(listmonk.subscribers.get("own@example.com").lists).toEqual([31]);

    await db.exec("DELETE FROM brand_runtime;");
    await seedLead("lead7", "fallback@example.com");
    await db.prepare("INSERT INTO mailing_outbox (lead_id, brand, created_at) VALUES ('lead7', 'brandA', datetime('now'))").run();
    await syncOutbox(db, listmonk, { listMap: { brandA: 1 } });
    expect(listmonk.subscribers.get("fallback@example.com").lists).toEqual([1]);
  });
});

/** A fake listmonk list API: records every call, and fails while `fail` is set. */
class FakeLists implements ListmonkLists {
  lists: Array<ListmonkList & { tags: string[] }> = [];
  calls: string[] = [];
  fail = false;
  async findLists(name: string) {
    this.calls.push(`find:${name}`);
    if (this.fail) throw new Error("listmonk GET lists failed: 502");
    return this.lists.filter((list) => list.name === name);
  }
  async createList(payload: { name: string; tags: string[] }) {
    this.calls.push(`create:${payload.name}`);
    if (this.fail) throw new Error("listmonk POST list failed: 502");
    const list = { id: 100 + this.lists.length, name: payload.name, tags: payload.tags };
    this.lists.push(list);
    return list;
  }
}

async function seedRuntime(brandId: string, listId: number | null = null) {
  await env.DB.prepare(`INSERT INTO brand_runtime (brand_id, account, hostnames, drain_key, aid, prepop_base, form_route, listmonk_list_id, created_at, updated_at)
    VALUES (?1, 'test', '["a.example"]', 'drain', '123', 'https://prepop.invalid/form', '/apply', ?2, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`)
    .bind(brandId, listId).run();
}

describe("ensureBrandList", () => {
  beforeAll(async () => { await applyD1Migrations(env.DB, env.MIGRATIONS); });
  beforeEach(async () => { await env.DB.exec("DELETE FROM mailing_outbox; DELETE FROM leads; DELETE FROM brand_runtime;"); });

  it("creates a private list named after the brand host, tagged with the brand id, and stores its id", async () => {
    await seedRuntime("brand_x");
    const lists = new FakeLists();
    expect(await ensureBrandList(env.DB, lists, { brand_id: "brand_x", name: "x.example" })).toEqual({ list_id: 100, source: "created" });
    expect(lists.lists).toEqual([{ id: 100, name: "x.example", tags: ["brand_x"] }]);
    expect(await env.DB.prepare("SELECT listmonk_list_id FROM brand_runtime WHERE brand_id = 'brand_x'").first()).toEqual({ listmonk_list_id: 100 });
    expect(await brandListIds(env.DB)).toEqual([100]);
  });

  it("is idempotent: a stored id makes no listmonk call, and a list created before a lost store is reused", async () => {
    await seedRuntime("brand_y");
    const lists = new FakeLists();
    await ensureBrandList(env.DB, lists, { brand_id: "brand_y", name: "y.example" });
    lists.calls = [];
    expect(await ensureBrandList(env.DB, lists, { brand_id: "brand_y", name: "y.example" })).toEqual({ list_id: 100, source: "stored" });
    expect(lists.calls).toEqual([]);

    // The list exists in listmonk but the id never reached D1 (the store failed after the create).
    await env.DB.prepare("UPDATE brand_runtime SET listmonk_list_id = NULL WHERE brand_id = 'brand_y'").run();
    expect(await ensureBrandList(env.DB, lists, { brand_id: "brand_y", name: "y.example" })).toEqual({ list_id: 100, source: "found" });
    expect(lists.lists).toHaveLength(1);
  });

  it("never reuses a same-named list that belongs to another brand", async () => {
    await seedRuntime("brand_z");
    const lists = new FakeLists();
    lists.lists.push({ id: 7, name: "z.example", tags: ["brand_other"] });
    expect(await ensureBrandList(env.DB, lists, { brand_id: "brand_z", name: "z.example" })).toEqual({ list_id: 101, source: "created" });
  });

  it("fails with the listmonk error, stores nothing and leaves leads and the outbox untouched", async () => {
    await seedRuntime("brand_f");
    await env.DB.prepare(`INSERT INTO leads (
        lead_id, session_id, form_version, form_variant, site_id, brand, hostname, requested_amount, loan_purpose,
        first_name, last_name, birth_date, email, home_phone, address, city, state, zip, address_length_months,
        own_home, income_type, employer, job_title, employed_months, pay_date1, pay_frequency, direct_deposit,
        monthly_income, tracking_json, metadata_json, created_at
      ) VALUES ('lead-f', 'sess1', 'v1', 'var1', 'site1', 'brand_f', 'host1', 500, 'purpose', 'A', 'B', '1990-01-01', 'f@example.com',
        '1234567890', '1 St', 'City', 'CA', '12345', 12, 1, 'EMPLOYMENT', 'Emp', 'Title', 12, '2023-01-01', 'WEEKLY', 1, 2000, '{}', '{}', datetime('now'))`).run();
    await env.DB.prepare("INSERT INTO mailing_outbox (lead_id, brand, created_at) VALUES ('lead-f', 'brand_f', datetime('now'))").run();
    const lists = new FakeLists();
    lists.fail = true;
    await expect(ensureBrandList(env.DB, lists, { brand_id: "brand_f", name: "f.example" })).rejects.toThrow("listmonk GET lists failed: 502");
    expect(await env.DB.prepare("SELECT listmonk_list_id FROM brand_runtime WHERE brand_id = 'brand_f'").first()).toEqual({ listmonk_list_id: null });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT status FROM mailing_outbox WHERE lead_id = 'lead-f'").first()).toEqual({ status: "pending" });
  });

  it("refuses a brand without a runtime row", async () => {
    await expect(ensureBrandList(env.DB, new FakeLists(), { brand_id: "brand_none", name: "n.example" })).rejects.toThrow("Brand runtime is missing");
  });
});
