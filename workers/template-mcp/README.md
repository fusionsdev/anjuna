# Template MCP (`anjuna-template-mcp`)

Remote MCP server (Cloudflare Agents SDK `McpAgent`). Streamable HTTP at `https://mcp.aduplift.ai/mcp`, legacy SSE at `https://mcp.aduplift.ai/sse`.
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
| `probe_url` | `url` | every redirect hop and status, `final_url`, `visible_text_chars`, `client_rendered`, `ok` |
| `measure_payload` | `text` | `received_chars`, `received_bytes` (sizes `upload_files` batches) |
| `submit_template_url` | `url` (published static site), `template_id`, `template_name` | `status` `awaiting_approval` / `rejected` / `duplicate`, `issues` (`rule`, `file`, `message`, `fix`), `dashboard_url`, `text_defaults`. Primary path for bolt.new; stores the builder key's id and label |
| `submit_template` | `template_id`, `template_name`, `files` (every file in `dist/`) | same result as `submit_template_url`; only for builders that can pass the whole build in one argument |
| `begin_upload` / `upload_files` / `finish_upload` | `template_id`, `template_name`; then `upload_id` + up to `UPLOAD_BATCH_CHARS` characters of `files` per call (`part` splits large files); then `upload_id` | `upload_id`; stored counts; then the `submit_template_url` result. Uploads belong to one key and expire after 6 hours |

Checks (all static; template JavaScript is never executed): static output only, reserved paths (`/go`, `/api`, `/_f`),
required pages, legal footer links on every page, one `data-kw` span with plain text inside the `<h1>`,
one `form[data-cta]` (GET `/go`, only `requested_amount` in the canonical buckets and a 5-digit `zip`, submit button),
no PII inputs, no "personal loan" wording, no guarantee claims, no external scripts/analytics/resources, no cloaking
logic, brand-clean (no platform strings, keys, DSNs or other brands' names/domains from the `brands` table),
no `#cfg` element, every internal link/asset resolves. The constants are tested against `docs/template-contract.md`.

## Auth and limits

- The builder key is read from the first of these headers that holds a valid key (16-256 characters, no spaces):
  `Authorization: Bearer <key>`, `Authorization: <key>`, `X-API-Key: <key>`, `Api-Key: <key>`.
  A key in the URL query string is never accepted. A 401 carries `WWW-Authenticate: Bearer realm="anjuna-template-mcp"`.
  Keys are per builder, stored only as SHA-256 hashes in the factory D1 (`builder_keys`),
  revocable with `revoked_at`. Staff keys are created, listed (with last use) and revoked by an owner in the control panel under Builder keys. `node scripts/mint-key.mjs "<label>"` remains for keys minted outside the panel.
  Revoke: `UPDATE builder_keys SET revoked_at = datetime('now') WHERE key_id = '...'`.
- Rate limit per key: `RATE_LIMIT_PER_MINUTE` requests (default 60), fixed window in `builder_key_usage`; `429` + `Retry-After`.
- Zip: max 30 MB, 2000 files, 10 MB per file, 100 MB expanded. Rejected: zip-slip (`..`, absolute, backslash paths),
  symlinks and special files, encrypted entries, duplicate entries, ZIP64.
- URLs: `https` + public hostnames only, 3 redirects, size-capped, 150 requests when crawling a live site.
- `check_github_repo` reads the repo tarball (symlinks skipped). Optional secret `GITHUB_TOKEN` (read-only) for private repos.

## Transports and bolt.new

- `/mcp`: streamable HTTP.
- `/sse`: legacy SSE. `GET /sse` opens the event stream, the stream announces `/sse/message?sessionId=...` for client requests.
  Both paths use the same key check, rate limit and CORS allow-list (`Authorization`, `X-API-Key`, `Api-Key`).

bolt.new custom MCP connector:

1. URL: `https://mcp.aduplift.ai/mcp`.
2. Transport type: HTTP. For SSE, use `https://mcp.aduplift.ai/sse`.
3. Auth: API key, value = the builder key.

## Similarity

`template_fingerprints` (migration 0003) holds one fingerprint per **sealed** template version: bottom-k sketches of
DOM-structure shingles, CSS class set and visible-text shingles, the section order, and image content hashes.
Sealing (T11) must call `computeFingerprint` (`src/fingerprint.ts`) on the sealed dist and insert the row.
A candidate fails against any sealed template of another brand when the weighted score is >= `SIMILARITY_THRESHOLD`
(default 0.5), its text similarity is >= 0.5, or it shares 3 or more identical images. The report names the brand
and the signals to change. Pass `brand_id` to exclude that brand's own earlier templates.

## Deploy (owner-gated, not done here)

`wrangler.jsonc` pins the account, `workers_dev: false` and Custom Domain `mcp.aduplift.ai`. The D1 binding points at the AdUplift factory D1 (`aduplift-factory`).
Apply factory migrations 0002 and 0003 before the first request.
