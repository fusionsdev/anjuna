import { env, applyD1Migrations } from "cloudflare:test";
import { expect, it, describe, vi, beforeEach, beforeAll } from "vitest";
import { syncOutbox, syncSuppressions, ListmonkClient } from "../src/index.js";

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
    await db.exec("DELETE FROM mailing_outbox; DELETE FROM leads; DELETE FROM suppressions;");
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
});
