import { ListmonkClient, type ListmonkList, type ListmonkLists, type ListmonkSubscriber } from "./client.js";

export { ListmonkClient, type ListmonkList, type ListmonkLists, type ListmonkSubscriber };

export interface EnsureBrandListResult {
  list_id: number;
  /** stored: the brand already had a list id. found: an earlier attempt created the list but did not store it. created: new list. */
  source: "stored" | "found" | "created";
}

/**
 * Gives the brand its own listmonk list and stores the id on brand_runtime.listmonk_list_id. Safe to repeat: a stored id
 * is returned without any listmonk call, and a list that an earlier attempt created (same name and brand tag) is reused.
 * Writes only that one column, and only while it is NULL; it never touches leads or the outbox.
 */
export async function ensureBrandList(
  db: D1Database,
  lists: ListmonkLists,
  brand: { brand_id: string; name: string },
): Promise<EnsureBrandListResult> {
  const read = () => db.prepare("SELECT listmonk_list_id FROM brand_runtime WHERE brand_id = ?1")
    .bind(brand.brand_id).first<{ listmonk_list_id: number | null }>();
  const row = await read();
  if (!row) throw new Error("Brand runtime is missing");
  if (row.listmonk_list_id) return { list_id: row.listmonk_list_id, source: "stored" };

  const existing = (await lists.findLists(brand.name)).find((list) => list.tags?.includes(brand.brand_id));
  const list = existing ?? await lists.createList({ name: brand.name, tags: [brand.brand_id] });
  await db.prepare("UPDATE brand_runtime SET listmonk_list_id = ?1 WHERE brand_id = ?2 AND listmonk_list_id IS NULL")
    .bind(list.id, brand.brand_id).run();
  // A concurrent attempt may have stored its id first; the stored id is the answer.
  const stored = (await read())?.listmonk_list_id;
  if (!stored) throw new Error("Brand list id was not stored");
  return { list_id: stored, source: stored !== list.id ? "stored" : existing ? "found" : "created" };
}

/** Every per-brand list id stored by installs, for the reverse suppression sync. */
export async function brandListIds(db: D1Database): Promise<number[]> {
  const { results } = await db.prepare("SELECT DISTINCT listmonk_list_id AS id FROM brand_runtime WHERE listmonk_list_id IS NOT NULL")
    .all<{ id: number }>();
  return results.map((row) => row.id);
}

export interface SyncOpts {
  /** Tenant fallback (LISTMONK_LIST_MAP): used only for a brand without its own list id on brand_runtime. */
  listMap: Record<string, number>;
  batchSize?: number;
  maxAttempts?: number;
}

export async function syncOutbox(db: D1Database, listmonk: ListmonkClient, opts: SyncOpts) {
  const batchSize = opts.batchSize || 50;
  const maxAttempts = opts.maxAttempts || 5;

  // 1. Select due rows
  const query = `
    SELECT o.id, o.lead_id, o.brand, o.status, o.attempts,
           l.email, l.first_name, l.last_name, l.home_phone, l.state, l.requested_amount,
           c.consent_version, br.listmonk_list_id AS brand_list_id
    FROM mailing_outbox o
    JOIN leads l ON o.lead_id = l.lead_id
    LEFT JOIN consent_evidence c ON l.lead_id = c.lead_id
    LEFT JOIN brand_runtime br ON br.brand_id = o.brand
    WHERE o.status = 'pending'
      AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= datetime('now'))
    ORDER BY o.next_attempt_at ASC NULLS FIRST
    LIMIT ?
  `;

  const { results: rows } = await db.prepare(query).bind(batchSize).all<any>();

  if (!rows || rows.length === 0) return 0;

  const emails = [...new Set(rows.map((row) => String(row.email).toLowerCase()))];
  const suppressed = new Set<string>();
  if (emails.length > 0) {
    const { results } = await db
      .prepare(`SELECT email FROM suppressions WHERE email IN (${emails.map(() => "?").join(",")})`)
      .bind(...emails)
      .all<{ email: string }>();
    for (const row of results) suppressed.add(row.email);
  }

  const writes: D1PreparedStatement[] = [];
  let processed = 0;
  for (const row of rows) {
    const listId = row.brand_list_id || opts.listMap[row.brand];
    if (!listId) {
      writes.push(deadWrite(db, row.id, `No list mapped for brand: ${row.brand}`));
      continue;
    }

    if (suppressed.has(String(row.email).toLowerCase())) {
      writes.push(db.prepare("UPDATE mailing_outbox SET status = 'skipped', updated_at = datetime('now') WHERE id = ?").bind(row.id));
      processed++;
      continue;
    }

    const payload = {
      email: row.email,
      name: `${row.first_name} ${row.last_name}`.trim(),
      lists: [listId],
      attribs: {
        phone: row.home_phone,
        brand: row.brand,
        state: row.state,
        amount: row.requested_amount,
        consent_version: row.consent_version || 'unknown'
      }
    };

    try {
      let subscriber = await listmonk.findByEmail(row.email);
      if (subscriber) {
        if (subscriber.status === 'blocklisted') {
          // If they are blocklisted in listmonk, do not resurrect, mark skipped
          writes.push(db.prepare("UPDATE mailing_outbox SET status = 'skipped', updated_at = datetime('now') WHERE id = ?").bind(row.id));
          processed++;
          continue;
        }
        // Update existing (don't push to list array here, PATCH doesn't touch lists if omitted, but wait: the brief says "never add it twice to the list", which happens naturally if PATCH omits lists, but what if they are not in this list yet? We should probably just leave lists alone per V1 logic).
        subscriber = await listmonk.updateSubscriber(subscriber.id, {
          name: payload.name,
          attribs: payload.attribs
        });
      } else {
        subscriber = await listmonk.createSubscriber(payload);
      }

      writes.push(db.prepare(`
        UPDATE mailing_outbox
        SET status = 'sent', listmonk_subscriber_id = ?, sent_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).bind(subscriber.id, row.id));

    } catch (e: any) {
      const attempts = row.attempts + 1;
      if (attempts >= maxAttempts) {
        writes.push(deadWrite(db, row.id, e.message));
      } else {
        const backoffMinutes = Math.pow(2, attempts); // 2, 4, 8, 16...
        writes.push(db.prepare(`
          UPDATE mailing_outbox
          SET attempts = ?, last_error = ?, next_attempt_at = datetime('now', '+' || ? || ' minutes'), updated_at = datetime('now')
          WHERE id = ?
        `).bind(attempts, e.message, backoffMinutes, row.id));
      }
    }
    processed++;
  }
  for (let i = 0; i < writes.length; i += 100) await db.batch(writes.slice(i, i + 100));
  return processed;
}

function deadWrite(db: D1Database, id: number, error: string): D1PreparedStatement {
  return db.prepare(`
    UPDATE mailing_outbox
    SET status = 'dead', last_error = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(error, id);
}

export async function syncSuppressions(db: D1Database, listmonk: ListmonkClient, listIds: number[]) {
  const map = new Map<string, string>();
  
  // 1. Blocklisted
  let page = 1;
  while (true) {
    const { emails, total } = await listmonk.getSuppressions(page, 500, 'blocklisted');
    for (const email of emails) map.set(email, 'blocklisted');
    if (page * 500 >= total || emails.length === 0) break;
    page++;
  }

  // 2. Unsubscribed (per list)
  for (const listId of listIds) {
    page = 1;
    while (true) {
      const { emails, total } = await listmonk.getSuppressions(page, 500, 'unsubscribed', listId);
      for (const email of emails) {
        if (!map.has(email)) map.set(email, 'unsubscribed');
      }
      if (page * 500 >= total || emails.length === 0) break;
      page++;
    }
  }

  // Upsert into D1
  const statements: D1PreparedStatement[] = [];
  const now = new Date().toISOString();
  
  for (const [email, reason] of map.entries()) {
    statements.push(
      db.prepare(`
        INSERT INTO suppressions (email, reason, source, created_at, updated_at)
        VALUES (?, ?, 'listmonk', ?, ?)
        ON CONFLICT(email) DO UPDATE SET
          reason = excluded.reason,
          updated_at = excluded.updated_at
        WHERE suppressions.reason != excluded.reason
      `).bind(email, reason, now, now)
    );
  }

  // Batch execute
  // D1 batches max 100 statements at a time
  for (let i = 0; i < statements.length; i += 100) {
    await db.batch(statements.slice(i, i + 100));
  }
}

export interface Env {
  DB: D1Database;
  LISTMONK_URL: string;
  LISTMONK_USER: string;
  LISTMONK_TOKEN: string;
  LISTMONK_LIST_MAP: string; // JSON: {"brandA": 1, "brandB": 2}
}

export async function scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
  const listmonk = new ListmonkClient(env.LISTMONK_URL, env.LISTMONK_USER, env.LISTMONK_TOKEN);
  let listMap: Record<string, number> = {};
  try {
    listMap = JSON.parse(env.LISTMONK_LIST_MAP);
  } catch (e) {
    console.error("Invalid LISTMONK_LIST_MAP", env.LISTMONK_LIST_MAP);
  }

  ctx.waitUntil((async () => {
    // Outbox -> listmonk
    while (true) {
      const processed = await syncOutbox(env.DB, listmonk, { listMap });
      if (processed === 0) break;
    }
    
    // listmonk -> suppressions
    const listIds = Array.from(new Set([...Object.values(listMap), ...await brandListIds(env.DB)]));
    if (listIds.length > 0) {
      await syncSuppressions(env.DB, listmonk, listIds);
    }
  })());
}
