# Template MCP (`anjuna-template-mcp`)

Remote MCP server (Cloudflare Agents SDK `McpAgent`, streamable HTTP at `https://mcp.aduplift.ai/mcp`).
Every brand gets a **unique** design from an AI builder (open-design.ai, v0, Bolt, Lovable, Magic Patterns).
The builder's AI connects here to learn the contract and to check its template before handing it over.
Identical sites across brands risk Google Ads bans, so uniqueness is checked too.

## Tools

| Tool | Input | Result |
|---|---|---|
| `get_template_contract` | none | `docs/template-contract.md` as structured rules, examples and the build/check/fix workflow |
| `check_template` | `zip_base64` **or** `url` (zip, or a live static site), optional `brand_id` | `pass`/`fail` + issues, each with `rule`, `file`, `message`, `fix` |
| `check_github_repo` | `owner`, `repo`, optional `ref`, `path`, `brand_id` | same report, for the built output found in the repo |
| `similarity_check` | `zip_base64` **or** `url`, optional `brand_id` | `pass`/`fail`, closest sealed templates (brand, score per signal) and what to change |

Checks (all static; template JavaScript is never executed): static output only, reserved paths (`/go`, `/api`, `/_f`),
required pages, legal footer links on every page, one `data-kw` span with plain text inside the `<h1>`,
one `form[data-cta]` (GET `/go`, only `requested_amount` in the canonical buckets and a 5-digit `zip`, submit button),
no PII inputs, no "personal loan" wording, no guarantee claims, no external scripts/analytics/resources, no cloaking
logic, brand-clean (no platform strings, keys, DSNs or other brands' names/domains from the `brands` table),
no `#cfg` element, every internal link/asset resolves. The constants are tested against `docs/template-contract.md`.

## Auth and limits

- `Authorization: Bearer <key>`. Keys are per builder, stored only as SHA-256 hashes in the factory D1 (`builder_keys`),
  revocable with `revoked_at`. Mint one with `node scripts/mint-key.mjs "<label>"` (prints the key once plus the `INSERT`).
  Revoke: `UPDATE builder_keys SET revoked_at = datetime('now') WHERE key_id = '...'`.
- Rate limit per key: `RATE_LIMIT_PER_MINUTE` requests (default 60), fixed window in `builder_key_usage`; `429` + `Retry-After`.
- Zip: max 30 MB, 2000 files, 10 MB per file, 100 MB expanded. Rejected: zip-slip (`..`, absolute, backslash paths),
  symlinks and special files, encrypted entries, duplicate entries, ZIP64.
- URLs: `https` + public hostnames only, 3 redirects, size-capped, 150 requests when crawling a live site.
- `check_github_repo` reads the repo tarball (symlinks skipped). Optional secret `GITHUB_TOKEN` (read-only) for private repos.

## Similarity

`template_fingerprints` (migration 0003) holds one fingerprint per **sealed** template version: bottom-k sketches of
DOM-structure shingles, CSS class set and visible-text shingles, the section order, and image content hashes.
Sealing (T11) must call `computeFingerprint` (`src/fingerprint.ts`) on the sealed dist and insert the row.
A candidate fails against any sealed template of another brand when the weighted score is >= `SIMILARITY_THRESHOLD`
(default 0.5), its text similarity is >= 0.5, or it shares 3 or more identical images. The report names the brand
and the signals to change. Pass `brand_id` to exclude that brand's own earlier templates.

## Deploy (owner-gated, not done here)

`wrangler.jsonc` pins the account, `workers_dev: false` and Custom Domain `mcp.aduplift.ai`. The D1 id is a placeholder.
Apply factory migrations 0002 and 0003 before the first request.
