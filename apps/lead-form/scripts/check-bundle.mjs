// FO-4 / AGENTS.md hard rule 4: "Brand bytes stay clean."
//
// Scans every file of a built form bundle and fails if it contains:
//   - any brand domain (the legacy brand list below, plus FORBIDDEN_DOMAINS from the env),
//   - any brand display name from the same list,
//   - the strings "anjuna" or "aurum" (case-insensitive),
//   - anything shaped like a PostHog project key or a Sentry DSN,
//   - any domain-shaped string in a text asset that is not on ALLOWED_DOMAINS.
//
// Usage: node scripts/check-bundle.mjs <dist-dir>
//   FORBIDDEN_DOMAINS="a.com,b.com" adds domains (CI/factory can pass every live brand domain).
//   FORBIDDEN_STRINGS="Brand X,Brand Y" adds literal strings.
//
// This file is NOT part of the bundle; the lists below exist only to be denied.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Every domain the legacy form's BRAND_BY_HOST map knew about, plus legacy/platform domains.
export const LEGACY_BRAND_DOMAINS = [
  "mybalancecred.com", "bearlendnow.com", "getbearcash.com", "pawpayfund.com", "paypawcare.com",
  "harborlinecredit.com", "carefundlng.com", "scratchpaypaw.com", "petvetplans.com",
  "simplevetcare.com", "dearcreeklendlng.com", "myfairloans.com", "loanstogether.com",
  "lendiely.com", "skratch-payments.com", "skratchpay-options.com", "carefunding.com",
  "aduplift.ai",
];

export const LEGACY_BRAND_NAMES = [
  "BALANCE CREDIT", "CASH LOANS BEAR", "PAWPAYFUND", "PAYPAWCARE", "HARBORLINE",
  "CARE FUNDING", "SCRATCHPAYPAW", "PETVETPLANS", "SIMPLEVETCARE", "DEER CREEK LENDING",
  "MYFAIRLENDING", "LOANS TOGETHER", "LENDLY",
];

export const FORBIDDEN_WORDS = ["anjuna", "aurum"];

export const SECRET_PATTERNS = [
  // PostHog project API keys: phc_ + 32+ url-safe chars. Personal keys: phx_.
  { name: "posthog-key", re: /ph[cx]_[A-Za-z0-9]{20,}/ },
  // Sentry DSN: scheme://<public key>@<host>/<project id>, public key is 32 hex chars.
  { name: "sentry-dsn", re: /https?:\/\/[0-9a-f]{32}(?::[0-9a-f]{32})?@[A-Za-z0-9.-]+(?::\d+)?\/\d+/ },
  // Any Sentry-hosted ingest endpoint.
  { name: "sentry-ingest-host", re: /[a-z0-9-]+\.ingest(?:\.[a-z]{2})?\.sentry\.io/i },
];

// Second line of defence for brand domains nobody listed: every domain-shaped string in a text
// asset must be on this allowlist (library/spec hosts and the form's own neutral placeholders).
export const ALLOWED_DOMAINS = new Set([
  "www.w3.org", // SVG/XML namespaces
  "react.dev", // React error-decoder links
  "docs.sentry.io", // Sentry SDK warning text
  "domain.com", // email placeholder copy ("name@domain.com")
  "placeholder.invalid", // Sentry placeholder DSN host (RFC 2606 reserved TLD)
]);
const DOMAIN_RE = /(?<![A-Za-z0-9_.$-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|ai|co|us|app|dev|loans|finance|money|credit|cash|vet)(?![A-Za-z0-9_$-])/gi;
const TEXT_EXT = /\.(?:js|mjs|css|html|json|txt|map|svg)$/i;

/** Domain-shaped strings in text that are not on ALLOWED_DOMAINS. */
export function unknownDomains(text, allowed = ALLOWED_DOMAINS) {
  const out = new Set();
  for (const m of text.matchAll(DOMAIN_RE)) {
    const d = m[0].toLowerCase();
    // Minified code is full of `x.co`-shaped property accesses; a two-label match whose first
    // label is 1-2 chars is treated as code, not a host.
    const labels = d.split(".");
    if (labels.length === 2 && labels[0].length <= 2) continue;
    if (!allowed.has(d)) out.add(d);
  }
  return [...out];
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function envList(name) {
  return (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Build the full rule list (built-ins + env additions). */
export function buildRules({ extraDomains = envList("FORBIDDEN_DOMAINS"), extraStrings = envList("FORBIDDEN_STRINGS") } = {}) {
  const rules = [];
  for (const d of [...LEGACY_BRAND_DOMAINS, ...extraDomains]) {
    // Match the domain as a host label sequence, not as a substring of a longer word.
    rules.push({ name: `brand-domain:${d}`, re: new RegExp(`(?<![A-Za-z0-9-])${escapeRe(d)}(?![A-Za-z0-9-])`, "i") });
  }
  for (const n of [...LEGACY_BRAND_NAMES, ...extraStrings]) {
    rules.push({ name: `brand-name:${n}`, re: new RegExp(escapeRe(n).replace(/ /g, "[\\s_-]?"), "i") });
  }
  for (const w of FORBIDDEN_WORDS) rules.push({ name: `word:${w}`, re: new RegExp(escapeRe(w), "i") });
  rules.push(...SECRET_PATTERNS);
  return rules;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** Scan a string; returns [{rule, match}] for every rule that matches. */
export function scanText(text, rules = buildRules()) {
  const out = [];
  for (const rule of rules) {
    const m = rule.re.exec(text);
    if (m) out.push({ rule: rule.name, match: m[0] });
  }
  return out;
}

/** Scan every file under dir (text and binary alike, read as latin1 so bytes map 1:1). */
export function scanDir(dir, rules = buildRules()) {
  const findings = [];
  let files = 0;
  for (const file of walk(dir)) {
    files++;
    // File NAMES are served too (asset URLs), so scan the relative path as well as the content.
    const rel = relative(dir, file).replace(/\\/g, "/");
    const text = readFileSync(file).toString("latin1");
    for (const f of [...scanText(rel, rules), ...scanText(text, rules)]) findings.push({ file: rel, ...f });
    if (TEXT_EXT.test(rel)) {
      for (const d of unknownDomains(text)) findings.push({ file: rel, rule: "unknown-domain", match: d });
    }
  }
  return { files, findings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] ?? "dist";
  const { files, findings } = scanDir(dir);
  if (files === 0) {
    console.error(`check-bundle: no files under ${dir} - build first`);
    process.exit(2);
  }
  if (findings.length) {
    for (const f of findings) console.error(`check-bundle: ${f.file}: ${f.rule} (${JSON.stringify(f.match.slice(0, 80))})`);
    console.error(`check-bundle: FAIL - ${findings.length} finding(s) in ${files} file(s)`);
    process.exit(1);
  }
  console.log(`check-bundle: OK - ${files} file(s) clean`);
}
