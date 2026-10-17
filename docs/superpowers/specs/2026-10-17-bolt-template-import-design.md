# Bolt template import and brand site text: design

Date: 2026-10-17. Status: approved in chat (sections 1 to 3); sections 1, 2 and "Risk and first step" revised the same day after live bolt.new evidence (published URL is the primary path).
Tenants: aduplift (live) and maimax (tenant setup still incomplete, see "Maimax").

## Goal

Staff who are not developers build landing templates in bolt.new. They must be able to:

1. Send a finished template into the control panel without handling files, keys or terminals.
2. Have the owner approve it with one button.
3. Get a brand site whose brand name, page title and meta description match what the dashboard shows.

Text rule chosen by the owner: the template supplies the defaults, the dashboard can edit them per brand, and the brand Worker writes the dashboard values into every page it serves.

## Current state (origin/main b0cb7d9)

- Templates reach the factory only through template MCP tools: `import_template_version`, `certify_template_version`, `seal_template_version` (`workers/template-mcp/src/tools.ts:228,263,288`). Sealing needs `OWNER_SECRET` (`certifier.ts:252`).
- The dashboard lists sealed versions only (`apps/web/src/server/lifecycle.ts:403`). There is no upload, import or review screen.
- `import_template_version` takes a base64 zip. A chat AI in bolt.new cannot pass one: on 2026-10-17 a 101 KB zip (135,284 base64 characters) was "too large to paste directly into the tool call".
- `<title>`, meta description and the brand name are hard-coded in template HTML. The brand Worker rewrites only `[data-kw]`, `#cfg` and `form[data-cta]` (`packages/brand-runtime/src/worker.ts:98-110`). Every brand on one template version therefore shows the same title.
- Builder keys are minted with `workers/template-mcp/scripts/mint-key.mjs` and a manual D1 `INSERT`. On 2026-10-17 this took 3 attempts, because the first `INSERT` failed and the wrong key was pasted into bolt.new.
- The template MCP serves aduplift only (`mcp.aduplift.ai`, `aduplift-factory`). It is not deployed by CI.

## Design

### 1. Submit by published URL (path A, primary for bolt.new)

Live evidence (2026-10-17, bolt.new project Willow Lake Lending): the bolt.new AI built the site and zipped `dist/` (101 KB, 135,284 base64 characters), but could not pass it as a tool argument ("too large to paste directly into the tool call"), then hit its own context limit. A file list as text would be larger, not smaller. So the AI does not send files; it publishes the site and sends the URL.

- The AI builds static HTML, publishes the site in bolt.new (bolt.host), runs `probe_url` on the published URL, then calls MCP tool `submit_template_url` with `url`, `template_id` (slug) and `template_name`. The payload is a few hundred bytes.
- The server reuses the existing live-site crawler (https and public hosts only, 3 redirects, 150 requests), assembles a deterministic zip, then in the same call runs the static checks, `similarity_check`, import (R2 + `template_versions` as `draft`), certify, and text-default extraction (section 3).
- Limits: the existing zip limits apply to the assembled archive (30 MB, 2000 files, 10 MB per file). A larger build fails with "reduce image sizes".
- A page whose HTML has no visible body content (client-rendered SPA) is rejected with: "This site renders with JavaScript. Ask bolt.new to make it static HTML, then submit again."
- A URL that does not answer 200 (a bolt.host URL answered "Website not found" for `/` on 2026-10-17) is rejected with rule `published-url` and the fix: publish again, confirm the URL in a browser, run `probe_url`, submit again.
- The tool result is written for the bolt.new AI: `status` (`awaiting_approval`, `rejected`, `duplicate`), the dashboard link, and for every failed check the existing `rule`, `file`, `message` and `fix`. On `rejected` the AI fixes the site, publishes again and calls again.
- A submit whose archive SHA-256 matches an existing version returns that version (`duplicate`) and creates nothing.
- `get_template_contract` gains a "How to submit" section: build static HTML (no client-only SPA), publish, `probe_url`, `submit_template_url`. It tells the AI never to paste a zip or a build into a tool call.
- Dashboard button "Import from URL" on the Templates screen runs the same pipeline.
- Diagnostic tools kept from the spike: `probe_url` (redirect hops, status, final URL, visible text, empty JavaScript shell) and `measure_payload` (how many characters of one tool argument arrived).

`submitted_by` is the builder key's `key_id` and label (for "Import from URL": no key, the user's email), so the dashboard shows which staff member sent each template.

### 2. Submit files (path B, second priority, for builders that cannot publish)

- `submit_template { template_id, template_name, files: [{ path, content, encoding: "utf8" | "base64" }] }` for builders that can pass a whole small build in one argument.
- Chunked upload for everyone else: `begin_upload { template_id, template_name }` returns `upload_id`; `upload_files { upload_id, files: [{ path, content, encoding, part }] }` carries at most about 20 KB of content per call (a larger file is cut into parts 0, 1, 2 ...); `finish_upload { upload_id }` joins the files and runs the same pipeline as path A, with the same result.
- An upload belongs to the builder key that started it, is staged in the factory D1, and expires after 6 hours. The batch size comes from the spike measurement.

### 3. Site text: extract, edit, serve

Extraction at submit time, stored on the template version as `text_defaults` (JSON):

| Field | Source, first match wins | Limit |
|---|---|---|
| `brand_name` | text of the first `[data-brand]` element; else `og:site_name`; else the part of `<title>` before ` \| ` | 80 |
| `title` | `<title>` of `/index.html` | 70 |
| `description` | `meta[name=description]` of `/index.html` | 160 |

Contract changes (`docs/template-contract.md`, checker and `get_template_contract`):

- Required: `<title>` and `meta[name=description]` on `/index.html`.
- Required for new templates: `data-brand` on every element whose text is the brand name (header, footer, legal pages). A template with no `data-brand` passes with a warning, so existing templates keep working.

Storage:

- `brand_runtime` (leads D1) gains `brand_name`, `site_title` and `site_description` (nullable). Null means "use the template default".
- `BrandSettingsResponse` (`packages/contracts/src/leads-rpc.ts:174`) gains the same three fields. The brand Worker already refreshes settings every 60 s, so an edit is live within 60 s without a redeploy.
- When a brand revision is created or upgraded, the template version's `text_defaults` are copied into the revision's `config_json`. They are the baked fallback when core is unreachable, and a rollback restores them.

Serving (`packages/brand-runtime/src/worker.ts`, HTMLRewriter):

- `/` (index): set `<title>`, `meta[name=description]`, `meta[property=og:title]` and `meta[property=og:description]` to the effective values.
- Other pages: in `<title>`, replace the template's `brand_name` with the effective brand name. Descriptions on other pages are unchanged.
- Every page: set the text of each `[data-brand]` element to the effective brand name.
- `cfg.brand` (form header and consent text) uses the same effective brand name. Core's consent check (`x-consent-brand`, `workers/core/src/rpc/submit.ts:34`) compares against that value, so the form and the page cannot disagree.
- Output is identical for every visitor (no cloaking rule).

Validation on save (dashboard API and core admin API): the length limits above, `isBrandClean` (no platform strings), and the compliance ban on "personal loan" wording.

### 4. Dashboard

Templates screen (new, owner and employee):

- List of versions with status: checking, rejected, awaiting approval, approved (sealed).
- Detail view: desktop and mobile screenshots (already produced by certify), check results, extracted text defaults, submitter label, similarity result.
- "Approve" (owner only): seals the version through a factory service call with the logged-in owner's user id as `sealed_by`. `OWNER_SECRET` is no longer needed for this path. Approving a sealed version again returns success and changes nothing. An employee gets 403.
- "Import from URL" (owner and employee).

Brand settings, "Site text" card (mockup approved 2026-10-17): three fields prefilled from the template, a "From template" or "Edited" badge per field, a character counter, "Reset to template", and Save. A live preview shows the browser tab, a search result and the header/footer brand name.

Settings, "Builder keys" (owner only): create a key with a label, show it once with a Copy button, list keys with last-used time, revoke. This replaces `mint-key.mjs` for staff keys.

### 5. Maimax

- Add `workers/template-mcp/wrangler.maimax.jsonc` (`mcp.maimax.com`, `maimax-factory`, the maimax R2 bucket). Keys are per tenant, because each tenant has its own factory D1.
- Add template-mcp deploy steps to `.github/workflows/deploy.yml` for aduplift and for maimax (behind `MAIMAX_ENABLED`).
- Maimax works only after its tenant setup is finished (factory deploy, Access, R2 bucket, `MAIMAX_CORE_TOKEN`, `MAIMAX_CF_ACCESS_CLIENT_ID`, `MAIMAX_CF_ACCESS_CLIENT_SECRET`). That setup is a separate piece of work and is not in this spec.

## Errors

| Case | Result |
|---|---|
| Revoked or unknown key | 401, and the auth failure log added in PR 113 |
| Check failures | `rejected` with `rule`, `file`, `message`, `fix` per issue |
| Similar to another brand's sealed template | `rejected`, naming the brand and the signals to change |
| Archive over limits | `rejected`: "reduce image sizes" |
| Same archive submitted twice | `duplicate`, returns the existing version |
| SPA with empty HTML (URL path) | `rejected` with the static HTML instruction |
| Published URL answers 404 or does not resolve | `rejected` with rule `published-url`: publish again, then submit again |
| Unknown or expired `upload_id`, missing part | tool error naming the upload or the missing part |
| Approve by employee | 403 `forbidden_role` |
| Approve twice | 200, no change |
| Core unreachable at serve time | brand Worker serves the baked revision values |

## Testing

- Unit: text extraction (each fallback order), contract checks for title, description and `data-brand`, deterministic zip assembly, chunked upload join (parts, other key, expiry), `probe_url` redirects and empty shells, duplicate detection, HTMLRewriter output for index and other pages, `cfg.brand` equality, settings validation.
- API: Templates list and approve with owner and employee roles, builder key create and revoke, site text save.
- Worker integration (Miniflare): `submit_template_url` end to end into D1 and R2 (crawl, SPA rejection, 404 rejection); `begin_upload` / `upload_files` / `finish_upload` end to end; brand Worker serving edited text within the settings TTL.
- Live acceptance on aduplift: one bolt.new project published and submitted by URL from chat, approved in the dashboard, used for a test brand, and the edited title verified on the live site.

## Risk and first step

bolt.new cannot pass a large tool argument: a 135,284-character argument failed on 2026-10-17. Published bolt.host URLs may not be stable: one answered "Website not found" for `/` the same night. The first implementation step is a spike with two tools that stay in the server:

- `measure_payload`: the bolt.new AI sends 10 KB, 20 KB and 50 KB of text; the largest size that arrives sets the `upload_files` batch size (at most 20 KB).
- `probe_url`: probe the published URL right after publishing, after 10 minutes and after 1 hour, plus the bare `bolt.host` root; record redirects, status and visible text. The URL form that stays reachable is the one the contract tells the AI to send.

## Out of scope

- Maimax tenant setup (section 5).
- OAuth for Magic Patterns (separate design).
- Per-page titles beyond the brand name replacement.
