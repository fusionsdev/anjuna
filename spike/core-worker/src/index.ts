// AURUM v3 spike — core Worker. Owns D1 and the money path (V1 behavior, trimmed).
// Brand Workers call /rpc/* over HTTPS with a per-account write-only credential.

interface Env {
  DB: D1Database;
  RPC_TOKEN: string;        // per-account credential held by brand Workers
  ALLOWED_BRANDS: string;   // comma list of brand_ids this credential may write for
  POSTBACK_TOKEN: string;   // LeadsGate postback secret
  DRAIN_TOKEN: string;      // VPS drain bearer
  PREPOP_BASE: string;      // LeadsGate prepop form URL (fake in the spike)
  AID: string;
}

const MAX_PAYOUT_USD = 230;
const now = () => new Date().toISOString();
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function bearer(req: Request): string {
  return (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
}

function rpcAuthorized(req: Request, env: Env, brandId: string): boolean {
  if (!env.RPC_TOKEN || bearer(req) !== env.RPC_TOKEN) return false;
  return env.ALLOWED_BRANDS.split(",").map((s) => s.trim()).includes(brandId);
}

async function recordClick(req: Request, env: Env): Promise<Response> {
  const b = (await req.json()) as { brand_id: string; hostname: string; params: Record<string, string> };
  if (!rpcAuthorized(req, env, b.brand_id)) return json({ error: "unauthorized" }, 401);
  const p = b.params ?? {};
  const id = crypto.randomUUID();
  const utm = Object.fromEntries(Object.entries(p).filter(([k]) => k.startsWith("utm_")));
  await env.DB.prepare(
    `INSERT INTO click_sessions (click_session_id, brand_id, hostname, gclid, gbraid, wbraid, msclkid, keyword, utm_json, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`
  ).bind(id, b.brand_id, b.hostname, p.gclid ?? null, p.gbraid ?? null, p.wbraid ?? null, p.msclkid ?? null,
    p.keyword ?? null, JSON.stringify(utm), now()).run();
  return json({ click_session_id: id });
}

async function submitLead(req: Request, env: Env): Promise<Response> {
  const b = (await req.json()) as {
    brand_id: string; hostname: string; click_session_id?: string;
    lead: { lead_id: string; requested_amount: number; zip: string; first_name: string; last_name: string;
            email: string; home_phone: string; consent: boolean; keyword?: string };
  };
  if (!rpcAuthorized(req, env, b.brand_id)) return json({ error: "unauthorized" }, 401);
  // Accept the real AURUM form payload (V1 shape: {lead_id, lead:{...}, consent:{...}, tracking:{...}})
  // as well as the flat spike shape.
  const raw = b.lead as unknown as Record<string, any>;
  const l = raw && typeof raw.lead === "object"
    ? {
        ...raw.lead,
        lead_id: raw.lead_id,
        requested_amount: Number(raw.lead.requested_amount),
        consent: raw.consent?.application_consent === true,
        keyword: raw.tracking?.keyword,
      } as typeof b.lead
    : b.lead;
  const amt = Number(l.requested_amount);
  if (!Number.isFinite(amt) || amt < 100 || amt > 5000) return json({ status: "invalid", message: "Invalid requested amount" }, 400);
  const phone = String(l.home_phone ?? "").replace(/\D/g, "");
  if (!/^[0-9a-f-]{36}$/i.test(l.lead_id ?? "")) return json({ status: "invalid", message: "Invalid lead id" }, 400);
  if (!l.consent) return json({ status: "invalid", message: "Consent is required" }, 400);
  if (!/^\d{5}$/.test(l.zip ?? "")) return json({ status: "invalid", message: "Invalid ZIP" }, 400);
  if (phone.length !== 10) return json({ status: "invalid", message: "Phone must be 10 digits" }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l.email ?? "")) return json({ status: "invalid", message: "Invalid email" }, 400);

  // V1 idempotency: same client lead_id returns the existing lead.
  const existing = await env.DB.prepare("SELECT lead_id FROM leads WHERE lead_id = ?1").bind(l.lead_id).first();
  let click: Record<string, string | null> | null = null;
  if (b.click_session_id) {
    click = await env.DB.prepare(
      "SELECT click_session_id, gclid, gbraid, wbraid, msclkid, keyword FROM click_sessions WHERE click_session_id = ?1 AND brand_id = ?2"
    ).bind(b.click_session_id, b.brand_id).first();
  }
  const token = crypto.randomUUID().replace(/-/g, "");
  const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const stmts: D1PreparedStatement[] = [];
  if (!existing) {
    stmts.push(env.DB.prepare(
      `INSERT INTO leads (lead_id, brand_id, hostname, requested_amount, zip, first_name, last_name, email, home_phone,
        keyword, gclid, gbraid, wbraid, msclkid, click_session_id, status, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'handoff_ready',?16)`
    ).bind(l.lead_id, b.brand_id, b.hostname, Math.round(Number(l.requested_amount)), l.zip, l.first_name, l.last_name,
      l.email.toLowerCase(), phone, l.keyword ?? click?.keyword ?? null, click?.gclid ?? null, click?.gbraid ?? null,
      click?.wbraid ?? null, click?.msclkid ?? null, click?.click_session_id ?? null, now()));
    if (click) {
      // V1 single-use claim.
      stmts.push(env.DB.prepare(
        "UPDATE click_sessions SET claimed_lead_id = ?1 WHERE click_session_id = ?2 AND claimed_lead_id IS NULL"
      ).bind(l.lead_id, click.click_session_id));
    }
  }
  stmts.push(env.DB.prepare("INSERT INTO continuations (token, lead_id, expires_at) VALUES (?1,?2,?3)").bind(token, l.lead_id, expires));
  await env.DB.batch(stmts);
  return json({ status: existing ? "duplicate" : "accepted", continuation: token, lead_id: l.lead_id });
}

async function resolveContinuation(req: Request, env: Env): Promise<Response> {
  const b = (await req.json()) as { brand_id: string; token: string };
  if (!rpcAuthorized(req, env, b.brand_id)) return json({ error: "unauthorized" }, 401);
  const row = await env.DB.prepare(
    `SELECT l.* FROM continuations c JOIN leads l ON l.lead_id = c.lead_id
     WHERE c.token = ?1 AND c.expires_at > ?2 AND l.brand_id = ?3`
  ).bind(b.token, now(), b.brand_id).first<Record<string, string | number>>();
  if (!row) return json({ error: "not_found" }, 404);
  // V1 buildUserRedirect (prepop_redirect): fields as GET params, click_id = lead_id without hyphens.
  const u = new URL(env.PREPOP_BASE);
  const fields: Record<string, string> = {
    requested_amount: String(row.requested_amount), zip: String(row.zip),
    first_name: String(row.first_name), last_name: String(row.last_name),
    email: String(row.email), home_phone: String(row.home_phone),
    aid: env.AID, click_id: String(row.lead_id).replace(/-/g, ""),
  };
  for (const [k, v] of Object.entries(fields)) u.searchParams.set(k, v);
  return json({ url: u.toString() });
}

async function postback(req: Request, env: Env): Promise<Response> {
  const q = new URL(req.url).searchParams;
  if (!env.POSTBACK_TOKEN || q.get("token") !== env.POSTBACK_TOKEN) return json({ status: "unauthorized" }, 401);
  const cid = (q.get("cid") ?? "").trim();
  const type = (q.get("type") ?? "").trim();
  let payout = Number(q.get("payout") ?? "0");
  if (!Number.isFinite(payout) || payout < 0) payout = 0;
  payout = Math.min(payout, MAX_PAYOUT_USD);
  if (!cid || !["newLead", "soldLead", "rejectLead"].includes(type)) return json({ status: "invalid" }, 400);
  const lead = await env.DB.prepare(
    "SELECT lead_id, brand_id, hostname, gclid, gbraid, wbraid, msclkid FROM leads WHERE replace(lead_id,'-','') = ?1"
  ).bind(cid.replace(/-/g, "")).first<Record<string, string | null>>();
  if (!lead) return json({ status: "unmatched" });
  const stmts: D1PreparedStatement[] = [];
  if (type === "soldLead" && payout > 0 && (lead.gclid || lead.gbraid || lead.wbraid || lead.msclkid)) {
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO conversion_uploads (lead_id, brand, hostname, gclid, gbraid, wbraid, msclkid, value, occurred_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)`
    ).bind(lead.lead_id, lead.brand_id, lead.hostname, lead.gclid, lead.gbraid, lead.wbraid, lead.msclkid, payout, now()));
  }
  stmts.push(env.DB.prepare(
    "INSERT OR IGNORE INTO postback_events (lead_id, event_type, payout, created_at) VALUES (?1,?2,?3,?4)"
  ).bind(lead.lead_id, type, payout, now()));
  stmts.push(env.DB.prepare(
    "UPDATE leads SET status = ?1 WHERE lead_id = ?2 AND status != 'soldLead'"
  ).bind(type, lead.lead_id));
  await env.DB.batch(stmts);
  return json({ status: "ok" });
}

async function pending(req: Request, env: Env): Promise<Response> {
  if (!env.DRAIN_TOKEN || bearer(req) !== env.DRAIN_TOKEN) return json({ error: "unauthorized" }, 401);
  const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get("limit") ?? "100"), 1), 500);
  const t = now();
  const lease = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const rows = await env.DB.prepare(
    `UPDATE conversion_uploads SET status = 'processing', lease_until = ?1, updated_at = ?2
     WHERE lead_id IN (SELECT lead_id FROM conversion_uploads
       WHERE (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?2))
          OR (status = 'processing' AND lease_until <= ?2) LIMIT ?3)
     RETURNING lead_id, gclid, gbraid, wbraid, msclkid, value, currency, occurred_at, attempts, brand, hostname`
  ).bind(lease, t, limit).all();
  const conversions = (rows.results ?? []).map((r: Record<string, unknown>) => ({ ...r, google_order_id: r.lead_id }));
  return json({ conversions });
}

async function ack(req: Request, env: Env): Promise<Response> {
  if (!env.DRAIN_TOKEN || bearer(req) !== env.DRAIN_TOKEN) return json({ error: "unauthorized" }, 401);
  const b = (await req.json()) as { results: { lead_id: string; status: "uploaded" | "failed" | "deferred" }[] };
  const stmts = (b.results ?? []).map((r) => {
    if (r.status === "uploaded") {
      return env.DB.prepare("UPDATE conversion_uploads SET status='uploaded', lease_until=NULL, updated_at=?2 WHERE lead_id=?1").bind(r.lead_id, now());
    }
    // V1 backoff: retry up to 6 attempts, then dead.
    return env.DB.prepare(
      `UPDATE conversion_uploads SET attempts = attempts + 1,
         status = CASE WHEN attempts + 1 >= 6 THEN 'dead' ELSE 'pending' END,
         next_attempt_at = ?2, lease_until = NULL, updated_at = ?3 WHERE lead_id = ?1`
    ).bind(r.lead_id, new Date(Date.now() + 15 * 60 * 1000).toISOString(), now());
  });
  if (stmts.length) await env.DB.batch(stmts);
  return json({ status: "accepted", acked: stmts.length });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    try {
      if (req.method === "POST" && pathname === "/rpc/recordClick") return await recordClick(req, env);
      if (req.method === "POST" && pathname === "/rpc/submitLead") return await submitLead(req, env);
      if (req.method === "POST" && pathname === "/rpc/resolveContinuation") return await resolveContinuation(req, env);
      if ((req.method === "GET" || req.method === "POST") && pathname === "/api/postback") return await postback(req, env);
      if (req.method === "GET" && pathname === "/api/conversions/pending") return await pending(req, env);
      if (req.method === "POST" && pathname === "/api/conversions/ack") return await ack(req, env);
      if (req.method === "GET" && pathname === "/api/health") return json({ ok: true });
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.error("core_error", pathname, String(err));
      return json({ error: "internal" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
