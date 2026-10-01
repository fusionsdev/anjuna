#!/usr/bin/env node
/**
 * conversion-drain — uploads sold-lead conversions to Google Ads OR Microsoft Ads
 * via the AdKit CLI, routing by which click id is present on each queued row.
 *
 *   gclid   -> Google Ads offline conversion   (adkit manage google conversions upload)
 *   msclkid -> Microsoft Ads offline conversion (adkit manage platform-api-requests --platform microsoft)
 *
 * Runs on the probe-relay VPS (needs the AdKit CLI installed + authenticated there:
 *   npm i -g @adkit/cli && adkit setup && adkit checkin --agent other
 * and Node 18+ for global fetch).
 *
 * Flow: poll the form's pending conversions -> upload -> ack.
 *
 * Config (env):
 *   FORM_BASE_URL              form origin, e.g. https://aurum-leads.pages.dev
 *   DRAIN_TOKEN                shared secret (matches the form's DRAIN_TOKEN)
 *
 *   # Google (gclid rows)
 *   GOOGLE_ADS_ACCOUNT         Google Ads customer id, e.g. 8733662880
 *   GOOGLE_CONVERSION_ACTION   conversion platformId, must be type upload_clicks, e.g. 7617826275
 *
 *   # Microsoft (msclkid rows)
 *   MICROSOFT_ACCOUNT          AdKit Microsoft account id (= the Bing Ads AccountId; adkit status -> microsoft.accounts[].id)
 *   MICROSOFT_CONVERSION_NAME  offline-conversion goal name (ConversionName field)
 *
 *   ADKIT_PROJECT              optional global --project override
 *   GOOGLE_PROJECT             optional --project override for gclid rows (wins over ADKIT_PROJECT)
 *   MICROSOFT_PROJECT          optional --project override for msclkid rows (wins over ADKIT_PROJECT)
 *   DRAIN_VALIDATE_ONLY        "true" = dry run (validates, does NOT import, does NOT ack)
 *   DRAIN_LIMIT                max rows per run (default 100)
 *
 * Project routing: AdKit connects ad accounts per project (e.g. Scratchpaypaw holds
 * the Microsoft account, PetVetPlans holds the Google account), so a drain that
 * serves both platforms must scope each upload to the project that owns the account.
 * Set GOOGLE_PROJECT / MICROSOFT_PROJECT to the respective adkit project ids.
 *
 * Schedule via cron every ~10 min (offline conversions tolerate delay).
 * See drain/README.md for the crontab line.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const {
  FORM_BASE_URL,
  DRAIN_TOKEN,
  GOOGLE_ADS_ACCOUNT,
  GOOGLE_CONVERSION_ACTION,
  MICROSOFT_ACCOUNT,
  MICROSOFT_CONVERSION_NAME,
  ADKIT_PROJECT,
  GOOGLE_PROJECT,
  MICROSOFT_PROJECT,
  DRAIN_VALIDATE_ONLY,
  DRAIN_LIMIT,
  BRAND_ROUTING_JSON,
} = process.env;

for (const [k, v] of Object.entries({
  FORM_BASE_URL,
  DRAIN_TOKEN,
})) {
  if (!v) {
    console.error(`Missing env: ${k}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Per-brand routing
//
// A Google click can only be imported into the account that generated it. Uploading everything
// to one hardcoded GOOGLE_ADS_ACCOUNT made Google answer "The click from the imported event is
// associated with a different Google Ads account" for every other brand, and those rows retried
// six times and died — real revenue that never reached the bidder.
//
// Shape (one entry per brand key, matched against the row's `brand` then its `hostname`):
//   {"loans together": {"account":"4811219623","conversionAction":"7754587837","project":"..."}}
//
// Absent env = legacy single-account behaviour, unchanged. That is deliberate: shipping this
// file without the variable must not alter what the drain already does.
// ---------------------------------------------------------------------------
const normalizeKey = (s) =>
  String(s ?? "").trim().toLowerCase().replace(/^www\./, "").replace(/[\s_-]+/g, " ");

let brandRouting = null;
if (BRAND_ROUTING_JSON) {
  try {
    const parsed = JSON.parse(BRAND_ROUTING_JSON);
    brandRouting = new Map(Object.entries(parsed).map(([k, v]) => [normalizeKey(k), v]));
    console.log(`[routing] per-brand routing active for ${brandRouting.size} brand key(s)`);
  } catch (e) {
    // Fail fast and loud. Silently falling back to one account is what produced the dead queue.
    console.error(`[routing] BRAND_ROUTING_JSON is not valid JSON: ${e?.message || e}`);
    process.exit(1);
  }
} else {
  console.log("[routing] BRAND_ROUTING_JSON unset — legacy single-account mode");
}

// Resolve a row to its destination account. Tries the brand name, then the hostname, because a
// lead written before `leads.brand` was populated still carries a hostname.
function resolveRoute(row) {
  if (!brandRouting) {
    return GOOGLE_ADS_ACCOUNT && GOOGLE_CONVERSION_ACTION
      ? { account: GOOGLE_ADS_ACCOUNT, conversionAction: GOOGLE_CONVERSION_ACTION, project: GOOGLE_PROJECT, source: "legacy" }
      : null;
  }
  for (const candidate of [row.brand, row.hostname]) {
    if (!candidate) continue;
    const hit = brandRouting.get(normalizeKey(candidate));
    if (hit) return { ...hit, source: `map:${normalizeKey(candidate)}` };
  }
  return null;
}

// Clamp the limit (a non-numeric DRAIN_LIMIT would otherwise send ?limit=NaN). Default 50 so a
// single run stays well under the server's lease window even at a few seconds per upload.
const limitRaw = Number(DRAIN_LIMIT);
const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? limitRaw : 50));
const validateOnly = DRAIN_VALIDATE_ONLY === "true";

// ISO8601 (e.g. 2026-07-18T12:00:00.000Z) -> Google's "YYYY-MM-DD HH:MM:SS+00:00".
function toGoogleTs(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+00:00`
  );
}

// ISO8601 -> Microsoft's UTC "YYYY-MM-DDTHH:MM:SSZ".
function toMicrosoftTs(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`
  );
}

// Token goes in the Authorization header (never the query string) so it stays out of logs.
const authHeaders = { Authorization: `Bearer ${DRAIN_TOKEN}` };

async function fetchPending() {
  // Claim rows (flip to 'processing') on a real run; peek=1 on a dry run so validate-only does
  // not mutate queue state.
  const peek = validateOnly ? "&peek=1" : "";
  const url = `${FORM_BASE_URL}/api/conversions/pending?limit=${limit}${peek}`;
  const res = await fetch(url, { headers: authHeaders });
  if (!res.ok) throw new Error(`pending fetch failed: HTTP ${res.status}`);
  const body = await res.json();
  return body.conversions || [];
}

async function ack(results) {
  const url = `${FORM_BASE_URL}/api/conversions/ack`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ results }),
  });
  if (!res.ok) throw new Error(`ack failed: HTTP ${res.status}`);
  return res.json();
}

// Build the `adkit` argv (plus the --project override if set).
function adkitArgs(args, projectOverride) {
  const out = [...args];
  const project = projectOverride || ADKIT_PROJECT;
  if (project) out.push("--project", project);
  return out;
}

// Run adkit and parse the JSON tail (AdKit may print a notice line before the JSON).
async function runAdkit(args) {
  const { stdout } = await exec("adkit", args, { maxBuffer: 8 * 1024 * 1024 });
  const start = stdout.indexOf("{");
  return JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
}

// Google Ads offline conversion upload (gclid/gbraid/wbraid rows).
async function uploadGoogle(row, route) {
  const conv = {
    conversionId: route.conversionAction,
    occurredAt: toGoogleTs(row.occurred_at),
    value: row.value,
    currency: row.currency || "USD",
    orderId: row.google_order_id || row.lead_id,
  };
  if (row.gclid) conv.gclid = row.gclid;
  else if (row.gbraid) conv.gbraid = row.gbraid;
  else if (row.wbraid) conv.wbraid = row.wbraid;
  else return { lead_id: row.lead_id, status: "failed", error: "no gclid/gbraid/wbraid" };

  const out = await runAdkit(adkitArgs([
    "manage", "google", "conversions", "upload",
    "--account", route.account,
    "--data", JSON.stringify({ conversions: [conv], validateOnly }),
    "--json",
  ], route.project || GOOGLE_PROJECT));
  const r = out?.upload?.results?.[0];
  const uploaded = (out?.upload?.uploadedCount ?? 0) > 0;
  const errText = String(r?.error ?? out?.error ?? "");
  const isDuplicate = /duplicate|already[\s_-]?exist|order[_\s]?id/i.test(errText);
  if (uploaded || isDuplicate || (validateOnly && r?.status !== "failed")) {
    return { lead_id: row.lead_id, status: "uploaded" };
  }

  // NOT-YET-READY, which is not a failure of this row and must not consume one of its six
  // attempts. Google refuses uploads to a conversion action for several hours after it is
  // created: "Can't import events to a conversion action that was just created. Try importing
  // again in 6 hours." Retry backoff reaches attempt six in about two and a half hours, so
  // treating this as a failure would dead-letter every conversion that arrived during the wait —
  // the row would be destroyed by a delay that resolves itself. Skipped rows are not acked, so
  // the claim lease expires and they return to pending untouched until the action is live.
  if (/just created|try importing again|not (yet )?(active|enabled|available)/i.test(errText)) {
    return { lead_id: row.lead_id, status: "skipped", error: `not ready yet: ${errText.slice(0, 120)}` };
  }

  return { lead_id: row.lead_id, status: "failed", error: r?.error || "upload failed" };
}

// Microsoft Ads offline conversion upload (msclkid rows) via Bing Ads v13 raw API.
async function uploadMicrosoft(row) {
  if (!MICROSOFT_ACCOUNT || !MICROSOFT_CONVERSION_NAME) {
    return { lead_id: row.lead_id, status: "failed", error: "missing Microsoft env (ACCOUNT/CONVERSION_NAME)" };
  }
  if (!row.msclkid) return { lead_id: row.lead_id, status: "failed", error: "no msclkid" };

  const payload = {
    AccountId: Number(MICROSOFT_ACCOUNT),
    OfflineConversions: [
      {
        MicrosoftClickId: row.msclkid,
        ConversionTime: toMicrosoftTs(row.occurred_at),
        ConversionValue: row.value,
        ConversionCurrencyCode: row.currency || "USD",
        ConversionName: MICROSOFT_CONVERSION_NAME,
      },
    ],
  };
  const endpoint =
    "https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/OfflineConversions/Apply";

  const out = await runAdkit(adkitArgs([
    "manage", "platform-api-requests",
    "--platform", "microsoft",
    "--endpoint", endpoint,
    "--payload", JSON.stringify(payload),
    "--account", MICROSOFT_ACCOUNT,
    "--publish",
    "--request-description", "Upload Microsoft offline conversion",
    "--json",
  ], MICROSOFT_PROJECT));

  // Top-level error (auth, endpoint, invalid parameter, etc.)
  if (out?.error) {
    return { lead_id: row.lead_id, status: "failed", error: String(out.error).slice(0, 300) };
  }

  // Per-conversion failures come back in PartialErrors (e.g. invalid click id),
  // NOT as a top-level error — a naive !out.error check would mark them "uploaded".
  const partialErrors = out?.results?.[0]?.raw?.PartialErrors ?? [];
  if (partialErrors.length > 0) {
    const err = partialErrors[0];
    const msg = String(err?.Message ?? err?.ErrorCode ?? "unknown");
    // Duplicate / already-uploaded is idempotent success (crash-recovery re-send).
    const isDuplicate = /duplicate|already/i.test(msg);
    if (isDuplicate) return { lead_id: row.lead_id, status: "uploaded" };
    return { lead_id: row.lead_id, status: "failed", error: `${err?.ErrorCode ?? ""}: ${msg}`.slice(0, 300) };
  }

  return { lead_id: row.lead_id, status: "uploaded" };
}

// Route a row by which click id is present (Microsoft msclkid wins when both set).
async function uploadOne(row) {
  try {
    if (row.msclkid) return await uploadMicrosoft(row);
    const route = resolveRoute(row);
    if (!route) {
      // SKIPPED, not failed. A failure is acked, which burns one of six attempts and drops the
      // row into the dead-letter state within the hour — that is how $73 of real conversions
      // were lost while the routing was wrong. A skipped row is left out of the ack entirely,
      // so its claim lease simply expires and it returns to pending, intact, until the brand is
      // mapped. Loud on every tick so an unmapped brand cannot sit here unnoticed.
      return {
        lead_id: row.lead_id,
        status: "skipped",
        error: `no route for brand=${row.brand ?? "null"} hostname=${row.hostname ?? "null"}`,
      };
    }
    return await uploadGoogle(row, route);
  } catch (e) {
    return { lead_id: row.lead_id, status: "failed", error: String(e?.message || e).slice(0, 300) };
  }
}

async function main() {
  const pending = await fetchPending();
  if (!pending.length) {
    console.log(`[${new Date().toISOString()}] no pending conversions`);
    return;
  }
  console.log(`[${new Date().toISOString()}] draining ${pending.length}${validateOnly ? " (validate-only)" : ""}`);

  const results = [];
  for (const row of pending) results.push(await uploadOne(row));

  const skipped = results.filter((r) => r.status === "skipped");
  const uploaded = results.filter((r) => r.status === "uploaded").length;
  const failed = results.filter((r) => r.status === "failed").length;

  const report = () => {
    for (const r of results.filter((x) => x.status === "failed")) console.log("  fail:", r.lead_id, r.error);
    for (const r of skipped) console.log("  SKIP:", r.lead_id, r.error);
  };

  if (validateOnly) {
    console.log(`validate-only: uploaded=${uploaded} failed=${failed} skipped=${skipped.length} (rows left pending, not acked)`);
    report();
    return;
  }

  // Skipped rows are acked as "deferred", which returns them to 'pending' with their attempt
  // counter untouched. Excluding them from the ack entirely — the first version of this — left
  // them sitting in 'processing', where the stale-lease reclaim picked them back up and
  // incremented attempts anyway, so two conversions still reached the dead-letter state while
  // waiting for a conversion action to finish activating. Not acking is not the same as
  // protecting.
  const ackable = results.map((r) => (r.status === "skipped" ? { ...r, status: "deferred" } : r));
  const { acked } = ackable.length ? await ack(ackable) : { acked: 0 };
  console.log(`uploaded=${uploaded} failed=${failed} skipped=${skipped.length} acked=${acked}`);
  report();
}

main().catch((e) => {
  console.error("drain error:", e);
  process.exit(1);
});
