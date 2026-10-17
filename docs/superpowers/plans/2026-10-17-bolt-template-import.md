# Bolt Template Import and Brand Site Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff send a finished bolt.new template into the control panel with one MCP call, the owner approves it with one button, and every brand page serves the brand name, page title and meta description the dashboard shows.

**Architecture:** A bolt.new chat cannot pass a built site as a tool argument (2026-10-17: a 101 KB zip, 135,284 base64 characters, failed), so the primary path is `submit_template_url`: the AI publishes the site and sends only its URL; the template MCP Worker (`workers/template-mcp`) crawls it and runs one pipeline (deterministic zip, contract checks, similarity, import to R2 and the factory D1, certification, text-default extraction). The second path, for builders that cannot publish, is `submit_template` (one call) and `begin_upload` / `upload_files` / `finish_upload` (batches of at most 20,000 characters), into the same pipeline. The control panel (`apps/web`) lists versions, approves through a new factory `/seal-template` route with the owner's user id, mints builder keys, and edits per-brand site text through the core admin API. Core stores the site text in `brand_runtime` and returns it in live brand settings; the brand Worker (`packages/brand-runtime`) writes it into every page with HTMLRewriter, and the template defaults baked into each revision are the fallback.

**Tech Stack:** Bun workspaces, Turborepo, TypeScript strict, Vitest 4 with `@cloudflare/vitest-pool-workers`, Cloudflare Workers, D1, R2, Durable Objects (`agents` `McpAgent`), `@modelcontextprotocol/sdk`, zod 4, fflate, htmlparser2, node-html-parser, React 19 (jsdom tests with `@testing-library/react`).

**Spec:** `docs/superpowers/specs/2026-10-17-bolt-template-import-design.md`

## Global Constraints

- Read `AGENTS.md` first. No deploys, no real external calls, no secrets in git. Deploy and live steps are owner steps and are marked "Owner step".
- Brand bytes stay clean: nothing a brand serves contains another brand's identifiers, "anjuna", "aurum", a PostHog key or a Sentry DSN.
- No cloaking: "Output is identical for every visitor (no cloaking rule)."
- Cloudflare only: D1 for all data; R2 only for template archives and certification evidence.
- Archive limits (spec): "the existing zip limits apply to the assembled archive (30 MB, 2000 files, 10 MB per file). A larger submit fails with "reduce image sizes"."
- Text limits (spec): `brand_name` 80, `title` 70, `description` 160.
- Save validation (spec): "the length limits above, `isBrandClean` (no platform strings), and the compliance ban on "personal loan" wording."
- SPA rejection text, verbatim: "This site renders with JavaScript. Ask bolt.new to make it static HTML, then submit again."
- Approve: owner only ("An employee gets 403"), body `forbidden_role`; "Approving a sealed version again returns success and changes nothing."
- Settings refresh: the brand Worker refreshes live settings every 60 s (`SETTINGS_TTL_MS`), so an edit is live within 60 s.
- Revoked or unknown builder key: 401 (existing `authenticate`).
- Migration numbers: factory D1 `0005_template_submissions.sql` and `0006_template_uploads.sql`; leads D1 `0011_brand_site_text.sql`.
- Priority (coordinator, 2026-10-17): the published-URL path (`submit_template_url`, Task 5) is primary for bolt.new; file submit and chunked upload (Task 6) are second priority. Never ask a builder AI to paste a zip or base64 build into a tool call.
- bolt.new evidence (2026-10-17, project Willow Lake Lending): a 135,284-character tool argument failed ("too large to paste directly into the tool call"); a bolt.host URL answered "Website not found" for `/`.
- UI: new screens use the existing classes in `apps/web/src/client/styles.css` (`card`, `section`, `table`, `pill`, `row`, `form-inline`, `modal-wrap`). Do not restyle existing screens. Labels follow the existing "Thai (English)" pattern.
- Every task ends with `bun run typecheck` (repo root) and the touched package's `bun run test` green, then a commit whose message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commits go on the branch the owner names for execution. One PR per task group is the owner's call; record each task's acceptance evidence in its PR description.

## Review Focus

1. A live brand still on the old brand runtime after core ships site text: the old runtime parses `BrandSettingsResponse` strictly, so new keys would make it drop live settings (and ignore Pause). Expected: core adds the three site text keys only when the request sets `include_site_text: true`. Test: Task 12, "returns site text only to runtimes that ask for it".
2. A second version of the same template (same `template_id`) after v1 was sealed: expected to pass similarity against its own earlier versions. Test: Task 5, "does not compare a new version with the same template's own sealed versions".
3. Site text with `&` or an entity in a legal page title: expected valid HTML with no double escaping; `<`, `>` and `"` are refused on save. Tests: Task 3 schema test and Task 14 "writes edited title ..." and "replaces only the brand name in other pages' titles".
4. A revision whose `text_defaults` is invalid or missing (every revision created before this work): expected the brand Worker keeps serving and uses the factory brand name. Test: Task 14, "keeps serving with the factory brand name when baked text defaults are invalid or missing".
5. A published bolt.host URL that answers 404 "Website not found" (seen on 2026-10-17): expected a `rejected` result with a `published-url` issue telling the AI to publish again, not a bare tool error. Test: Task 5, "rejects a published URL that answers 'Website not found' with the publish-again fix".

---

## File Structure

| Path | Change | Responsibility |
|---|---|---|
| `workers/template-mcp/src/probe.ts` | create | spike diagnostics kept as tools: `measure_payload` (argument size) and `probe_url` (redirects, status, empty JavaScript shell) |
| `workers/template-mcp/src/submit.ts` | create | deterministic zip, framework detection, the submit pipeline, the URL submit and SPA detection (Task 5), file list and chunked upload (Task 6) |
| `workers/template-mcp/src/text-defaults.ts` | create | extract `brand_name`, `title`, `description` from `index.html` |
| `workers/template-mcp/src/import-service.ts` | create | `POST /submit-url` handler behind the `TemplateImportService` entrypoint (dashboard "Import from URL") |
| `workers/template-mcp/src/tools.ts` | modify | register `measure_payload`, `probe_url`, `submit_template_url`, `submit_template`, `begin_upload`, `upload_files`, `finish_upload`; `similarityCheck` excludes the same `template_id`; tools receive the builder identity |
| `workers/template-mcp/src/certifier.ts` | modify | import stores submitter and text defaults; certify excludes the same template from similarity |
| `workers/template-mcp/src/index.ts` | modify | pass the builder identity as McpAgent props; export `TemplateImportService` |
| `workers/template-mcp/src/contract.ts` | modify | `page-text` and `brand-slot` rules, `how_to_submit` |
| `workers/template-mcp/src/env.ts`, `wrangler.jsonc`, `wrangler.maimax.jsonc` (create), `vitest.config.ts`, `package.json` | modify | `DASHBOARD_URL` var, maimax config, `@anjuna/contracts` dependency |
| `packages/template-cert/src/checks/meta.ts` | create | title, description and `data-brand` checks (reported under rule `structure`) |
| `packages/contracts/src/site-text.ts` | create | site text value schemas, limits, `TemplateTextDefaults`, `normalizeSiteText`, `withTextDefaults`, `SiteTextDefaultsResponse` |
| `packages/contracts/src/template-review.ts` | create | review statuses, `templateSlug`, submit result, template list and detail, approve response |
| `packages/contracts/src/builder-keys.ts` | create | builder key list, create and response schemas |
| `packages/contracts/src/leads-rpc.ts`, `admin-api.ts` | modify | site text in `BrandSettingsRequest/Response`, `BrandConfig`, `BrandPatchRequest`, field group `site_text` |
| `packages/factory-db/migrations/0005_template_submissions.sql` | create | `text_defaults_json`, `submitted_by_key_id`, `submitted_by_label` on `template_versions` |
| `packages/factory-db/migrations/0006_template_uploads.sql` | create | chunked uploads: `template_uploads`, `template_upload_chunks` |
| `packages/leads-db/migrations/0011_brand_site_text.sql` | create | `brand_name`, `site_title`, `site_description` on `brand_runtime` |
| `workers/factory/src/seal.ts` | create | owner seal with idempotent second call; `/seal-template` route |
| `workers/factory/src/workflows/upgrade-all.ts` | modify | copy target text defaults into upgrade revisions |
| `workers/core/src/rpc/runtime.ts`, `rpc/index.ts`, `admin/index.ts` | modify | read, return and patch site text |
| `packages/brand-runtime/src/site-text.ts` | create | effective site text and the HTMLRewriter handlers |
| `packages/brand-runtime/src/config.ts`, `settings-cache.ts`, `worker.ts` | modify | settings fields, request flag, rewriting, `cfg.brand` and consent brand |
| `apps/web/src/server/templates.ts` | create | templates list, detail, screenshots, approve, import; site text defaults |
| `apps/web/src/server/builder-keys.ts` | create | builder key list, create, revoke |
| `apps/web/src/server/index.ts`, `env.ts`, `panel-roles.ts`, `audit.ts`, `lifecycle.ts`, `mock-core.ts` | modify | routes, bindings, roles, audit prefix, draft text defaults, mock fields |
| `apps/web/src/client/screens/Templates.tsx`, `BuilderKeys.tsx` | create | Templates screen, Builder keys screen |
| `apps/web/src/client/screens/ConfigPanel.tsx`, `App.tsx`, `api.ts`, `styles.css` | modify | Site text card, navigation, API client, new classes |
| `apps/web/wrangler.jsonc`, `wrangler.deploy.aduplift.jsonc`, `wrangler.deploy.maimax.jsonc`, `vitest.config.ts` | modify | `ARTIFACTS` R2 binding and `TEMPLATE_MCP` service binding |
| `.github/workflows/deploy.yml` | modify | template MCP deploy and smoke steps for aduplift and maimax |
| `docs/template-contract.md`, `workers/template-mcp/README.md` | modify | page text rules, how to submit, new tools |

---

## Task 1: Spike: measure the bolt.new tool-argument cap and published-URL behavior

Evidence that sets this spike (2026-10-17, bolt.new project Willow Lake Lending): the bolt.new AI zipped `dist/` (101 KB, 135,284 base64 characters) and could not pass it as a tool argument ("too large to paste directly into the tool call"), then hit its own context limit. The same night a bolt.host URL answered "Website not found" for `/`. This spike measures both limits with two diagnostic tools that stay in the server: `measure_payload` sizes the `upload_files` batches (Task 6) and `probe_url` is the pre-flight the contract tells the AI to run before `submit_template_url` (Task 5).

**Files:**
- Create: `workers/template-mcp/src/probe.ts`
- Modify: `workers/template-mcp/src/tools.ts` (imports; two tools at the end of `registerTools`)
- Test: `workers/template-mcp/test/probe.test.ts` (create), `workers/template-mcp/test/mcp.test.ts` (tool list test and one new test)

**Interfaces:**
- Consumes: `assertPublicHttpsUrl` (`input.ts`), `parseHtml`, `allElements`, `visibleText` (`html.ts`).
- Produces:
  - `measurePayload(text: string): { received_chars: number; received_bytes: number }`
  - `visibleBodyText(html: string): string` (body text without script, style and noscript; Task 5 uses it to detect a client-rendered shell)
  - `interface UrlHop { url: string; status: number; location: string | null }`
  - `interface UrlProbe { hops: UrlHop[]; final_url: string; status: number; content_type: string; html_bytes: number; visible_text_chars: number; client_rendered: boolean; ok: boolean }`
  - `probePublishedUrl(raw: string): Promise<UrlProbe>` (at most 3 redirects, the crawler's limit)
  - MCP tools `measure_payload { text }` and `probe_url { url }`.

- [ ] **Step 1: Write the failing unit test**

Create `workers/template-mcp/test/probe.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { measurePayload, probePublishedUrl, visibleBodyText } from "../src/probe";

afterEach(() => vi.unstubAllGlobals());

/** Hosts keyed by "host/path"; anything else answers like bolt.host did: 404 "Website not found". */
function host(routes: Record<string, () => Response>) {
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(String(input));
    const route = routes[url.host + url.pathname];
    return route ? route() : new Response("Website not found", { status: 404, headers: { "content-type": "text/html" } });
  });
}

describe("spike probes", () => {
  it("measures a tool argument in characters and UTF-8 bytes", () => {
    expect(measurePayload("x".repeat(20_000))).toEqual({ received_chars: 20_000, received_bytes: 20_000 });
    expect(measurePayload("ก")).toEqual({ received_chars: 1, received_bytes: 3 });
  });

  it("follows redirects to a static page and reports its visible text", async () => {
    host({
      "willow.bolt.host/": () => new Response(null, { status: 301, headers: { location: "https://willow-lake.bolt.host/" } }),
      "willow-lake.bolt.host/": () => new Response("<html><body><h1>Willow Lake Lending</h1></body></html>", { headers: { "content-type": "text/html" } }),
    });
    const probe = await probePublishedUrl("https://willow.bolt.host/");
    expect(probe.hops.map((hop) => hop.status)).toEqual([301, 200]);
    expect(probe).toMatchObject({ final_url: "https://willow-lake.bolt.host/", status: 200, ok: true, client_rendered: false });
    expect(probe.visible_text_chars).toBe("Willow Lake Lending".length);
  });

  it("reports a missing site and a client-rendered shell", async () => {
    host({ "spa.bolt.host/": () => new Response('<html><body><div id="root"></div><script src="/a.js"></script></body></html>', { headers: { "content-type": "text/html" } }) });
    expect(await probePublishedUrl("https://gone.bolt.host/")).toMatchObject({ status: 404, ok: false });
    expect(await probePublishedUrl("https://spa.bolt.host/")).toMatchObject({ status: 200, ok: false, client_rendered: true });
    expect(visibleBodyText('<body><noscript>Enable JS</noscript><div id="root"></div></body>')).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd workers/template-mcp && bun run test -- test/probe.test.ts`
Expected: FAIL with "Failed to load url ../src/probe" (module does not exist).

- [ ] **Step 3: Write the minimal implementation**

Create `workers/template-mcp/src/probe.ts`:

```ts
/**
 * Diagnostics kept from the bolt.new spike: how large one tool argument can be, and how a published site
 * URL behaves (redirects, status, empty JavaScript shell). Page JavaScript is never run.
 */
import { allElements, parseHtml, visibleText } from "./html";
import { assertPublicHttpsUrl } from "./input";

export function measurePayload(text: string): { received_chars: number; received_bytes: number } {
  return { received_chars: text.length, received_bytes: new TextEncoder().encode(text).length };
}

/** Visible body text (script, style and noscript excluded). Empty means a client-rendered shell. */
export function visibleBodyText(html: string): string {
  const doc = parseHtml(html);
  const body = allElements(doc).find((el) => el.name === "body");
  return visibleText(body ?? doc);
}

export interface UrlHop {
  url: string;
  status: number;
  location: string | null;
}

export interface UrlProbe {
  hops: UrlHop[];
  final_url: string;
  status: number;
  content_type: string;
  html_bytes: number;
  visible_text_chars: number;
  client_rendered: boolean;
  ok: boolean;
}

/** The first request plus 3 redirects: the same limit the crawler applies. */
const MAX_HOPS = 4;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

export async function probePublishedUrl(raw: string): Promise<UrlProbe> {
  let url = assertPublicHttpsUrl(raw);
  const hops: UrlHop[] = [];
  for (;;) {
    const response = await fetch(url.toString(), { redirect: "manual", headers: { "user-agent": "anjuna-template-mcp/1" }, signal: AbortSignal.timeout(20_000) });
    const location = response.headers.get("location");
    hops.push({ url: url.toString(), status: response.status, location });
    if (response.status >= 300 && response.status < 400 && location && hops.length < MAX_HOPS) {
      await response.body?.cancel();
      url = assertPublicHttpsUrl(new URL(location, url).toString());
      continue;
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const body = new Uint8Array(await response.arrayBuffer()).subarray(0, MAX_HTML_BYTES);
    const html = contentType.includes("html") ? new TextDecoder().decode(body) : "";
    const visible = html ? visibleBodyText(html).length : 0;
    const isHtml = response.ok && contentType.includes("html");
    return {
      hops, final_url: url.toString(), status: response.status, content_type: contentType, html_bytes: body.length,
      visible_text_chars: visible, client_rendered: isHtml && visible === 0, ok: isHtml && visible > 0,
    };
  }
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `cd workers/template-mcp && bun run test -- test/probe.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing MCP test**

In `workers/template-mcp/test/mcp.test.ts`, inside `it("lists all tools including certification pipeline", ...)`, add after the `seal_template_version` line:

```ts
    expect(names).toContain("measure_payload");
    expect(names).toContain("probe_url");
```

Add inside `describe("tools over streamable HTTP", ...)`:

```ts
  it("measure_payload: reports how many characters arrived", async () => {
    const client = await connect();
    const { isError, data } = await callTool(client, "measure_payload", { text: "x".repeat(20_000) });
    expect(isError).toBe(false);
    expect(data).toEqual({ received_chars: 20_000, received_bytes: 20_000 });
    await client.close();
  });
```

Run: `cd workers/template-mcp && bun run test -- test/mcp.test.ts`
Expected: FAIL: `expected [...] to contain 'measure_payload'`, and the new test fails with "Tool measure_payload not found".

- [ ] **Step 6: Register the tools**

In `workers/template-mcp/src/tools.ts` add to the imports:

```ts
import { measurePayload, probePublishedUrl } from "./probe";
```

Add at the end of `registerTools`, after `seal_template_version`:

```ts
  // ── Diagnostics kept from the bolt.new spike ─────────────────────────────

  server.registerTool(
    "measure_payload",
    {
      title: "Measure one tool argument",
      description: "Diagnostic: send text of a chosen size (for example 10,000, 20,000 or 50,000 characters) and get back how many characters arrived. It sizes upload_files batches.",
      inputSchema: { text: z.string().describe("Any text; only its length is measured.") },
    },
    async (args) => {
      const measured = measurePayload(args.text);
      console.log(JSON.stringify({ event: "measure_payload", ...measured }));
      return text(measured);
    },
  );

  server.registerTool(
    "probe_url",
    {
      title: "Check a published site URL",
      description: "Diagnostic: requests the URL (at most 3 redirects) and reports every status, the final URL, and whether the page has visible text or is an empty JavaScript shell. ok must be true before submit_template_url.",
      inputSchema: { url: z.string().url().describe("https URL of the published site, as bolt.new shows it after publishing.") },
    },
    async (args) => {
      try {
        const probe = await probePublishedUrl(args.url);
        console.log(JSON.stringify({ event: "probe_url", final_url: probe.final_url, status: probe.status, hops: probe.hops.length, ok: probe.ok }));
        return text(probe);
      } catch (error) {
        return failure(error);
      }
    },
  );
```

- [ ] **Step 7: Run the package tests and typecheck**

Run: `cd workers/template-mcp && bun run test` then `bun run typecheck` at the repo root.
Expected: PASS for both.

- [ ] **Step 8: Commit**

```bash
git add workers/template-mcp/src/probe.ts workers/template-mcp/src/tools.ts workers/template-mcp/test/probe.test.ts workers/template-mcp/test/mcp.test.ts
git commit -F - <<'EOF'
feat(template-mcp): measure_payload and probe_url spike diagnostics (FUS-345)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 9: Owner step: measure bolt.new and bolt.host**

1. Owner deploys: `bun x wrangler deploy --config workers/template-mcp/wrangler.jsonc`, then runs `bun x wrangler tail anjuna-template-mcp --format pretty`.
2. In bolt.new (connector `https://mcp.aduplift.ai/mcp`), ask the AI to call `measure_payload` three times with text of exactly 10,000, 20,000 and 50,000 characters. Record which calls arrive (the `measure_payload` log line) and which the AI refuses or cuts.
3. Publish a test project in bolt.new. Call `probe_url` with the URL bolt.new shows: right after publishing, after 10 minutes, and after 1 hour. Also probe the bare `https://<name>.bolt.host/` root. Record every `hops` list, the final URL and `ok`.
4. Decisions, written in the PR description:
   - `upload_files` batch size: the largest size that arrived intact, at most 20,000 characters. If it is below 20,000, change `UPLOAD_BATCH_CHARS` in Task 6 to the measured value.
   - URL form: the exact published URL form that stays `ok: true`. If only a deep URL works (not `/`), state that form in the Task 5 `how_to_submit` step 2.

---

## Task 2: Contract checks for page title, description and `data-brand`

**Files:**
- Create: `packages/template-cert/src/checks/meta.ts`
- Modify: `packages/template-cert/src/index.ts` (the `structure` entry of `CHECKS`)
- Modify: `packages/template-cert/test/helpers.ts` (`validIndex`)
- Modify: `packages/template-astro-starter/src/layouts/Base.astro` (header link)
- Modify: `workers/template-mcp/test/fixtures.ts` (`page`, `goodSite`)
- Modify: `workers/template-mcp/src/contract.ts` (`RuleId`, `CONTRACT_RULES`)
- Modify: `docs/template-contract.md` (new section 3.4, checklist line)
- Test: `packages/template-cert/test/checks.test.ts`, `workers/template-mcp/test/contract.test.ts`

**Interfaces:**
- Consumes: `Check`, `err`, `warn`, `parseHtml` from `packages/template-cert/src`.
- Produces: `meta: Check`; constants `TITLE_MAX = 70`, `DESCRIPTION_MAX = 160` in `packages/template-cert/src/checks/meta.ts`. Issues use rule id `structure`, so the eight stable rule ids stay unchanged (`packages/template-cert/test/cli.test.ts` expects 8 checks). Contract rule ids `"page-text"` and `"brand-slot"` in `workers/template-mcp/src/contract.ts`.

- [ ] **Step 1: Write the failing tests**

In `packages/template-cert/test/helpers.ts`, replace `validIndex` with:

```ts
export function validIndex(): string {
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>Harbor | Funding Options</title><meta name="description" content="Check your funding options in minutes.">` +
    `<style>:root{color:#000}</style></head><body>` +
    `<header><a href="/" data-brand>Harbor</a></header>` +
    `<h1><span data-kw>Funding Options</span> | Check Your Options</h1>` +
    `<form method="get" action="/go" data-cta>` +
    `<select name="requested_amount"><option value="350">$350</option><option value="1000">$1,000</option><option value="5000">$5,000</option></select>` +
    `<input name="zip" inputmode="numeric" pattern="[0-9]{5}" maxlength="5" required>` +
    `<button type="submit">Continue</button>` +
    `</form></body></html>`;
}
```

Append to `packages/template-cert/test/checks.test.ts`:

```ts
describe("page text (title, description, data-brand)", () => {
  it("a landing page without <title> or meta description fails structure", () => {
    const files = indexWith(validIndex().replace(/<title>.*?<\/title>/, "").replace(/<meta name="description"[^>]*>/, ""));
    const errors = issuesFor(check(files), "structure").filter((i) => i.severity === "error");
    expect(errors.map((i) => i.en)).toEqual([expect.stringContaining("<title>"), expect.stringContaining('meta name="description"')]);
    expect(errors.every((i) => i.location === "index.html" && i.th.length > 0)).toBe(true);
  });

  it("an over-long title or description is a warning, not an error", () => {
    const files = indexWith(
      validIndex()
        .replace(/<title>.*?<\/title>/, `<title>${"T".repeat(71)}</title>`)
        .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${"d".repeat(161)}">`),
    );
    const result = check(files);
    expect(result.ok).toBe(true);
    expect(issuesFor(result, "structure").filter((i) => i.severity === "warning")).toHaveLength(2);
  });

  it("a template without data-brand passes with one warning", () => {
    const result = check(indexWith(validIndex().replace(" data-brand", "")));
    expect(result.ok).toBe(true);
    expect(issuesFor(result, "structure").map((i) => i.en)).toEqual([expect.stringContaining("data-brand")]);
  });

  it("a data-brand element with nested elements is a warning", () => {
    const result = check(indexWith(validIndex().replace("<a href=\"/\" data-brand>Harbor</a>", '<a href="/" data-brand><b>Harbor</b></a>')));
    expect(result.ok).toBe(true);
    expect(issuesFor(result, "structure").map((i) => i.en)).toEqual([expect.stringContaining("only the brand name")]);
  });
});
```

Append to `workers/template-mcp/test/contract.test.ts` inside the `describe`:

```ts
  it("page text rules are documented and served", () => {
    expect(doc).toContain("data-brand");
    expect(doc).toContain('<meta name="description"');
    expect(contractForBuilders().rules.map((r) => r.id)).toEqual(expect.arrayContaining(["page-text", "brand-slot"]));
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run --filter @anjuna/template-astro-starter build`, then `cd packages/template-cert && bun run test`.
Expected: FAIL in the four new "page text" tests (no title, description or data-brand issues are reported yet).

Run: `cd workers/template-mcp && bun run test -- test/contract.test.ts`
Expected: FAIL: `expected [...] to contain 'data-brand'`.

- [ ] **Step 3: Implement the check**

Create `packages/template-cert/src/checks/meta.ts`:

```ts
import type { HTMLElement } from "node-html-parser";
import { parseHtml } from "../html.js";
import { err, warn } from "../issue.js";
import type { Check } from "../checks.js";
import type { Issue } from "../types.js";

/** The dashboard keeps at most this many characters (packages/contracts SITE_TEXT_LIMITS). */
export const TITLE_MAX = 70;
export const DESCRIPTION_MAX = 160;

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes);

/** Page text the dashboard edits: <title> and meta description on index.html, data-brand on brand name elements. */
export const meta: Check = ({ source }) => {
  const issues: Issue[] = [];
  const index = source.files.get("index.html");
  if (index) {
    const root = parseHtml(decode(index));
    const title = squash(root.querySelector("title")?.textContent ?? "");
    if (!title) {
      issues.push(err("structure", "index.html",
        `The landing page has no <title>. Add <title>Your Brand | Short Promise</title> inside <head>; the dashboard uses it as the default page title (up to ${TITLE_MAX} characters).`,
        `หน้า landing ไม่มี <title> กรุณาเพิ่ม <title>ชื่อแบรนด์ | ข้อความสั้น</title> ใน <head> แดชบอร์ดใช้เป็นชื่อหน้าเริ่มต้น (ไม่เกิน ${TITLE_MAX} ตัวอักษร)`));
    } else if (title.length > TITLE_MAX) {
      issues.push(warn("structure", "index.html",
        `The <title> has ${title.length} characters; the dashboard keeps only the first ${TITLE_MAX}. Shorten it.`,
        `<title> ยาว ${title.length} ตัวอักษร แดชบอร์ดเก็บเพียง ${TITLE_MAX} ตัวแรก กรุณาย่อให้สั้นลง`));
    }
    const description = squash(root.querySelector('meta[name="description"]')?.getAttribute("content") ?? "");
    if (!description) {
      issues.push(err("structure", "index.html",
        `The landing page has no <meta name="description" content="...">. Add one sentence (up to ${DESCRIPTION_MAX} characters) that describes the offer.`,
        `หน้า landing ไม่มี <meta name="description" content="..."> กรุณาเพิ่มคำอธิบายหนึ่งประโยค (ไม่เกิน ${DESCRIPTION_MAX} ตัวอักษร)`));
    } else if (description.length > DESCRIPTION_MAX) {
      issues.push(warn("structure", "index.html",
        `The meta description has ${description.length} characters; the dashboard keeps only the first ${DESCRIPTION_MAX}. Shorten it.`,
        `meta description ยาว ${description.length} ตัวอักษร แดชบอร์ดเก็บเพียง ${DESCRIPTION_MAX} ตัวแรก กรุณาย่อให้สั้นลง`));
    }
  }

  const slots: { path: string; element: HTMLElement }[] = [];
  for (const [path, bytes] of source.files) {
    if (!/\.html?$/i.test(path)) continue;
    for (const element of parseHtml(decode(bytes)).querySelectorAll("[data-brand]")) slots.push({ path, element });
  }
  if (slots.length === 0 && [...source.files.keys()].some((path) => /\.html?$/i.test(path))) {
    issues.push(warn("structure", "",
      'No element has data-brand. Put data-brand on every element whose text is the brand name (header, footer, legal pages), e.g. <a href="/" data-brand>Harbor Funding</a>, so the dashboard can change the brand name on every page.',
      'ไม่พบ data-brand กรุณาใส่ data-brand ในทุกองค์ประกอบที่แสดงชื่อแบรนด์ (header, footer, หน้า legal) เช่น <a href="/" data-brand>Harbor Funding</a> เพื่อให้แดชบอร์ดเปลี่ยนชื่อแบรนด์ได้ทุกหน้า'));
  }
  for (const { path, element } of slots) {
    if (element.querySelectorAll("*").length > 0) {
      issues.push(warn("structure", path,
        "A data-brand element contains other elements. It must hold only the brand name text, because the dashboard replaces its whole content. Move icons and images outside it.",
        "องค์ประกอบ data-brand มีแท็กอื่นซ้อนอยู่ ต้องมีเฉพาะข้อความชื่อแบรนด์ เพราะแดชบอร์ดจะแทนที่เนื้อหาทั้งหมด กรุณาย้ายไอคอนและรูปภาพออกไปไว้ข้างนอก"));
    }
  }
  return issues;
};
```

In `packages/template-cert/src/index.ts` add the import and replace the `structure` entry:

```ts
import { meta } from "./checks/meta.js";
```

```ts
  { rule: "structure", name: "Structure & required pages", nameTh: "โครงสร้างและหน้าที่จำเป็น", run: (ctx) => [...structure(ctx), ...meta(ctx)] },
```

In `packages/template-astro-starter/src/layouts/Base.astro` replace `<header class="site"><a href="/">Example Brand</a></header>` with:

```astro
    <header class="site"><a href="/" data-brand>Example Brand</a></header>
```

In `workers/template-mcp/test/fixtures.ts` replace `page` and the header line of `goodSite`:

```ts
export function page(body: string, head = "", title = "Harbor | Funding"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="description" content="Check your funding options in minutes."><title>${title}</title>${head}<style>body{margin:0}</style></head><body>${body}${footer}</body></html>`;
}
```

```ts
    `<header class="${p}-top"><a href="/" data-brand>Harbor</a></header><main><h1>${o.h1 ?? '<span data-kw>Funding Options</span> | Check Your Options in Minutes'}</h1><p>${o.hero ?? "Answer two quick questions to see if a lending partner may be able to help."}</p>${o.ctaForm ?? ctaForm()}${sections.join("")}${o.extraBody ?? ""}</main>`,
```

In `workers/template-mcp/src/contract.ts` add `| "page-text" | "brand-slot"` to `RuleId` and append to `CONTRACT_RULES`:

```ts
  {
    id: "page-text",
    level: "must",
    rule: "/index.html has a <title> (up to 70 characters are used) and <meta name=\"description\" content=\"...\"> (up to 160 characters are used). They are the defaults the dashboard shows and edits per brand.",
    how: "<title>Harbor Funding | Check Your Options</title><meta name=\"description\" content=\"Compare funding options from lending partners in minutes.\">",
  },
  {
    id: "brand-slot",
    level: "should",
    rule: "Every element whose text is the brand name (header, footer, legal pages) carries data-brand and holds only that text. The brand Worker replaces its content with the brand's name. Without any data-brand the template passes with a warning.",
    how: "<a href=\"/\"><img src=\"/logo.svg\" alt=\"\"><span data-brand>Harbor Funding</span></a>. Legal page titles: <title>Privacy Policy | Harbor Funding</title>.",
  },
```

In `docs/template-contract.md`, insert after the end of section 3.3 (before `## 4. Banned content`):

```markdown
### 3.4 Page title, description and brand name

The dashboard edits three texts per brand: brand name, page title and meta description. The template supplies the defaults.

- `/index.html` **must** have a `<title>` (the first 70 characters are used) and `<meta name="description" content="...">` (the first 160 characters are used). The brand Worker writes the brand's values into them, and into `og:title` and `og:description` when those tags exist.
- Put `data-brand` on every element whose text is the brand name: header logo text, footer, legal pages. The element must hold only the brand name text, no icons or images, because the Worker replaces its whole content: `<a href="/"><img src="/logo.svg" alt=""><span data-brand>Harbor Funding</span></a>`.
- A template without any `data-brand` still passes, with a warning. New templates should always have it.
- On pages other than `/`, the Worker replaces the template's brand name inside `<title>` with the brand's name. Write legal page titles like `Privacy Policy | Harbor Funding`.
```

In section 7 of the same file, add after the `- [ ] Tokens only in HTML or JSON; Astro styles is:global.` line:

```markdown
- [ ] `/index.html` has `<title>` and `<meta name="description">`; brand name text carries `data-brand`.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --filter @anjuna/template-astro-starter build`, then `cd packages/template-cert && bun run test`.
Expected: PASS, including "the Astro starter passes" with 0 warnings.

Run: `cd workers/template-mcp && bun run test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck` at the repo root. Expected: PASS.

```bash
git add packages/template-cert/src/checks/meta.ts packages/template-cert/src/index.ts packages/template-cert/test/helpers.ts packages/template-cert/test/checks.test.ts packages/template-astro-starter/src/layouts/Base.astro workers/template-mcp/test/fixtures.ts workers/template-mcp/src/contract.ts workers/template-mcp/test/contract.test.ts docs/template-contract.md
git commit -F - <<'EOF'
feat(template-cert): require title and description, warn without data-brand (FUS-345)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 3: Contracts for site text values and the submit result

**Files:**
- Create: `packages/contracts/src/site-text.ts`
- Create: `packages/contracts/src/template-review.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/site-text.test.ts`, `packages/contracts/test/template-review.test.ts`

**Interfaces:**
- Consumes: `isBrandClean` (`common.ts`), `TEMPLATE_RULES.forbiddenWording` (`template.ts`).
- Produces (all exported from `@anjuna/contracts`):
  - `SITE_TEXT_LIMITS = { brand_name: 80, title: 70, description: 160 } as const`
  - `siteTextValue(max: number): z.ZodString`; `SiteBrandName`, `SiteTitle`, `SiteDescription` (each `z.ZodString`)
  - `TemplateTextDefaults` (strict object `{ brand_name: string | null; title: string | null; description: string | null }`) and its type
  - `normalizeSiteText(raw: string | null | undefined, field: keyof typeof SITE_TEXT_LIMITS): string | null`
  - `TEMPLATE_REVIEW_STATUSES`, `TemplateReviewStatus` (`"checking" | "rejected" | "awaiting_approval" | "approved"`)
  - `TEMPLATE_VERSION_REVIEW_STATUS: { draft: "checking"; certifying: "checking"; rejected: "rejected"; certified: "awaiting_approval"; sealed: "approved" }`, `type TemplateVersionStatusName = keyof typeof TEMPLATE_VERSION_REVIEW_STATUS`
  - `TemplateId` (zod string `^[a-z0-9][a-z0-9-]{1,62}$`), `templateSlug(name: string): string`
  - `TemplateSubmitIssue` (`{ rule: string; file?: string; message: string; fix: string }`), `TemplateSubmitResult` (`{ status: "awaiting_approval" | "rejected" | "duplicate"; template_version_id: string | null; version: number | null; sha256: string | null; dashboard_url: string | null; issues; warnings; text_defaults: TemplateTextDefaults | null; similarity: { pass: boolean; summary: string; fixes: string[] } | null; next_step: string }`) and their types

- [ ] **Step 1: Write the failing tests**

Create `packages/contracts/test/site-text.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SITE_TEXT_LIMITS, SiteBrandName, SiteDescription, SiteTitle, TemplateTextDefaults, normalizeSiteText } from "../src/index.js";

describe("site text values", () => {
  it("accepts trimmed plain text up to each limit, including & and '", () => {
    expect(SiteBrandName.parse("  Harbor & Co.  ")).toBe("Harbor & Co.");
    expect(SiteTitle.parse("Harbor's Options")).toBe("Harbor's Options");
    expect(SiteTitle.safeParse("T".repeat(70)).success).toBe(true);
    expect(SiteTitle.safeParse("T".repeat(71)).success).toBe(false);
    expect(SiteDescription.safeParse("d".repeat(160)).success).toBe(true);
    expect(SiteDescription.safeParse("d".repeat(161)).success).toBe(false);
    expect(SiteBrandName.safeParse("B".repeat(81)).success).toBe(false);
  });

  it.each(["", "   ", "Harbor <b>", 'Say "hi"', "line\nbreak", "Anjuna Funding", "AURUM", "Personal Loans Fast", "personal  loan"])("rejects %j", (value) => {
    expect(SiteTitle.safeParse(value).success).toBe(false);
  });

  it("normalizes extracted text: whitespace collapsed, cut to the limit, null when invalid", () => {
    expect(normalizeSiteText("  Harbor \n Funding  ", "brand_name")).toBe("Harbor Funding");
    expect(normalizeSiteText("x".repeat(100), "title")).toBe("x".repeat(70));
    expect(normalizeSiteText("Personal Loans Today", "title")).toBeNull();
    expect(normalizeSiteText(null, "description")).toBeNull();
  });

  it("text defaults are strict and nullable", () => {
    expect(TemplateTextDefaults.parse({ brand_name: null, title: "Harbor | Funding", description: null })).toEqual({ brand_name: null, title: "Harbor | Funding", description: null });
    expect(TemplateTextDefaults.safeParse({ brand_name: null, title: null, description: null, extra: 1 }).success).toBe(false);
    expect(SITE_TEXT_LIMITS).toEqual({ brand_name: 80, title: 70, description: 160 });
  });
});
```

Create `packages/contracts/test/template-review.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TEMPLATE_VERSION_REVIEW_STATUS, TemplateId, TemplateSubmitResult, templateSlug } from "../src/index.js";

describe("template review contracts", () => {
  it("maps every factory status to what the dashboard shows", () => {
    expect(TEMPLATE_VERSION_REVIEW_STATUS).toEqual({
      draft: "checking", certifying: "checking", rejected: "rejected", certified: "awaiting_approval", sealed: "approved",
    });
  });

  it("turns any template name into a valid template id", () => {
    expect(templateSlug("Harbor Funding!")).toBe("harbor-funding");
    expect(templateSlug("Café Ñandú")).toBe("cafe-nandu");
    for (const name of ["แบรนด์", "x", "  "]) expect(TemplateId.safeParse(templateSlug(name)).success, name).toBe(true);
  });

  it("validates the submit result shape", () => {
    const result = {
      status: "rejected", template_version_id: null, version: null, sha256: null, dashboard_url: null,
      issues: [{ rule: "keyword", file: "index.html", message: "No data-kw.", fix: "Add one." }],
      warnings: [], text_defaults: null, similarity: null, next_step: "Fix every issue.",
    };
    expect(TemplateSubmitResult.parse(result)).toEqual(result);
    expect(TemplateSubmitResult.safeParse({ ...result, status: "received" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/contracts && bun run test -- test/site-text.test.ts test/template-review.test.ts`
Expected: FAIL: `SiteBrandName` and `templateSlug` are not exported (`undefined`).

- [ ] **Step 3: Implement the contracts**

Create `packages/contracts/src/site-text.ts`:

```ts
/**
 * Site text a brand serves: brand name, page title, meta description. The template supplies defaults
 * (extracted at submit time); the dashboard can override them per brand; the brand Worker writes them.
 */
import { z } from "zod";
import { isBrandClean } from "./common.js";
import { TEMPLATE_RULES } from "./template.js";

export const SITE_TEXT_LIMITS = { brand_name: 80, title: 70, description: 160 } as const;
export type SiteTextField = keyof typeof SITE_TEXT_LIMITS;

/**
 * One line of visitor-facing text. Control characters and <, >, " are refused so the value is safe in
 * text nodes and double-quoted attributes. Brand clean, and no "personal loan" wording (compliance).
 */
export function siteTextValue(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\u0000-\u001f\u007f<>"]/.test(value), 'Use plain text without <, > or " characters')
    .refine(isBrandClean, "Contains a forbidden platform string")
    .refine((value) => !TEMPLATE_RULES.forbiddenWording.test(value), 'Do not use the words "personal loan"');
}

export const SiteBrandName = siteTextValue(SITE_TEXT_LIMITS.brand_name);
export const SiteTitle = siteTextValue(SITE_TEXT_LIMITS.title);
export const SiteDescription = siteTextValue(SITE_TEXT_LIMITS.description);

const SCHEMAS = { brand_name: SiteBrandName, title: SiteTitle, description: SiteDescription } as const;

/** Defaults extracted from a template version's index.html. Null = the template has none. */
export const TemplateTextDefaults = z.strictObject({
  brand_name: SiteBrandName.nullable(),
  title: SiteTitle.nullable(),
  description: SiteDescription.nullable(),
});
export type TemplateTextDefaults = z.infer<typeof TemplateTextDefaults>;

/** Collapse whitespace and cut to the field's limit; null when nothing valid is left. */
export function normalizeSiteText(raw: string | null | undefined, field: SiteTextField): string | null {
  if (!raw) return null;
  const cut = raw.replace(/\s+/g, " ").trim().slice(0, SITE_TEXT_LIMITS[field]).trim();
  const parsed = SCHEMAS[field].safeParse(cut);
  return parsed.success ? parsed.data : null;
}
```

Create `packages/contracts/src/template-review.ts`:

```ts
/** Template submissions and review (template MCP submit_template, control panel Templates screen). */
import { z } from "zod";
import { TemplateTextDefaults } from "./site-text.js";

export const TEMPLATE_REVIEW_STATUSES = ["checking", "rejected", "awaiting_approval", "approved"] as const;
export const TemplateReviewStatus = z.enum(TEMPLATE_REVIEW_STATUSES);
export type TemplateReviewStatus = z.infer<typeof TemplateReviewStatus>;

/** factory D1 template_versions.status -> what the builder and the dashboard see. */
export const TEMPLATE_VERSION_REVIEW_STATUS = {
  draft: "checking",
  certifying: "checking",
  rejected: "rejected",
  certified: "awaiting_approval",
  sealed: "approved",
} as const satisfies Record<string, TemplateReviewStatus>;
export type TemplateVersionStatusName = keyof typeof TEMPLATE_VERSION_REVIEW_STATUS;

export const TemplateId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "Use 2-63 lowercase letters, digits or dashes");

/** A template id from a display name. Names without Latin letters get a stable "tpl-" id from their code points. */
export function templateSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  if (slug.length >= 2) return slug;
  const code = [...name.trim()].map((c) => c.codePointAt(0)!.toString(36)).join("").slice(0, 40);
  return `tpl-${code || "x"}`;
}

export const TemplateSubmitIssue = z.strictObject({
  rule: z.string().min(1),
  file: z.string().optional(),
  message: z.string().min(1),
  fix: z.string().min(1),
});
export type TemplateSubmitIssue = z.infer<typeof TemplateSubmitIssue>;

export const TemplateSubmitResult = z.strictObject({
  status: z.enum(["awaiting_approval", "rejected", "duplicate"]),
  template_version_id: z.string().nullable(),
  version: z.number().int().positive().nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  dashboard_url: z.string().nullable(),
  issues: z.array(TemplateSubmitIssue),
  warnings: z.array(TemplateSubmitIssue),
  text_defaults: TemplateTextDefaults.nullable(),
  similarity: z.strictObject({ pass: z.boolean(), summary: z.string(), fixes: z.array(z.string()) }).nullable(),
  next_step: z.string().min(1),
});
export type TemplateSubmitResult = z.infer<typeof TemplateSubmitResult>;
```

In `packages/contracts/src/index.ts` append:

```ts
export * from "./site-text.js";
export * from "./template-review.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/contracts && bun run test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck` at the repo root. Expected: PASS.

```bash
git add packages/contracts/src/site-text.ts packages/contracts/src/template-review.ts packages/contracts/src/index.ts packages/contracts/test/site-text.test.ts packages/contracts/test/template-review.test.ts
git commit -F - <<'EOF'
feat(contracts): site text values and template submit result (FUS-345)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 4: Factory D1 0005, text default extraction and deterministic zip

**Files:**
- Create: `packages/factory-db/migrations/0005_template_submissions.sql`
- Modify: `packages/factory-db/src/index.ts` (`FACTORY_DB_MIGRATIONS`)
- Modify: `workers/template-mcp/package.json` (dependency `@anjuna/contracts`), `bun.lock`
- Create: `workers/template-mcp/src/text-defaults.ts`
- Create: `workers/template-mcp/src/submit.ts` (`assembleZip`, `detectFramework`; Task 5 grows it into the pipeline)
- Test: `packages/factory-db/test/factory-db.test.ts`, `workers/template-mcp/test/text-defaults.test.ts` (create), `workers/template-mcp/test/submit.test.ts` (create)

**Interfaces:**
- Consumes: `normalizeSiteText`, `TemplateTextDefaults` (Task 3); `parseHtml`, `allElements`, `visibleText`, `rawText`, `decode` from `workers/template-mcp/src/html.ts`.
- Produces:
  - Columns `template_versions.text_defaults_json` (JSON or NULL), `submitted_by_key_id`, `submitted_by_label`.
  - `extractTextDefaults(files: FileMap): TemplateTextDefaults`.
  - `assembleZip(files: FileMap): Uint8Array` (byte-identical for the same files in any order).
  - `detectFramework(files: FileMap): "astro" | "next_export" | "react_spa"`.

- [ ] **Step 1: Write the failing tests**

Append inside `describe("factory-db migrations", ...)` in `packages/factory-db/test/factory-db.test.ts` (after the last existing test, so migrations are applied):

```ts
  it("stores a submission's text defaults and submitter on the template version", async () => {
    await run("INSERT INTO templates (template_id, name, framework, created_by, created_at) VALUES ('t-sub', 'Submitted', 'react_spa', 'bk_1', ?1)", NOW);
    await run(
      `INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, created_by, created_at,
         text_defaults_json, submitted_by_key_id, submitted_by_label)
       VALUES ('tv-sub', 't-sub', 1, ?1, 'k', 'bk_1', ?2, ?3, 'bk_1', 'Somchai (bolt.new)')`,
      "e".repeat(64), NOW, JSON.stringify({ brand_name: "Harbor", title: "Harbor | Funding", description: null }),
    );
    expect(await env.DB.prepare(
      "SELECT submitted_by_label, json_extract(text_defaults_json, '$.title') AS title FROM template_versions WHERE template_version_id = 'tv-sub'",
    ).first()).toEqual({ submitted_by_label: "Somchai (bolt.new)", title: "Harbor | Funding" });
    await expect(run("UPDATE template_versions SET text_defaults_json = 'not json' WHERE template_version_id = 'tv-sub'"))
      .rejects.toThrow(/CHECK constraint failed/);
  });
```

Create `workers/template-mcp/test/text-defaults.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractTextDefaults } from "../src/text-defaults";

const enc = new TextEncoder();
const site = (index: string) => new Map([["index.html", enc.encode(index)]]);
const withSlot = (head: string) => `<!doctype html><html><head>${head}</head><body><header><a href="/" data-brand>Harbor Funding</a></header></body></html>`;
const noSlot = (head: string) => `<!doctype html><html><head>${head}</head><body><h1>Hi</h1></body></html>`;

describe("extractTextDefaults", () => {
  it("takes the brand name from the first data-brand element and title and description from index.html", () => {
    const head = '<title>Harbor | Fast Options</title><meta name="description" content="Compare  options\n today."><meta property="og:site_name" content="OG Name">';
    expect(extractTextDefaults(site(withSlot(head)))).toEqual({ brand_name: "Harbor Funding", title: "Harbor | Fast Options", description: "Compare options today." });
  });

  it("falls back to og:site_name, then to the part of <title> before ' | '", () => {
    expect(extractTextDefaults(site(noSlot('<title>Harbor | Fast</title><meta property="og:site_name" content="Harbor Co">'))).brand_name).toBe("Harbor Co");
    expect(extractTextDefaults(site(noSlot("<title>Lantern | Cash Options</title>"))).brand_name).toBe("Lantern");
    expect(extractTextDefaults(site(noSlot("<title>Lantern Cash Options</title>"))).brand_name).toBeNull();
  });

  it("cuts to the limits, drops banned wording and returns nulls without index.html", () => {
    const long = extractTextDefaults(site(withSlot(`<title>${"T".repeat(90)}</title><meta name="description" content="${"d".repeat(200)}">`)));
    expect(long.title).toBe("T".repeat(70));
    expect(long.description).toBe("d".repeat(160));
    expect(extractTextDefaults(site(withSlot("<title>Personal Loans | Harbor</title>"))).title).toBeNull();
    expect(extractTextDefaults(new Map())).toEqual({ brand_name: null, title: null, description: null });
  });

  it("decodes entities", () => {
    expect(extractTextDefaults(site(withSlot("<title>Harbor &amp; Co | Funding</title>"))).title).toBe("Harbor & Co | Funding");
  });
});
```

Create `workers/template-mcp/test/submit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readZip } from "../src/archive";
import { assembleZip, detectFramework } from "../src/submit";

const enc = (text: string) => new TextEncoder().encode(text);

describe("assembleZip", () => {
  it("is byte-identical for the same files in any order and round-trips through readZip", () => {
    const a = new Map([["index.html", enc("<h1>a</h1>")], ["assets/site.css", enc("b{}")]]);
    const b = new Map([["assets/site.css", enc("b{}")], ["index.html", enc("<h1>a</h1>")]]);
    const zipA = assembleZip(a);
    expect(assembleZip(b)).toEqual(zipA);
    expect(new TextDecoder().decode(readZip(zipA).get("index.html"))).toBe("<h1>a</h1>");
  });

  it("detects the framework from the build layout", () => {
    expect(detectFramework(new Map([["_astro/a.css", enc("")]]))).toBe("astro");
    expect(detectFramework(new Map([["_next/static/a.js", enc("")]]))).toBe("next_export");
    expect(detectFramework(new Map([["assets/index.js", enc("")]]))).toBe("react_spa");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/factory-db && bun run test`
Expected: FAIL: "table template_versions has no column named text_defaults_json".

Run: `cd workers/template-mcp && bun run test -- test/text-defaults.test.ts test/submit.test.ts`
Expected: FAIL: "Failed to load url ../src/text-defaults" and "Failed to load url ../src/submit".

- [ ] **Step 3: Implement**

Create `packages/factory-db/migrations/0005_template_submissions.sql`:

```sql
-- Migration 0005: builder submissions (template MCP submit_template / submit_template_url).
--
-- text_defaults_json: brand name, page title and meta description extracted from index.html at submit
-- time. They are copied into each brand revision's config_json as the baked fallback.
-- submitted_by_key_id / submitted_by_label: the builder key (or dashboard user) that sent the version.
-- Set before sealing; sealed versions stay immutable (trigger in 0001).

ALTER TABLE template_versions ADD COLUMN text_defaults_json TEXT
  CHECK (text_defaults_json IS NULL OR json_valid(text_defaults_json));
ALTER TABLE template_versions ADD COLUMN submitted_by_key_id TEXT;
ALTER TABLE template_versions ADD COLUMN submitted_by_label TEXT;
```

In `packages/factory-db/src/index.ts` add `"0005_template_submissions.sql",` after `"0004_lifecycle.sql",` in `FACTORY_DB_MIGRATIONS`.

In `workers/template-mcp/package.json` add to `dependencies`:

```json
    "@anjuna/contracts": "workspace:*",
```

Run: `bun install` at the repo root (updates `bun.lock`).

Create `workers/template-mcp/src/text-defaults.ts`:

```ts
/**
 * Site text defaults of a submitted template, read from index.html (spec section 3):
 *   brand_name: first [data-brand] element's text, else og:site_name, else <title> before " | "
 *   title: <title>; description: meta[name=description]
 * Each value is whitespace-collapsed, cut to its limit and dropped when it fails the site text rules.
 */
import { normalizeSiteText, type TemplateTextDefaults } from "@anjuna/contracts";
import type { FileMap } from "./archive";
import { allElements, decode, parseHtml, rawText, visibleText } from "./html";

export function extractTextDefaults(files: FileMap): TemplateTextDefaults {
  const index = files.get("index.html");
  if (!index) return { brand_name: null, title: null, description: null };
  const elements = allElements(parseHtml(decode(index)));
  const titleElement = elements.find((el) => el.name === "title");
  const title = titleElement ? rawText(titleElement) : "";
  const meta = (attribute: "name" | "property", value: string): string | null =>
    elements.find((el) => el.name === "meta" && el.attribs[attribute]?.toLowerCase() === value)?.attribs.content ?? null;
  const slot = elements.find((el) => "data-brand" in el.attribs);
  const brandCandidates = [slot ? visibleText(slot) : null, meta("property", "og:site_name"), title.includes(" | ") ? title.split(" | ")[0]! : null];
  return {
    brand_name: brandCandidates.map((candidate) => normalizeSiteText(candidate, "brand_name")).find((value) => value !== null) ?? null,
    title: normalizeSiteText(title, "title"),
    description: normalizeSiteText(meta("name", "description"), "description"),
  };
}
```

Create `workers/template-mcp/src/submit.ts`:

```ts
/** Template submit pipeline (Task 5). This task adds the deterministic zip and framework detection. */
import { zipSync } from "fflate";
import type { FileMap } from "./archive";

const FIXED_MTIME = new Date(2000, 0, 1, 0, 0, 0);

/** Same files give the same bytes and the same SHA-256: sorted paths, fixed timestamps, fixed compression level. */
export function assembleZip(files: FileMap): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const path of [...files.keys()].sort()) entries[path] = files.get(path)!;
  return zipSync(entries, { level: 6, mtime: FIXED_MTIME });
}

/** templates.framework for a build: Astro and Next export leave their folders; everything else is a Vite/React build. */
export function detectFramework(files: FileMap): "astro" | "next_export" | "react_spa" {
  const paths = [...files.keys()];
  if (paths.some((path) => path.startsWith("_astro/"))) return "astro";
  if (paths.some((path) => path.startsWith("_next/"))) return "next_export";
  return "react_spa";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/factory-db && bun run test` then `cd workers/template-mcp && bun run test`
Expected: PASS for both.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck` at the repo root. Expected: PASS.

```bash
git add packages/factory-db/migrations/0005_template_submissions.sql packages/factory-db/src/index.ts packages/factory-db/test/factory-db.test.ts workers/template-mcp/package.json bun.lock workers/template-mcp/src/text-defaults.ts workers/template-mcp/src/submit.ts workers/template-mcp/test/text-defaults.test.ts workers/template-mcp/test/submit.test.ts
git commit -F - <<'EOF'
feat(template-mcp): text default extraction, deterministic zip, factory D1 0005 (FUS-345)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 5: `submit_template_url`: the full pipeline from a published URL (primary path)

bolt.new cannot pass a built site as a tool argument (Task 1 evidence), so the primary path is: the AI publishes the site and sends only its URL. The server crawls it and runs the pipeline. Task 6 adds the file paths on top of the same `submitTemplate` function.

**Files:**
- Modify: `workers/template-mcp/src/submit.ts` (full file below)
- Modify: `workers/template-mcp/src/certifier.ts` (`importTemplateVersion` params and INSERT; `certifyTemplateVersion` template lookup)
- Modify: `workers/template-mcp/src/tools.ts` (`similarityCheck`, `registerTools`, the `submit_template_url` tool)
- Modify: `workers/template-mcp/src/index.ts` (props, `TemplateMcp` generics)
- Modify: `workers/template-mcp/src/env.ts`, `workers/template-mcp/wrangler.jsonc`, `workers/template-mcp/vitest.config.ts` (`DASHBOARD_URL`)
- Modify: `workers/template-mcp/src/contract.ts` (`deliverable`, `how_to_submit`, `workflow`)
- Modify: `docs/template-contract.md` (section 9), `workers/template-mcp/README.md` (tools table)
- Test: `workers/template-mcp/test/submit.test.ts`, `workers/template-mcp/test/submit-url.test.ts` (create), `workers/template-mcp/test/mcp.test.ts`, `workers/template-mcp/test/contract.test.ts`

**Interfaces:**
- Consumes: Task 1 `visibleBodyText`; Task 3 `TemplateSubmitResult`, `TemplateSubmitIssue`, `TEMPLATE_VERSION_REVIEW_STATUS`, `TemplateVersionStatusName`, `TemplateTextDefaults`; Task 4 `assembleZip`, `detectFramework`, `extractTextDefaults`; existing `loadFromUrl`, `checkTemplate`, `normalizeRoot`, `otherBrands`, `similarityCheck`, `importTemplateVersion`, `certifyTemplateVersion`, `BuilderIdentity`.
- Produces:
  - `interface SubmittedBy { key_id: string | null; label: string }`
  - `interface SubmitRequest { template_id: string; template_name: string; files: FileMap; submitted_by: SubmittedBy; created_by: string }`
  - `type SubmitResult = TemplateSubmitResult`
  - `submitTemplate(env: Env, request: SubmitRequest): Promise<SubmitResult>` (Task 6 and Task 7 call it)
  - `result(partial): SubmitResult`, `limitRejection(error: unknown, warnings?: TemplateSubmitIssue[]): SubmitResult | null`, `dashboardUrl(env, templateVersionId): string | null` (`${DASHBOARD_URL}/#templates/<id>`), constants `REDUCE_IMAGES`, `NEXT_REJECTED`, `SPA_MESSAGE`
  - `isClientRenderedShell(files: FileMap): boolean`
  - `interface SubmitUrlRequest extends Omit<SubmitRequest, "files"> { url: string }`; `submitTemplateUrl(env: Env, request: SubmitUrlRequest): Promise<SubmitResult>`
  - `similarityCheck(env, files, brandId?: string, excludeTemplateId?: string)` (new 4th parameter)
  - `registerTools(server, env, builder: BuilderIdentity | null = null)`
  - `importTemplateVersion` params gain `submitted_by?: SubmittedBy | null`, `text_defaults?: TemplateTextDefaults | null`
  - `Env.DASHBOARD_URL?: string`
  - MCP tool `submit_template_url { url, template_id, template_name }` returning a `SubmitResult`.

- [ ] **Step 1: Write the failing pipeline tests**

At the top of `workers/template-mcp/test/submit.test.ts`, replace the imports with:

```ts
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateSubmitResult } from "@anjuna/contracts";
import { readZip } from "../src/archive";
import { computeFingerprint } from "../src/fingerprint";
import { assembleZip, detectFramework, submitTemplate, type SubmitRequest } from "../src/submit";
import { goodSite, withFile, withIndex } from "./fixtures";
import { NOW, addBrand, addSealedTemplate, resetDb, setupDb } from "./helpers";

vi.mock("../src/screenshots", () => ({ takeScreenshot: vi.fn() }));
import { takeScreenshot } from "../src/screenshots";
```

Append to the same file:

```ts
const browserEnv = { ...env, BROWSER: {} as Fetcher };
const builder = { key_id: "bk_test", label: "Somchai (bolt.new)" };
const request = (files = goodSite(), over: Partial<SubmitRequest> = {}): SubmitRequest => ({
  template_id: "harbor", template_name: "Harbor", files, submitted_by: builder, created_by: "bk_test", ...over,
});
const versions = async () =>
  (await env.FACTORY.prepare("SELECT template_version_id, status, submitted_by_key_id, submitted_by_label, text_defaults_json FROM template_versions ORDER BY created_at").all<Record<string, unknown>>()).results;

describe("submitTemplate", () => {
  beforeAll(setupDb);
  beforeEach(async () => {
    await resetDb();
    vi.mocked(takeScreenshot).mockReset().mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
  });

  it("imports, certifies and records the submitter and text defaults", async () => {
    const result = TemplateSubmitResult.parse(await submitTemplate(browserEnv, request()));
    expect(result).toMatchObject({
      status: "awaiting_approval", template_version_id: "tv_harbor_v1", version: 1, issues: [],
      text_defaults: { brand_name: "Harbor", title: "Harbor | Funding", description: "Check your funding options in minutes." },
      dashboard_url: "https://app.test/#templates/tv_harbor_v1",
    });
    const [row] = await versions();
    expect(row).toMatchObject({ status: "certified", submitted_by_key_id: "bk_test", submitted_by_label: "Somchai (bolt.new)" });
    expect(JSON.parse(String(row!.text_defaults_json))).toEqual(result.text_defaults);
    const stored = await env.FACTORY.prepare("SELECT r2_key, sha256 FROM template_versions").first<{ r2_key: string; sha256: string }>();
    expect(stored!.sha256).toBe(result.sha256);
    expect(await env.ARTIFACTS.head(stored!.r2_key)).not.toBeNull();
  });

  it("returns the existing version for the same files in any order and creates nothing", async () => {
    const first = await submitTemplate(browserEnv, request());
    const again = await submitTemplate(browserEnv, request(new Map([...goodSite()].reverse())));
    expect(again).toMatchObject({ status: "duplicate", template_version_id: first.template_version_id, sha256: first.sha256 });
    expect(await versions()).toHaveLength(1);
  });

  it("rejects contract failures with rule, file, message and fix, and stores nothing", async () => {
    const before = (await env.ARTIFACTS.list()).objects.map((o) => o.key);
    const result = await submitTemplate(browserEnv, request(withIndex(goodSite(), (h) => h.replace("<span data-kw>", "<span>"))));
    expect(result).toMatchObject({ status: "rejected", template_version_id: null });
    const keyword = result.issues.filter((i) => i.rule === "keyword");
    expect(keyword.length).toBeGreaterThan(0);
    for (const issue of keyword) expect(issue).toEqual({ rule: "keyword", file: "index.html", message: expect.any(String), fix: expect.any(String) });
    expect(await versions()).toHaveLength(0);
    expect((await env.ARTIFACTS.list()).objects.map((o) => o.key)).toEqual(before);
  });

  it("rejects a near copy of another brand's sealed template, naming the brand", async () => {
    await addBrand("b_lantern", "Lantern Finance", "lanternfinance.com");
    await addSealedTemplate({ id: "lantern", name: "Lantern", fingerprint: await computeFingerprint(goodSite()), brandId: "b_lantern" });
    const result = await submitTemplate(browserEnv, request());
    expect(result.status).toBe("rejected");
    expect(result.similarity?.pass).toBe(false);
    expect(result.issues.some((i) => i.rule === "similarity" && /Lantern Finance/.test(`${i.message} ${i.fix}`))).toBe(true);
    expect(await versions()).toHaveLength(0);
  });

  it("does not compare a new version with the same template's own sealed versions", async () => {
    const fingerprint = JSON.stringify(await computeFingerprint(goodSite()));
    await env.FACTORY.batch([
      env.FACTORY.prepare("INSERT INTO templates (template_id, name, framework, created_by, created_at) VALUES ('harbor', 'Harbor', 'react_spa', 'u', ?1)").bind(NOW),
      env.FACTORY.prepare("INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at) VALUES ('tv_harbor_v1', 'harbor', 1, ?1, 'k', 'sealed', 'u', ?2, 'u', ?2)").bind("f".repeat(64), NOW),
      env.FACTORY.prepare("INSERT INTO template_fingerprints (template_version_id, fingerprint_json, created_at) VALUES ('tv_harbor_v1', ?1, ?2)").bind(fingerprint, NOW),
    ]);
    const result = await submitTemplate(browserEnv, request(withIndex(goodSite(), (h) => h.replace("Answer two", "Answer two short"))));
    expect(result).toMatchObject({ status: "awaiting_approval", template_version_id: "tv_harbor_v2", version: 2 });
  });

  it("rejects a template name owned by another template id", async () => {
    await env.FACTORY.prepare("INSERT INTO templates (template_id, name, framework, created_by, created_at) VALUES ('lantern', 'Harbor', 'astro', 'u', ?1)").bind(NOW).run();
    const result = await submitTemplate(browserEnv, request());
    expect(result).toMatchObject({ status: "rejected", template_version_id: null });
    expect(result.issues).toEqual([expect.objectContaining({ rule: "template-name", fix: expect.stringContaining('"lantern"') })]);
  });

  it("rejects an archive over the limits with 'reduce image sizes'", async () => {
    const result = await submitTemplate(browserEnv, request(withFile(goodSite(), "img/hero.png", new Uint8Array(11 * 1024 * 1024))));
    expect(result.status).toBe("rejected");
    expect(result.issues[0]).toMatchObject({ rule: "archive-limits" });
    expect(result.issues[0]!.fix).toMatch(/reduce image sizes/i);
  });

  it("stores a version whose screenshots fail as rejected, with a platform fix", async () => {
    vi.mocked(takeScreenshot).mockRejectedValue(new Error("Browser Rendering quota exceeded"));
    const result = await submitTemplate(browserEnv, request());
    expect(result).toMatchObject({ status: "rejected", template_version_id: "tv_harbor_v1" });
    expect(result.issues.map((i) => i.rule)).toEqual(["screenshot_desktop", "screenshot_mobile"]);
    expect(result.issues[0]!.fix).toMatch(/platform problem/);
    expect((await versions())[0]).toMatchObject({ status: "rejected" });
  });
});
```

Append to `workers/template-mcp/test/fixtures.ts` (add `import { vi } from "vitest";` at the top):

```ts
/** A client-rendered SPA shell: no visible body text, content only after JavaScript runs. */
export const spaShell: FileMap = new Map([["index.html", enc(
  '<!doctype html><html><head><title>Harbor | App</title></head><body><div id="root"></div><noscript>Enable JavaScript</noscript><script type="module" src="/assets/index.js"></script></body></html>',
)]]);

/** Stub fetch as a static host serving dist/ files (/ -> index.html, /privacy/ -> privacy/index.html); anything else gets bolt.host's 404. */
export function serve(files: FileMap): void {
  vi.stubGlobal("fetch", async (input: string) => {
    const path = new URL(String(input)).pathname;
    const key = path === "/" ? "index.html" : path.endsWith("/") ? `${path.slice(1)}index.html` : path.slice(1);
    const body = files.get(key);
    return body
      ? new Response(body, { headers: { "content-type": key.endsWith(".css") ? "text/css" : "text/html" } })
      : new Response("Website not found", { status: 404, headers: { "content-type": "text/html" } });
  });
}
```

Create `workers/template-mcp/test/submit-url.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SPA_MESSAGE, isClientRenderedShell, submitTemplateUrl } from "../src/submit";
import { goodSite, serve, spaShell as spa } from "./fixtures";
import { resetDb, setupDb } from "./helpers";

vi.mock("../src/screenshots", () => ({ takeScreenshot: vi.fn() }));
import { takeScreenshot } from "../src/screenshots";

const browserEnv = { ...env, BROWSER: {} as Fetcher };

const submit = (url: string) =>
  submitTemplateUrl(browserEnv, { url, template_id: "harbor", template_name: "Harbor", submitted_by: { key_id: "bk_test", label: "tester" }, created_by: "bk_test" });
const count = async () => (await env.FACTORY.prepare("SELECT count(*) AS n FROM template_versions").first<{ n: number }>())!.n;

beforeAll(setupDb);
beforeEach(async () => {
  await resetDb();
  vi.mocked(takeScreenshot).mockReset().mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
});
afterEach(() => vi.unstubAllGlobals());

describe("submitTemplateUrl", () => {
  it("tells a client-rendered shell from a static page", () => {
    expect(isClientRenderedShell(spa)).toBe(true);
    expect(isClientRenderedShell(goodSite())).toBe(false);
  });

  it("crawls a published static site and runs the full pipeline", async () => {
    serve(goodSite());
    expect(await submit("https://harbor.bolt.host/")).toMatchObject({ status: "awaiting_approval", template_version_id: "tv_harbor_v1" });
  });

  it("rejects an SPA with the static HTML instruction and stores nothing", async () => {
    serve(spa);
    const result = await submit("https://harbor.bolt.host/");
    expect(result).toMatchObject({ status: "rejected", template_version_id: null, next_step: SPA_MESSAGE });
    expect(result.issues[0]).toMatchObject({
      rule: "static-html", file: "index.html",
      message: "This site renders with JavaScript. Ask bolt.new to make it static HTML, then submit again.",
    });
    expect(await count()).toBe(0);
  });

  it("rejects a published URL that answers 'Website not found' with the publish-again fix", async () => {
    serve(new Map());
    const result = await submit("https://gone.bolt.host/");
    expect(result).toMatchObject({ status: "rejected", template_version_id: null });
    expect(result.issues).toEqual([expect.objectContaining({ rule: "published-url", message: expect.stringContaining("404"), fix: expect.stringContaining("Publish the site again") })]);
    expect(await count()).toBe(0);
  });
});
```

In `workers/template-mcp/test/mcp.test.ts`, add `serve` to the `./fixtures` import, and in the tool list test add:

```ts
    expect(names).toContain("submit_template_url");
```

and add inside `describe("tools over streamable HTTP", ...)`:

```ts
  it("submit_template_url: crawls the site and records the calling builder key", async () => {
    serve(goodSite());
    const client = await connect();
    const { isError, data } = await callTool(client, "submit_template_url", { url: "https://harbor.bolt.host/", template_id: "harbor", template_name: "Harbor" });
    expect(isError).toBe(false);
    // This pool has no BROWSER binding: certification stores the version and rejects it on the screenshots.
    expect(data).toMatchObject({ status: "rejected", template_version_id: "tv_harbor_v1" });
    const row = await env.FACTORY.prepare("SELECT submitted_by_key_id, submitted_by_label FROM template_versions WHERE template_version_id = 'tv_harbor_v1'").first();
    expect(row).toEqual({ submitted_by_key_id: "bk_test", submitted_by_label: "test builder" });
    await client.close();
  });
```

In `workers/template-mcp/test/contract.test.ts` add inside the `describe`:

```ts
  it("tells the builder to publish and submit the URL", () => {
    const steps = contractForBuilders().how_to_submit.join(" ");
    expect(steps).toContain("probe_url");
    expect(steps).toContain("submit_template_url");
    expect(doc).toContain("## 9. How to submit (bolt.new)");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd workers/template-mcp && bun run test -- test/submit.test.ts test/submit-url.test.ts test/mcp.test.ts test/contract.test.ts`
Expected: FAIL: `submitTemplate is not a function`, `submitTemplateUrl is not a function`, `expected [...] to contain 'submit_template_url'`, and `how_to_submit` is undefined.

- [ ] **Step 3: Write `submit.ts`**

Replace `workers/template-mcp/src/submit.ts` with:

```ts
/**
 * Template submit pipeline, shared by submit_template_url (primary for bolt.new), submit_template and
 * finish_upload (Task 6) and the dashboard import (Task 7): deterministic zip, contract checks, similarity,
 * import (R2 + factory D1 draft), certification and text-default extraction. Template code never runs.
 */
import { zipSync } from "fflate";
import {
  TEMPLATE_VERSION_REVIEW_STATUS,
  type TemplateSubmitIssue,
  type TemplateSubmitResult,
  type TemplateVersionStatusName,
} from "@anjuna/contracts";
import { InputError, readZip, type FileMap } from "./archive";
import { certifyTemplateVersion, importTemplateVersion } from "./certifier";
import { checkTemplate, normalizeRoot, type Issue } from "./checker";
import type { Env } from "./env";
import { decode } from "./html";
import { loadFromUrl, type Loaded } from "./input";
import { visibleBodyText } from "./probe";
import { extractTextDefaults } from "./text-defaults";
import { otherBrands, similarityCheck, type SimilarityReport } from "./tools";

const FIXED_MTIME = new Date(2000, 0, 1, 0, 0, 0);

/** Same files give the same bytes and the same SHA-256: sorted paths, fixed timestamps, fixed compression level. */
export function assembleZip(files: FileMap): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const path of [...files.keys()].sort()) entries[path] = files.get(path)!;
  return zipSync(entries, { level: 6, mtime: FIXED_MTIME });
}

/** templates.framework for a build: Astro and Next export leave their folders; everything else is a Vite/React build. */
export function detectFramework(files: FileMap): "astro" | "next_export" | "react_spa" {
  const paths = [...files.keys()];
  if (paths.some((path) => path.startsWith("_astro/"))) return "astro";
  if (paths.some((path) => path.startsWith("_next/"))) return "next_export";
  return "react_spa";
}

// ── Pipeline ───────────────────────────────────────────────────────────────────

export interface SubmittedBy {
  key_id: string | null;
  label: string;
}

export interface SubmitRequest {
  template_id: string;
  template_name: string;
  files: FileMap;
  submitted_by: SubmittedBy;
  /** templates.created_by / template_versions.created_by: the builder key id, or the dashboard user id. */
  created_by: string;
}

export type SubmitResult = TemplateSubmitResult;

const LIMIT_CODES = new Set(["too_large", "file_too_large", "too_many_files"]);
export const REDUCE_IMAGES =
  "Reduce image sizes (compress or resize images, remove unused files) so the build stays under 30 MB, 2000 files and 10 MB per file, then submit again.";
export const NEXT_REJECTED = "Fix every item in issues, rebuild, and submit again the same way.";
const NEXT_WAITING = "Submitted. The owner reviews and approves it in the dashboard under Templates. Nothing else to do.";

export function result(partial: Partial<SubmitResult> & Pick<SubmitResult, "status" | "next_step">): SubmitResult {
  return {
    template_version_id: null, version: null, sha256: null, dashboard_url: null,
    issues: [], warnings: [], text_defaults: null, similarity: null, ...partial,
  };
}

const toIssue = (issue: Issue): TemplateSubmitIssue => ({
  rule: issue.rule,
  ...(issue.file ? { file: issue.file } : {}),
  message: issue.message,
  fix: issue.fix ?? issue.message,
});

/** An over-limit build is the builder's to fix, so it is a rejected result, not a tool error. */
export function limitRejection(error: unknown, warnings: TemplateSubmitIssue[] = []): SubmitResult | null {
  if (!(error instanceof InputError) || !LIMIT_CODES.has(error.code)) return null;
  return result({ status: "rejected", issues: [{ rule: "archive-limits", message: error.message, fix: REDUCE_IMAGES }], warnings, next_step: NEXT_REJECTED });
}

export function dashboardUrl(env: Pick<Env, "DASHBOARD_URL">, templateVersionId: string): string | null {
  return env.DASHBOARD_URL ? `${env.DASHBOARD_URL.replace(/\/+$/, "")}/#templates/${encodeURIComponent(templateVersionId)}` : null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function similarityIssues(report: SimilarityReport): TemplateSubmitIssue[] {
  if (report.pass) return [];
  const fixes = report.fixes.length > 0 ? report.fixes : ["Change the layout, copy and images so the design is clearly different."];
  return fixes.map((fix) => ({ rule: "similarity", message: report.summary, fix }));
}

/** certify repair messages look like "[rule] message". */
function certificationIssue(message: string): TemplateSubmitIssue {
  const match = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(message);
  const rule = match?.[1] ?? "certification";
  const fix = rule.startsWith("screenshot_")
    ? "This is a platform problem, not a template problem. Tell the owner; submit again later without changes."
    : "Fix what the message describes, rebuild, and submit again.";
  return { rule, message: match?.[2] || message, fix };
}

export async function submitTemplate(env: Env, request: SubmitRequest): Promise<SubmitResult> {
  const { files, notes } = normalizeRoot(request.files);
  const warnings = notes.map(toIssue);

  let zip: Uint8Array;
  try {
    zip = assembleZip(files);
    readZip(zip); // the import limits: 30 MB, 2000 files, 10 MB per file
  } catch (error) {
    const rejected = limitRejection(error, warnings);
    if (rejected) return rejected;
    throw error;
  }
  const sha256 = await sha256Hex(zip);

  const existing = await env.FACTORY.prepare("SELECT template_version_id, version, status FROM template_versions WHERE sha256 = ?1")
    .bind(sha256)
    .first<{ template_version_id: string; version: number; status: TemplateVersionStatusName }>();
  if (existing) {
    return result({
      status: "duplicate", template_version_id: existing.template_version_id, version: existing.version, sha256,
      dashboard_url: dashboardUrl(env, existing.template_version_id), warnings,
      next_step: `This exact build is already version ${existing.version} (${TEMPLATE_VERSION_REVIEW_STATUS[existing.status]}). Nothing was created.`,
    });
  }

  const nameOwner = await env.FACTORY.prepare("SELECT template_id FROM templates WHERE name = ?1 AND template_id != ?2")
    .bind(request.template_name, request.template_id)
    .first<{ template_id: string }>();
  if (nameOwner) {
    return result({
      status: "rejected", sha256, warnings, next_step: NEXT_REJECTED,
      issues: [{
        rule: "template-name",
        message: `The template name "${request.template_name}" already belongs to template_id "${nameOwner.template_id}".`,
        fix: `Send template_id "${nameOwner.template_id}" to add a new version of that template, or choose another template_name.`,
      }],
    });
  }

  const report = checkTemplate(files, { otherBrands: await otherBrands(env) });
  const errors = report.issues.filter((issue) => issue.severity === "error").map(toIssue);
  warnings.push(...report.issues.filter((issue) => issue.severity === "warning").map(toIssue));
  const similarity = await similarityCheck(env, files, undefined, request.template_id);
  const brief = { pass: similarity.pass, summary: similarity.summary, fixes: similarity.fixes };
  if (errors.length > 0 || !similarity.pass) {
    return result({ status: "rejected", sha256, warnings, similarity: brief, issues: [...errors, ...similarityIssues(similarity)], next_step: NEXT_REJECTED });
  }

  const text_defaults = extractTextDefaults(files);
  const imported = await importTemplateVersion(env.FACTORY, env.ARTIFACTS, zip, {
    template_id: request.template_id,
    template_name: request.template_name,
    framework: detectFramework(files),
    created_by: request.created_by,
    submitted_by: request.submitted_by,
    text_defaults,
  });
  const certified = await certifyTemplateVersion(env, imported.template_version_id);
  const waiting = certified.status === "certified";
  return result({
    status: waiting ? "awaiting_approval" : "rejected",
    template_version_id: imported.template_version_id,
    version: imported.version,
    sha256,
    dashboard_url: dashboardUrl(env, imported.template_version_id),
    issues: waiting ? [] : certified.repair_messages.map(certificationIssue),
    warnings,
    text_defaults,
    similarity: brief,
    next_step: waiting ? NEXT_WAITING : NEXT_REJECTED,
  });
}

// ── Published URL (primary path for bolt.new) ──────────────────────────────────

export const SPA_MESSAGE = "This site renders with JavaScript. Ask bolt.new to make it static HTML, then submit again.";
const PUBLISH_AGAIN =
  "Publish the site again in bolt.new, open the published URL in a browser to confirm it shows the page, run probe_url on it, then call submit_template_url with that exact URL.";
const URL_CODES = new Set(["fetch_failed", "unsupported_url", "too_many_redirects"]);

/** True when index.html has no visible body text: a client-rendered shell whose content only JavaScript would add. */
export function isClientRenderedShell(input: FileMap): boolean {
  const index = normalizeRoot(input).files.get("index.html");
  return index ? visibleBodyText(decode(index)).length === 0 : false; // a missing index.html is the structure check's
}

export interface SubmitUrlRequest extends Omit<SubmitRequest, "files"> {
  url: string;
}

/** Crawl the published site (https, public hosts, 3 redirects, 150 requests; JavaScript never runs), then submit it. */
export async function submitTemplateUrl(env: Env, request: SubmitUrlRequest): Promise<SubmitResult> {
  const { url, ...rest } = request;
  let loaded: Loaded;
  try {
    loaded = await loadFromUrl(url);
  } catch (error) {
    if (error instanceof InputError && URL_CODES.has(error.code)) {
      return result({ status: "rejected", next_step: PUBLISH_AGAIN, issues: [{ rule: "published-url", message: error.message, fix: PUBLISH_AGAIN }] });
    }
    const rejected = limitRejection(error);
    if (rejected) return rejected;
    throw error;
  }
  if (isClientRenderedShell(loaded.files)) {
    return result({
      status: "rejected",
      next_step: SPA_MESSAGE,
      issues: [{
        rule: "static-html",
        file: "index.html",
        message: SPA_MESSAGE,
        fix: "In bolt.new, ask: \"Prerender every page to static HTML at build time so dist/index.html contains the full page text.\" Then publish and submit again.",
      }],
    });
  }
  return submitTemplate(env, { ...rest, files: loaded.files });
}
```

- [ ] **Step 4: Store submitter and text defaults; exclude the same template from similarity**

In `workers/template-mcp/src/certifier.ts` add `import type { TemplateTextDefaults } from "@anjuna/contracts";` and replace the `params` type of `importTemplateVersion` with:

```ts
  params: {
    template_id: string;
    template_name: string;
    framework: "astro" | "next_export" | "react_spa";
    created_by: string;
    /** Builder submit: the builder key (or dashboard user) that sent it. */
    submitted_by?: { key_id: string | null; label: string } | null;
    /** Builder submit: brand name, title and description extracted from index.html. */
    text_defaults?: TemplateTextDefaults | null;
  },
```

Replace the `INSERT INTO template_versions` batch in `importTemplateVersion` with:

```ts
  await db.batch([parent, db
    .prepare(
      `INSERT INTO template_versions
         (template_version_id, template_id, version, sha256, r2_key, status, created_by, created_at,
          text_defaults_json, submitted_by_key_id, submitted_by_label)
       VALUES (?1, ?2, ?3, ?4, ?5, 'draft', ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(template_version_id, params.template_id, version, sha256, r2_key, params.created_by, now,
      params.text_defaults ? JSON.stringify(params.text_defaults) : null,
      params.submitted_by?.key_id ?? null, params.submitted_by?.label ?? null),
    audit(db, "template.import", template_version_id, params.created_by, "system", null, { status: "draft", sha256, r2_key }, now),
  ]);
```

In `certifyTemplateVersion` replace the version lookup and the similarity call:

```ts
  const tv = await db
    .prepare("SELECT r2_key, status, template_id FROM template_versions WHERE template_version_id = ?1")
    .bind(template_version_id)
    .first<{ r2_key: string; status: string; template_id: string }>();
```

```ts
  // Earlier sealed versions of the same template are its own history, not another brand's design.
  const similarity = await similarityCheck(env as Env, files, brand_id, tv.template_id);
```

In `workers/template-mcp/src/tools.ts` replace the head of `similarityCheck` through the first line of the `for (const [id, entry] of byVersion)` loop with:

```ts
export async function similarityCheck(env: Env, files: FileMap, brandId?: string, excludeTemplateId?: string): Promise<SimilarityReport> {
  const threshold = similarityThreshold(env);
  const candidate = await computeFingerprint(files);
  const { results } = await env.FACTORY.prepare(
    `SELECT f.template_version_id, f.fingerprint_json, t.name AS template, tv.template_id, tv.version,
            b.brand_id, b.name AS brand_name, b.domain
       FROM template_fingerprints f
       JOIN template_versions tv ON tv.template_version_id = f.template_version_id
       JOIN templates t ON t.template_id = tv.template_id
       LEFT JOIN brand_revisions br ON br.template_version_id = tv.template_version_id
       LEFT JOIN brands b ON b.brand_id = br.brand_id
      WHERE tv.status = 'sealed'`,
  ).all<{ template_version_id: string; fingerprint_json: string; template: string; template_id: string; version: number; brand_id: string | null; brand_name: string | null; domain: string | null }>();

  const byVersion = new Map<string, { fingerprint: string; template: string; template_id: string; version: number; brands: SimilarityMatch["brands"] }>();
  for (const row of results) {
    const entry = byVersion.get(row.template_version_id) ?? { fingerprint: row.fingerprint_json, template: row.template, template_id: row.template_id, version: row.version, brands: [] };
    if (row.brand_id) entry.brands.push({ brand_id: row.brand_id, name: row.brand_name ?? "", domain: row.domain ?? "" });
    byVersion.set(row.template_version_id, entry);
  }
  const matches: SimilarityMatch[] = [];
  for (const [id, entry] of byVersion) {
    if (excludeTemplateId && entry.template_id === excludeTemplateId) continue; // earlier versions of the same template
    if (brandId && entry.brands.some((b) => b.brand_id === brandId)) continue; // the brand's own earlier template
```

The rest of the loop body (from `let other: Fingerprint;`) stays unchanged.

- [ ] **Step 5: Pass the builder identity to the tools and register `submit_template_url`**

In `workers/template-mcp/src/tools.ts` add:

```ts
import type { BuilderIdentity } from "./auth";
import { submitTemplateUrl } from "./submit";
```

Change the `registerTools` signature:

```ts
export function registerTools(server: McpServer, env: Env, builder: BuilderIdentity | null = null): void {
```

Add after the `probe_url` registration:

```ts
  // ── Builder submit ────────────────────────────────────────────────────────

  server.registerTool(
    "submit_template_url",
    {
      title: "Submit a published template by URL",
      description:
        "The way to submit from bolt.new: publish the site, run probe_url on the published URL, then call this with the URL. " +
        "The server downloads the HTML, CSS and images (JavaScript never runs), zips them, checks them against the contract and " +
        "against other brands' designs, stores the version and runs certification. Result status: awaiting_approval (done; the " +
        "owner approves it in the dashboard), rejected (fix every issue, publish again and call again), duplicate (this exact build " +
        "was already submitted). A page that only renders with JavaScript is rejected. Read get_template_contract first.",
      inputSchema: {
        url: z.string().url().describe("https URL of the published site, exactly as bolt.new shows it after publishing."),
        template_id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "Use 2-63 lowercase letters, digits or dashes, e.g. harbor-funding")
          .describe("Lowercase slug for this template. Send the same template_id again to add a new version."),
        template_name: z.string().trim().min(1).max(128).describe("Template name shown in the dashboard."),
      },
    },
    async (args) => {
      try {
        if (!builder) return text({ error: "unauthorized", message: "This session has no builder key." }, true);
        return text(await submitTemplateUrl(env, {
          url: args.url,
          template_id: args.template_id,
          template_name: args.template_name,
          submitted_by: { key_id: builder.keyId, label: builder.label },
          created_by: builder.keyId,
        }));
      } catch (error) {
        return failure(error);
      }
    },
  );
```

In `workers/template-mcp/src/index.ts` replace the class and the authenticated branch:

```ts
import type { BuilderIdentity } from "./auth";

type McpProps = { builder: BuilderIdentity };

/** The MCP protocol endpoint. Authentication happens in the Worker's fetch handler before a request gets here. */
export class TemplateMcp extends McpAgent<Env, unknown, McpProps> {
  server = new McpServer({ name: "anjuna-template-mcp", version: "0.1.0" });

  async init(): Promise<void> {
    registerTools(this.server, this.env, this.props?.builder ?? null);
  }
}
```

```ts
    const auth = await authenticate(request, env);
    if (!auth.ok) return auth.response;
    // McpAgent stores ctx.props on the session and exposes it as this.props in init().
    (ctx as unknown as { props: McpProps }).props = { builder: auth.builder };
    return handler.fetch(request, env, ctx);
```

In `workers/template-mcp/src/env.ts` add inside `interface Env`:

```ts
      /** Control panel origin for links in submit results, e.g. https://app.aduplift.ai. */
      DASHBOARD_URL?: string;
```

In `workers/template-mcp/wrangler.jsonc` replace the `vars` line with:

```jsonc
  "vars": { "RATE_LIMIT_PER_MINUTE": "60", "SIMILARITY_THRESHOLD": "0.5", "DASHBOARD_URL": "https://app.aduplift.ai" }
```

In `workers/template-mcp/vitest.config.ts` replace the `bindings` line with:

```ts
                bindings: { MIGRATIONS: migrations, RATE_LIMIT_PER_MINUTE: "1000", SIMILARITY_THRESHOLD: "0.5", OWNER_SECRET: "test-owner-secret", DASHBOARD_URL: "https://app.test" },
```

- [ ] **Step 6: Tell builders how to submit**

In `workers/template-mcp/src/contract.ts`, in `contractForBuilders()`, replace `deliverable` and `workflow` and add `how_to_submit`:

```ts
    deliverable: "Static output only: the built dist/ folder (max 30 MB, 2000 files, 10 MB per file). Every page must be real HTML, not an empty <div id=\"root\"> filled by JavaScript.",
    how_to_submit: [
      "1. Build static HTML: run npm run build. Every page in dist/ must contain its real text; a dist/index.html that is only <div id=\"root\"></div> plus a script is rejected.",
      "2. Publish the site in bolt.new. Use the published URL exactly as bolt.new shows it.",
      "3. Call probe_url with that URL. ok must be true. If status is 404 (\"Website not found\"), publish again and wait a minute. If client_rendered is true, make the pages static HTML first.",
      "4. Call submit_template_url with url, template_id (lowercase slug, e.g. harbor-funding) and template_name. Do not paste files or zips into a tool call.",
      "5. status awaiting_approval: done; tell the user the owner approves it in the dashboard. status rejected: fix every item in issues (each has rule, file, message, fix), publish again and call submit_template_url again. status duplicate: this exact build was already submitted; nothing changed.",
      "6. \"reduce image sizes\" means the build is over 30 MB, 2000 files or 10 MB per file: compress or resize images and submit again.",
    ],
```

```ts
    workflow: [
      "1. Design a unique layout, visual identity, copy and imagery for this brand.",
      "2. Build to static HTML (npm run build) and publish it.",
      "3. Call probe_url, then submit_template_url. It runs the same checks as check_template and similarity_check.",
      "4. If status is rejected, fix every issue, publish again and submit again. Stop when status is awaiting_approval or duplicate.",
      "5. Without submit access: zip dist/, call check_template and similarity_check until both pass, and hand the zip to the owner.",
    ],
```

Append to `docs/template-contract.md`:

```markdown
## 9. How to submit (bolt.new)

A bolt.new chat cannot pass a built site as one tool argument (on 2026-10-17 a 101 KB zip, 135,284 base64 characters, failed). Submit the published URL instead.

1. Build static HTML: `npm run build`. Every page in `dist/` must contain its real text. A `dist/index.html` that is only `<div id="root"></div>` plus a script is rejected.
2. Publish the site in bolt.new and keep the published URL exactly as bolt.new shows it.
3. Call `probe_url` with that URL. `ok` must be `true`. A 404 "Website not found" means the publish is not live yet: publish again and wait a minute.
4. Call `submit_template_url` with `url`, `template_id` (lowercase slug, for example `harbor-funding`) and `template_name`.
5. Read `status` in the result:
   - `awaiting_approval`: done. The owner approves it in the dashboard (Templates).
   - `rejected`: fix every item in `issues` (`rule`, `file`, `message`, `fix`), publish again and call `submit_template_url` again.
   - `duplicate`: this exact build was already submitted. Nothing changed.
6. "reduce image sizes" means the build is over 30 MB, 2000 files or 10 MB per file. Compress or resize images and submit again.
```

In `workers/template-mcp/README.md`, add these rows to the Tools table:

```markdown
| `probe_url` | `url` | every redirect hop and status, `final_url`, `visible_text_chars`, `client_rendered`, `ok` |
| `measure_payload` | `text` | `received_chars`, `received_bytes` (sizes `upload_files` batches) |
| `submit_template_url` | `url` (published static site), `template_id`, `template_name` | `status` `awaiting_approval` / `rejected` / `duplicate`, `issues` (`rule`, `file`, `message`, `fix`), `dashboard_url`, `text_defaults`. Primary path for bolt.new; stores the builder key's id and label |
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd workers/template-mcp && bun run test`
Expected: PASS, including the 8 `submitTemplate` tests, the 4 `submitTemplateUrl` tests and the existing certifier tests.

- [ ] **Step 8: Typecheck and commit**

Run: `bun run typecheck` at the repo root. Expected: PASS.

```bash
git add workers/template-mcp docs/template-contract.md
git commit -F - <<'EOF'
feat(template-mcp): submit_template_url runs the full import pipeline (FUS-345)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 6: `submit_template` and chunked upload (second path, for builders that cannot publish)

**Files:**
- Create: `packages/factory-db/migrations/0006_template_uploads.sql`
- Modify: `packages/factory-db/src/index.ts` (`FACTORY_DB_MIGRATIONS`)
- Modify: `workers/template-mcp/src/submit.ts` (append the file-list section below; add `LIMITS`, `safePath` to the `./archive` import and `import { z } from "zod";`)
- Modify: `workers/template-mcp/src/tools.ts` (four tools)
- Modify: `workers/template-mcp/src/contract.ts` (`how_to_submit` step 7), `docs/template-contract.md` (section 9 step 7), `workers/template-mcp/README.md`
- Modify: `workers/template-mcp/test/helpers.ts` (`resetDb` table list)
- Test: `workers/template-mcp/test/submit.test.ts`, `workers/template-mcp/test/mcp.test.ts`

**Interfaces:**
- Consumes: Task 5 `submitTemplate`, `limitRejection`; Task 4 `assembleZip`; `InputError`, `LIMITS`, `safePath`.
- Produces:
  - Tables `template_uploads (upload_id PK, key_id, template_id, template_name, created_at)` and `template_upload_chunks (upload_id, path, part, encoding, content)`, primary key `(upload_id, path, part)`.
  - `SUBMITTED_FILE`, `type SubmittedFile = z.input<typeof SUBMITTED_FILE>` (`{ path; content; encoding?: "utf8" | "base64" }`), `SUBMIT_SHAPE = { template_id, template_name, files }`
  - `filesToMap(files: readonly SubmittedFile[]): FileMap`; `payloadStats(files: FileMap): { files: number; bytes: number; largest_file: { path: string; bytes: number } | null }`
  - `UPLOAD_CHUNK` (`SUBMITTED_FILE` plus `part?: number`), `type UploadChunk = z.input<typeof UPLOAD_CHUNK>`
  - Constants `UPLOAD_BATCH_CHARS = 20_000` (what builders are told), `UPLOAD_CALL_MAX_CHARS = 65_536` (server cap per call), `UPLOAD_TTL_MS = 6 h`
  - `beginUpload(env: Pick<Env, "FACTORY">, keyId: string, templateId: string, templateName: string, now?: number): Promise<string>` (returns `up_` + 32 hex)
  - `addUploadChunks(env, keyId, uploadId, chunks: readonly UploadChunk[]): Promise<{ chunks_stored: number; files: number }>` (InputError `batch_too_large`, `unknown_upload`, path errors)
  - `takeUpload(env, keyId, uploadId): Promise<{ template_id: string; template_name: string; files: SubmittedFile[] }>` (InputError `unknown_upload`, `missing_part`, `mixed_encoding`; deletes the upload on success)
  - MCP tools `submit_template { template_id, template_name, files }`, `begin_upload { template_id, template_name }` -> `{ upload_id, batch_chars, next_step }`, `upload_files { upload_id, files: UploadChunk[] }` -> `{ upload_id, chunks_stored, files, next_step }`, `finish_upload { upload_id }` -> `SubmitResult`.

- [ ] **Step 1: Write the failing tests**

In `workers/template-mcp/test/submit.test.ts` change the imports to:

```ts
import { InputError, readZip } from "../src/archive";
import {
  UPLOAD_CALL_MAX_CHARS, addUploadChunks, assembleZip, beginUpload, detectFramework, filesToMap, payloadStats, submitTemplate, takeUpload, type SubmitRequest,
} from "../src/submit";
import { NOW, addBrand, addKey, addSealedTemplate, resetDb, setupDb } from "./helpers";
```

Append:

```ts
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof InputError ? e.code : "other";
  }
  return "none";
};

describe("filesToMap", () => {
  it("decodes utf8 and base64 files and normalizes ./ and leading / paths", () => {
    const files = filesToMap([
      { path: "./index.html", content: "<h1>Hi</h1>" },
      { path: "/assets/logo.png", content: btoa("\x89PNG"), encoding: "base64" },
    ]);
    expect([...files.keys()]).toEqual(["index.html", "assets/logo.png"]);
    expect(new TextDecoder().decode(files.get("index.html"))).toBe("<h1>Hi</h1>");
    expect([...files.get("assets/logo.png")!]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("rejects zip-slip, duplicates, bad base64 and oversized files", () => {
    expect(code(() => filesToMap([{ path: "../evil.html", content: "x" }]))).toBe("zip_slip");
    expect(code(() => filesToMap([{ path: "a.html", content: "x" }, { path: "./a.html", content: "y" }]))).toBe("duplicate_entry");
    expect(code(() => filesToMap([{ path: "a.png", content: "%%%", encoding: "base64" }]))).toBe("bad_base64");
    expect(code(() => filesToMap([{ path: "big.txt", content: "x".repeat(10 * 1024 * 1024 + 1) }]))).toBe("file_too_large");
  });

  it("reports the payload size and the largest file", () => {
    const files = filesToMap([{ path: "a.html", content: "abc" }, { path: "b.css", content: "abcdef" }]);
    expect(payloadStats(files)).toEqual({ files: 2, bytes: 9, largest_file: { path: "b.css", bytes: 6 } });
  });
});

describe("chunked upload", () => {
  beforeAll(setupDb);
  beforeEach(async () => {
    await resetDb();
    await addKey();
  });
  const all = () => [...goodSite()].map(([path, bytes]) => ({ path, content: new TextDecoder().decode(bytes), encoding: "utf8" as const }));

  it("joins split files and batches into the same archive as one submit_template call", async () => {
    const files = all();
    const index = files.find((f) => f.path === "index.html")!;
    const id = await beginUpload(env, "bk_test", "harbor", "Harbor");
    expect(id).toMatch(/^up_[0-9a-f]{32}$/);
    const half = Math.floor(index.content.length / 2);
    await addUploadChunks(env, "bk_test", id, [{ path: "index.html", content: index.content.slice(0, half), part: 0 }]);
    const stored = await addUploadChunks(env, "bk_test", id, [{ path: "index.html", content: index.content.slice(half), part: 1 }, ...files.filter((f) => f !== index)]);
    expect(stored).toEqual({ chunks_stored: files.length + 1, files: files.length });
    const upload = await takeUpload(env, "bk_test", id);
    expect(upload).toMatchObject({ template_id: "harbor", template_name: "Harbor" });
    expect(assembleZip(filesToMap(upload.files))).toEqual(assembleZip(filesToMap(files)));
    await expect(takeUpload(env, "bk_test", id)).rejects.toMatchObject({ code: "unknown_upload" });
  });

  it("refuses an oversized call, another key's upload and a missing part", async () => {
    const id = await beginUpload(env, "bk_test", "harbor", "Harbor");
    await expect(addUploadChunks(env, "bk_test", id, [{ path: "a.html", content: "x".repeat(UPLOAD_CALL_MAX_CHARS + 1) }])).rejects.toMatchObject({ code: "batch_too_large" });
    await addKey("anj_mcp_second-key-0123456789abcd", "other", "bk_other");
    await expect(addUploadChunks(env, "bk_other", id, [{ path: "a.html", content: "x" }])).rejects.toMatchObject({ code: "unknown_upload" });
    await addUploadChunks(env, "bk_test", id, [{ path: "a.html", content: "x", part: 1 }]);
    await expect(takeUpload(env, "bk_test", id)).rejects.toMatchObject({ code: "missing_part" });
  });

  it("prunes uploads older than six hours", async () => {
    const old = await beginUpload(env, "bk_test", "harbor", "Harbor", Date.parse("2026-10-17T00:00:00Z"));
    await addUploadChunks(env, "bk_test", old, [{ path: "a.html", content: "x" }]);
    await beginUpload(env, "bk_test", "harbor", "Harbor", Date.parse("2026-10-17T07:00:00Z"));
    await expect(takeUpload(env, "bk_test", old)).rejects.toMatchObject({ code: "unknown_upload" });
    expect((await env.FACTORY.prepare("SELECT count(*) AS n FROM template_upload_chunks").first<{ n: number }>())!.n).toBe(0);
  });
});
```

In `workers/template-mcp/test/mcp.test.ts`, in the tool list test add:

```ts
    for (const tool of ["submit_template", "begin_upload", "upload_files", "finish_upload"]) expect(names).toContain(tool);
```

and add inside `describe("tools over streamable HTTP", ...)`:

```ts
  const distFiles = () => [...goodSite()].map(([path, bytes]) => ({ path, content: new TextDecoder().decode(bytes), encoding: "utf8" }));
  const storedBy = () => env.FACTORY.prepare("SELECT submitted_by_key_id FROM template_versions WHERE template_version_id = 'tv_harbor_v1'").first();

  it("submit_template: one call with every dist/ file", async () => {
    const client = await connect();
    const { data } = await callTool(client, "submit_template", { template_id: "harbor", template_name: "Harbor", files: distFiles() });
    expect(data).toMatchObject({ status: "rejected", template_version_id: "tv_harbor_v1" }); // no BROWSER binding in this pool
    expect(await storedBy()).toEqual({ submitted_by_key_id: "bk_test" });
    await client.close();
  });

  it("begin_upload, upload_files and finish_upload submit a site in batches", async () => {
    const client = await connect();
    const files = distFiles();
    const begun = await callTool(client, "begin_upload", { template_id: "harbor", template_name: "Harbor" });
    const upload_id = begun.data.upload_id as string;
    expect(begun.data.batch_chars).toBe(20_000);
    expect((await callTool(client, "upload_files", { upload_id, files: files.slice(0, 3) })).data).toMatchObject({ chunks_stored: 3, files: 3 });
    expect((await callTool(client, "upload_files", { upload_id, files: files.slice(3) })).data).toMatchObject({ files: files.length });
    const done = await callTool(client, "finish_upload", { upload_id });
    expect(done.data).toMatchObject({ status: "rejected", template_version_id: "tv_harbor_v1" });
    expect(await storedBy()).toEqual({ submitted_by_key_id: "bk_test" });
    await client.close();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd workers/template-mcp && bun run test -- test/submit.test.ts test/mcp.test.ts`
Expected: FAIL: `filesToMap is not a function`, `beginUpload is not a function`, and the tool list lacks `submit_template`.

- [ ] **Step 3: Implement**

Create `packages/factory-db/migrations/0006_template_uploads.sql`:

```sql
-- Migration 0006: chunked builder uploads (template MCP begin_upload / upload_files / finish_upload).
--
-- For builders that cannot publish a site and cannot pass dist/ in one tool call. An upload belongs to
-- one builder key; finish_upload joins the chunks, submits them and deletes both rows. Uploads older than
-- six hours are pruned. Rows hold template files, never lead data.

CREATE TABLE IF NOT EXISTS template_uploads (
  upload_id     TEXT PRIMARY KEY,
  key_id        TEXT NOT NULL REFERENCES builder_keys(key_id),
  template_id   TEXT NOT NULL,
  template_name TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_template_uploads_created ON template_uploads(created_at);

CREATE TABLE IF NOT EXISTS template_upload_chunks (
  upload_id TEXT NOT NULL REFERENCES template_uploads(upload_id),
  path      TEXT NOT NULL,
  part      INTEGER NOT NULL CHECK (part BETWEEN 0 AND 9999),
  encoding  TEXT NOT NULL CHECK (encoding IN ('utf8', 'base64')),
  content   TEXT NOT NULL,
  PRIMARY KEY (upload_id, path, part)
);
```

In `packages/factory-db/src/index.ts` add `"0006_template_uploads.sql",` after `"0005_template_submissions.sql",`.

In `workers/template-mcp/test/helpers.ts`, put `"template_upload_chunks", "template_uploads",` first in the `resetDb` table list (they reference `builder_keys`).

In `workers/template-mcp/src/submit.ts` add `import { z } from "zod";`, change the archive import to `import { InputError, LIMITS, readZip, safePath, type FileMap } from "./archive";`, and append:

```ts
// ── File list (submit_template) and chunked upload (fallback path) ─────────────

export const SUBMITTED_FILE = z.object({
  path: z.string().min(1).max(512).describe("Path inside dist/, e.g. index.html, privacy/index.html, assets/site.css."),
  content: z.string().describe("The file content: plain text when encoding is utf8, base64 when encoding is base64."),
  encoding: z.enum(["utf8", "base64"]).default("utf8").describe("utf8 for HTML, CSS, JS, SVG and JSON; base64 for images and fonts."),
});
export type SubmittedFile = z.input<typeof SUBMITTED_FILE>;

export const SUBMIT_SHAPE = {
  template_id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "Use 2-63 lowercase letters, digits or dashes, e.g. harbor-funding")
    .describe("Lowercase slug for this template. Send the same template_id again to add a new version."),
  template_name: z.string().trim().min(1).max(128).describe("Template name shown in the dashboard."),
  files: z.array(SUBMITTED_FILE).min(1).max(LIMITS.maxFiles).describe("Every file inside dist/ after npm run build."),
};

function fromBase64(path: string, value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value.replace(/\s+/g, ""));
  } catch {
    throw new InputError("bad_base64", `${path}: content is not valid base64.`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const cleanPath = (raw: string) => safePath(raw.replace(/^\/+/, ""));

/** Same safety rules as a zip entry: no zip-slip, no absolute or backslash paths, no duplicates, per-file and total limits. */
export function filesToMap(files: readonly SubmittedFile[]): FileMap {
  if (files.length > LIMITS.maxFiles) throw new InputError("too_many_files", `${files.length} files; the limit is ${LIMITS.maxFiles}.`);
  const map: FileMap = new Map();
  let total = 0;
  for (const file of files) {
    const path = cleanPath(file.path);
    if (map.has(path)) throw new InputError("duplicate_entry", `The file ${path} is listed twice.`);
    const bytes = (file.encoding ?? "utf8") === "base64" ? fromBase64(path, file.content) : new TextEncoder().encode(file.content);
    if (bytes.length > LIMITS.maxFileBytes) {
      throw new InputError("file_too_large", `${path} is ${(bytes.length / 1048576).toFixed(1)} MB; the per-file limit is 10 MB.`);
    }
    total += bytes.length;
    if (total > LIMITS.maxTotalBytes) throw new InputError("too_large", "The files add up to more than 100 MB.");
    map.set(path, bytes);
  }
  return map;
}

export interface PayloadStats {
  files: number;
  bytes: number;
  largest_file: { path: string; bytes: number } | null;
}

export function payloadStats(files: FileMap): PayloadStats {
  let bytes = 0;
  let largest: PayloadStats["largest_file"] = null;
  for (const [path, content] of files) {
    bytes += content.length;
    if (!largest || content.length > largest.bytes) largest = { path, bytes: content.length };
  }
  return { files: files.size, bytes, largest_file: largest };
}

/** What builders are told per upload_files call (Task 1 measurement); the server accepts up to UPLOAD_CALL_MAX_CHARS. */
export const UPLOAD_BATCH_CHARS = 20_000;
export const UPLOAD_CALL_MAX_CHARS = 65_536;
export const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;

export const UPLOAD_CHUNK = SUBMITTED_FILE.extend({
  part: z.number().int().min(0).max(9999).default(0)
    .describe("0 for a whole file. A larger file is cut into consecutive pieces sent as part 0, 1, 2 ... (base64 may be cut anywhere)."),
});
export type UploadChunk = z.input<typeof UPLOAD_CHUNK>;

async function requireUpload(env: Pick<Env, "FACTORY">, keyId: string, uploadId: string): Promise<{ template_id: string; template_name: string }> {
  const row = await env.FACTORY.prepare("SELECT template_id, template_name FROM template_uploads WHERE upload_id = ?1 AND key_id = ?2")
    .bind(uploadId, keyId)
    .first<{ template_id: string; template_name: string }>();
  if (!row) throw new InputError("unknown_upload", "Unknown or expired upload_id. Call begin_upload again and resend the files.");
  return row;
}

export async function beginUpload(env: Pick<Env, "FACTORY">, keyId: string, templateId: string, templateName: string, now = Date.now()): Promise<string> {
  const stale = new Date(now - UPLOAD_TTL_MS).toISOString();
  const uploadId = `up_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.FACTORY.batch([
    env.FACTORY.prepare("DELETE FROM template_upload_chunks WHERE upload_id IN (SELECT upload_id FROM template_uploads WHERE created_at < ?1)").bind(stale),
    env.FACTORY.prepare("DELETE FROM template_uploads WHERE created_at < ?1").bind(stale),
    env.FACTORY.prepare("INSERT INTO template_uploads (upload_id, key_id, template_id, template_name, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(uploadId, keyId, templateId, templateName, new Date(now).toISOString()),
  ]);
  return uploadId;
}

export async function addUploadChunks(env: Pick<Env, "FACTORY">, keyId: string, uploadId: string, chunks: readonly UploadChunk[]): Promise<{ chunks_stored: number; files: number }> {
  const chars = chunks.reduce((n, chunk) => n + chunk.content.length, 0);
  if (chars > UPLOAD_CALL_MAX_CHARS) {
    throw new InputError("batch_too_large", `This call carries ${chars} characters of content; send at most ${UPLOAD_BATCH_CHARS} per upload_files call.`);
  }
  await requireUpload(env, keyId, uploadId);
  const statements = chunks.map((chunk) =>
    env.FACTORY.prepare("INSERT OR REPLACE INTO template_upload_chunks (upload_id, path, part, encoding, content) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(uploadId, cleanPath(chunk.path), chunk.part ?? 0, chunk.encoding ?? "utf8", chunk.content));
  const results = await env.FACTORY.batch([
    ...statements,
    env.FACTORY.prepare("SELECT count(*) AS chunks, count(DISTINCT path) AS files FROM template_upload_chunks WHERE upload_id = ?1").bind(uploadId),
  ]);
  const counts = results[results.length - 1]!.results[0] as { chunks: number; files: number };
  return { chunks_stored: counts.chunks, files: counts.files };
}

export async function takeUpload(env: Pick<Env, "FACTORY">, keyId: string, uploadId: string): Promise<{ template_id: string; template_name: string; files: SubmittedFile[] }> {
  const upload = await requireUpload(env, keyId, uploadId);
  const { results } = await env.FACTORY.prepare("SELECT path, part, encoding, content FROM template_upload_chunks WHERE upload_id = ?1 ORDER BY path, part")
    .bind(uploadId)
    .all<{ path: string; part: number; encoding: "utf8" | "base64"; content: string }>();
  const files = new Map<string, { encoding: "utf8" | "base64"; parts: string[] }>();
  for (const row of results) {
    const file = files.get(row.path) ?? { encoding: row.encoding, parts: [] };
    if (row.part !== file.parts.length) {
      throw new InputError("missing_part", `${row.path} is missing part ${file.parts.length}. Send it with upload_files, then call finish_upload again.`);
    }
    if (row.encoding !== file.encoding) throw new InputError("mixed_encoding", `${row.path} mixes utf8 and base64 parts; send every part with the same encoding.`);
    file.parts.push(row.content);
    files.set(row.path, file);
  }
  await env.FACTORY.batch([
    env.FACTORY.prepare("DELETE FROM template_upload_chunks WHERE upload_id = ?1").bind(uploadId),
    env.FACTORY.prepare("DELETE FROM template_uploads WHERE upload_id = ?1").bind(uploadId),
  ]);
  return { ...upload, files: [...files].map(([path, file]) => ({ path, encoding: file.encoding, content: file.parts.join("") })) };
}
```

In `workers/template-mcp/src/tools.ts` extend the `./submit` import to:

```ts
import {
  SUBMIT_SHAPE, UPLOAD_BATCH_CHARS, UPLOAD_CHUNK, addUploadChunks, beginUpload, filesToMap, limitRejection, payloadStats,
  submitTemplate, submitTemplateUrl, takeUpload, type SubmittedFile,
} from "./submit";
```

and add after `submit_template_url`:

```ts
  /** Shared by submit_template and finish_upload: decode, log the size, run the pipeline. */
  const submitFiles = async (templateId: string, templateName: string, submitted: SubmittedFile[], via: string) => {
    if (!builder) return text({ error: "unauthorized", message: "This session has no builder key." }, true);
    let files: FileMap;
    try {
      files = filesToMap(submitted);
    } catch (error) {
      const rejected = limitRejection(error);
      if (rejected) return text(rejected);
      throw error;
    }
    console.log(JSON.stringify({ event: "submit_template_payload", via, template_id: templateId, key_id: builder.keyId, ...payloadStats(files) }));
    return text(await submitTemplate(env, {
      template_id: templateId, template_name: templateName, files,
      submitted_by: { key_id: builder.keyId, label: builder.label }, created_by: builder.keyId,
    }));
  };
  const UPLOAD_ID = z.string().regex(/^up_[0-9a-f]{32}$/).describe("The upload_id from begin_upload.");

  server.registerTool(
    "submit_template",
    {
      title: "Submit a small template as files in one call",
      description:
        "For builders that can pass the whole dist/ in one tool argument (a small build). bolt.new cannot: use submit_template_url, " +
        "or begin_upload / upload_files / finish_upload. Same result as submit_template_url.",
      inputSchema: SUBMIT_SHAPE,
    },
    async (args) => {
      try {
        return await submitFiles(args.template_id, args.template_name, args.files, "submit_template");
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "begin_upload",
    {
      title: "Start a chunked file upload",
      description: `Fallback when the site cannot be published: returns upload_id. Then call upload_files with at most ${UPLOAD_BATCH_CHARS} characters of file content per call, and finish_upload when every file is sent.`,
      inputSchema: { template_id: SUBMIT_SHAPE.template_id, template_name: SUBMIT_SHAPE.template_name },
    },
    async (args) => {
      try {
        if (!builder) return text({ error: "unauthorized", message: "This session has no builder key." }, true);
        const upload_id = await beginUpload(env, builder.keyId, args.template_id, args.template_name);
        return text({ upload_id, batch_chars: UPLOAD_BATCH_CHARS, next_step: `Call upload_files with upload_id and files totalling at most ${UPLOAD_BATCH_CHARS} characters of content per call.` });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "upload_files",
    {
      title: "Send one batch of files",
      description:
        `Send part of dist/: at most ${UPLOAD_BATCH_CHARS} characters of content per call, as { path, content, encoding, part }. ` +
        "Cut a larger file into consecutive pieces and send them as part 0, 1, 2 ... with the same path and encoding.",
      inputSchema: { upload_id: UPLOAD_ID, files: z.array(UPLOAD_CHUNK).min(1).max(200) },
    },
    async (args) => {
      try {
        if (!builder) return text({ error: "unauthorized", message: "This session has no builder key." }, true);
        const stored = await addUploadChunks(env, builder.keyId, args.upload_id, args.files);
        return text({ upload_id: args.upload_id, ...stored, next_step: "Send the next batch, or call finish_upload when every file is sent." });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "finish_upload",
    {
      title: "Submit the uploaded files",
      description: "Joins every uploaded file and runs the same pipeline as submit_template_url, with the same result.",
      inputSchema: { upload_id: UPLOAD_ID },
    },
    async (args) => {
      try {
        if (!builder) return text({ error: "unauthorized", message: "This session has no builder key." }, true);
        const upload = await takeUpload(env, builder.keyId, args.upload_id);
        return await submitFiles(upload.template_id, upload.template_name, upload.files, "finish_upload");
      } catch (error) {
        return failure(error);
      }
    },
  );
```

In `workers/template-mcp/src/contract.ts` append to `how_to_submit`:

```ts
      "7. Only if you cannot publish: call begin_upload, then upload_files with every file in dist/ ({ path, content, encoding, part }) using at most 20,000 characters of content per call (cut larger files into parts 0, 1, 2 ...), then finish_upload. Never paste a zip.",
```

Append to section 9 of `docs/template-contract.md`:

```markdown
7. Only if the site cannot be published: call `begin_upload`, then `upload_files` with every file in `dist/` as `{ "path", "content", "encoding", "part" }`, at most 20,000 characters of content per call (cut larger files into parts 0, 1, 2 ...), then `finish_upload`. The result is the same as `submit_template_url`.
```

In `workers/template-mcp/README.md` add to the Tools table:

```markdown
| `submit_template` | `template_id`, `template_name`, `files` (every file in `dist/`) | same result as `submit_template_url`; only for builders that can pass the whole build in one argument |
| `begin_upload` / `upload_files` / `finish_upload` | `template_id`, `template_name`; then `upload_id` + up to 20,000 characters of `files` per call (`part` splits large files); then `upload_id` | `upload_id`; stored counts; then the `submit_template_url` result. Uploads belong to one key and expire after 6 hours |
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/factory-db && bun run test` then `cd workers/template-mcp && bun run test`
Expected: PASS for both.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck` at the repo root. Expected: PASS.

```bash
git add packages/factory-db workers/template-mcp docs/template-contract.md
git commit -F - <<'EOF'
feat(template-mcp): submit_template and chunked begin/upload/finish upload (FUS-345)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 7: Dashboard import service (`TemplateImportService`)

**Files:**
- Create: `workers/template-mcp/src/import-service.ts`
- Modify: `workers/template-mcp/src/index.ts` (export `TemplateImportService`)
- Modify: `docs/template-contract.md` (section 9 note)
- Test: `workers/template-mcp/test/import-service.test.ts` (create)

**Interfaces:**
- Consumes: Task 5 `submitTemplateUrl`; the `serve` test helper in `test/fixtures.ts` (Task 5).
- Produces:
  - `handleImportRequest(request: Request, env: Env): Promise<Response>` for `POST /submit-url` with body `{ url, template_id, template_name, submitted_by: { key_id: null, label }, created_by }`; 200 with a `SubmitResult`, 422 `{ error, message | issues }`, 404 for other paths.
  - Named entrypoint `TemplateImportService` (service binding target for `apps/web`, Task 9).

- [ ] **Step 1: Write the failing test**

Create `workers/template-mcp/test/import-service.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleImportRequest } from "../src/import-service";
import { goodSite, serve } from "./fixtures";
import { resetDb, setupDb } from "./helpers";

vi.mock("../src/screenshots", () => ({ takeScreenshot: vi.fn() }));
import { takeScreenshot } from "../src/screenshots";

const browserEnv = { ...env, BROWSER: {} as Fetcher };
const post = (body: unknown) => handleImportRequest(
  new Request("https://template-mcp/submit-url", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  browserEnv,
);

beforeAll(setupDb);
beforeEach(async () => {
  await resetDb();
  vi.mocked(takeScreenshot).mockReset().mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
});
afterEach(() => vi.unstubAllGlobals());

describe("TemplateImportService", () => {
  it("submits a published URL for a dashboard user and records them as submitter", async () => {
    serve(goodSite());
    const ok = await post({ url: "https://harbor.bolt.host/", template_id: "harbor", template_name: "Harbor", submitted_by: { key_id: null, label: "owner@example.test" }, created_by: "usr_1" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "awaiting_approval" });
    expect(await env.FACTORY.prepare("SELECT submitted_by_key_id, submitted_by_label, created_by FROM template_versions").first())
      .toEqual({ submitted_by_key_id: null, submitted_by_label: "owner@example.test", created_by: "usr_1" });
  });

  it("validates input and answers 404 for other paths", async () => {
    const insecure = await post({ url: "http://harbor.bolt.host/", template_id: "harbor", template_name: "Harbor", submitted_by: { key_id: null, label: "x" }, created_by: "u" });
    expect([insecure.status, ((await insecure.json()) as { error: string }).error]).toEqual([422, "bad_url"]);
    expect((await post({ template_id: "harbor" })).status).toBe(422);
    expect((await handleImportRequest(new Request("https://template-mcp/other"), browserEnv)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd workers/template-mcp && bun run test -- test/import-service.test.ts`
Expected: FAIL: "Failed to load url ../src/import-service".

- [ ] **Step 3: Implement**

Create `workers/template-mcp/src/import-service.ts`:

```ts
/**
 * Dashboard "Import from URL": POST /submit-url behind the TemplateImportService entrypoint. Only the
 * anjuna-web service binding reaches it; the public fetch handler never routes here.
 */
import { z } from "zod";
import { InputError } from "./archive";
import type { Env } from "./env";
import { submitTemplateUrl } from "./submit";

const ImportRequest = z.strictObject({
  url: z.string().url(),
  template_id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  template_name: z.string().trim().min(1).max(128),
  submitted_by: z.strictObject({ key_id: z.null(), label: z.string().min(1).max(254) }),
  created_by: z.string().min(1).max(128),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function handleImportRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/submit-url") return json({ error: "not_found" }, 404);
  const parsed = ImportRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return json({ error: "invalid", issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) }, 422);
  }
  try {
    return json(await submitTemplateUrl(env, parsed.data));
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.code, message: error.message }, 422);
    console.error("template import failed", error instanceof Error ? error.message : String(error));
    return json({ error: "internal" }, 500);
  }
}
```

In `workers/template-mcp/src/index.ts` add:

```ts
import { WorkerEntrypoint } from "cloudflare:workers";
import { handleImportRequest } from "./import-service";
```

```ts
/** Dashboard "Import from URL". A named entrypoint is reachable only through a service binding (anjuna-web TEMPLATE_MCP). */
export class TemplateImportService extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> {
    return handleImportRequest(request, this.env);
  }
}
```

In `docs/template-contract.md`, append to section 9:

```markdown
The owner and employees can paste the same published URL into "Import from URL" on the dashboard's Templates screen. It runs the same pipeline.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd workers/template-mcp && bun run test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck` at the repo root. Expected: PASS.

```bash
git add workers/template-mcp docs/template-contract.md
git commit -F - <<'EOF'
feat(template-mcp): TemplateImportService entrypoint for dashboard import (FUS-345)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 8: Factory `/seal-template` service

**Files:**
- Create: `workers/factory/src/seal.ts`
- Modify: `workers/factory/src/index.ts` (new route before the final 404)
- Test: `workers/factory/test/seal.test.ts` (create)

**Interfaces:**
- Consumes: factory D1 `template_versions`, `certifications`, `audit_log`; R2 `ARTIFACTS`.
- Produces:
  - `interface SealRequest { template_version_id: string; sealed_by: string; sealed_role: string }`
  - `parseSealRequest(input: unknown): SealRequest | null`
  - `type SealResponse = { status: 200; body: { ok: true; template_version_id: string; sealed_by: string; sealed_at: string; already_sealed: boolean } } | { status: 403 | 404 | 409; body: { ok: false; error: "owner_required" | "not_found" | "not_certified" | "missing_evidence" | "certification_changed"; message: string } }`
  - `sealTemplate(env: Pick<Env, "FACTORY" | "ARTIFACTS">, input: SealRequest, now?: string): Promise<SealResponse>`
  - HTTP `POST https://factory/seal-template` with JSON `SealRequest`; 400 `{ ok: false, error: "invalid" }` for a bad body; otherwise `SealResponse.status` and `.body`.

- [ ] **Step 1: Write the failing test**

Create `workers/factory/test/seal.test.ts`:

```ts
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import factory from "../src/index";
import type { Env } from "../src/env";

const NOW = "2026-10-17T00:00:00.000Z";
beforeAll(() => applyD1Migrations(env.FACTORY, env.MIGRATIONS));

async function seedVersion(id: string, opts: { status?: string; screenshots?: boolean } = {}) {
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT INTO templates (template_id, name, framework, created_by, created_at) VALUES (?1, ?2, 'react_spa', 'bk_1', ?3)").bind(`t-${id}`, `Template ${id}`, NOW),
    env.FACTORY.prepare("INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, created_by, created_at) VALUES (?1, ?2, 1, ?3, 'k', ?4, 'bk_1', ?5)")
      .bind(id, `t-${id}`, id.padEnd(64, "0"), opts.status ?? "certified", NOW),
    ...["lint", "identity_scan"].map((check) =>
      env.FACTORY.prepare("INSERT INTO certifications (template_version_id, check_name, result, details_json, created_at) VALUES (?1, ?2, 'pass', '{}', ?3)").bind(id, check, NOW)),
  ]);
  for (const viewport of ["screenshot_desktop", "screenshot_mobile"]) {
    const key = `screenshots/${id}/run/${viewport}.png`;
    if (opts.screenshots !== false) await env.ARTIFACTS.put(key, new Uint8Array([137, 80, 78, 71]), { httpMetadata: { contentType: "image/png" } });
    await env.FACTORY.prepare("INSERT INTO certifications (template_version_id, check_name, result, details_json, artifact_r2_key, created_at) VALUES (?1, ?2, 'pass', '{}', ?3, ?4)").bind(id, viewport, key, NOW).run();
  }
}

const seal = (body: unknown) => factory.fetch(
  new Request("https://factory/seal-template", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  env as unknown as Env,
);
const status = async (id: string) => (await env.FACTORY.prepare("SELECT status, sealed_by FROM template_versions WHERE template_version_id = ?1").bind(id).first());
const sealAudits = async (id: string) => (await env.FACTORY.prepare("SELECT actor_id, actor_role FROM audit_log WHERE action = 'template.seal' AND entity_id = ?1").bind(id).all()).results;

describe("POST /seal-template", () => {
  it("seals a certified version with the owner's user id, once", async () => {
    await seedVersion("tv-a");
    const first = await seal({ template_version_id: "tv-a", sealed_by: "usr_owner", sealed_role: "owner" });
    expect(first.status).toBe(200);
    const body = await first.json() as { sealed_at: string };
    expect(body).toMatchObject({ ok: true, template_version_id: "tv-a", sealed_by: "usr_owner", already_sealed: false });
    expect(await status("tv-a")).toEqual({ status: "sealed", sealed_by: "usr_owner" });
    const again = await seal({ template_version_id: "tv-a", sealed_by: "usr_other_owner", sealed_role: "owner" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, template_version_id: "tv-a", sealed_by: "usr_owner", sealed_at: body.sealed_at, already_sealed: true });
    expect(await sealAudits("tv-a")).toEqual([{ actor_id: "usr_owner", actor_role: "owner" }]);
  });

  it("refuses an employee and changes nothing", async () => {
    await seedVersion("tv-b");
    const response = await seal({ template_version_id: "tv-b", sealed_by: "usr_emp", sealed_role: "employee" });
    expect([response.status, ((await response.json()) as { error: string }).error]).toEqual([403, "owner_required"]);
    expect(await status("tv-b")).toEqual({ status: "certified", sealed_by: null });
  });

  it("refuses a version that is not certified or lacks screenshot evidence", async () => {
    await seedVersion("tv-c", { status: "rejected" });
    const rejected = await seal({ template_version_id: "tv-c", sealed_by: "usr_owner", sealed_role: "owner" });
    expect([rejected.status, ((await rejected.json()) as { error: string }).error]).toEqual([409, "not_certified"]);
    await seedVersion("tv-d", { screenshots: false });
    const missing = await seal({ template_version_id: "tv-d", sealed_by: "usr_owner", sealed_role: "owner" });
    expect([missing.status, ((await missing.json()) as { error: string }).error]).toEqual([409, "missing_evidence"]);
    expect(await status("tv-d")).toEqual({ status: "certified", sealed_by: null });
  });

  it("answers 404 for an unknown version and 400 for a bad body", async () => {
    expect((await seal({ template_version_id: "tv-none", sealed_by: "usr_owner", sealed_role: "owner" })).status).toBe(404);
    expect((await seal({ template_version_id: "tv-none" })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd workers/factory && bun run test -- test/seal.test.ts`
Expected: FAIL: every request returns 404 "Not Found".

- [ ] **Step 3: Implement**

Create `workers/factory/src/seal.ts`:

```ts
/**
 * Owner approval from the control panel: seal a certified template version. The caller (anjuna-web)
 * has already checked the session role; the factory checks it again and records the owner's user id.
 * A second call for a sealed version returns the stored seal and changes nothing.
 */
import type { Env } from "./env.js";

const VIEWPORTS = ["screenshot_desktop", "screenshot_mobile"] as const;

export interface SealRequest {
  template_version_id: string;
  sealed_by: string;
  sealed_role: string;
}

type SealError = "owner_required" | "not_found" | "not_certified" | "missing_evidence" | "certification_changed";
export type SealResponse =
  | { status: 200; body: { ok: true; template_version_id: string; sealed_by: string; sealed_at: string; already_sealed: boolean } }
  | { status: 403 | 404 | 409; body: { ok: false; error: SealError; message: string } };

export function parseSealRequest(input: unknown): SealRequest | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const valid = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;
  if (!valid(record.template_version_id) || !valid(record.sealed_by) || !valid(record.sealed_role)) return null;
  return { template_version_id: record.template_version_id, sealed_by: record.sealed_by, sealed_role: record.sealed_role };
}

const fail = (status: 403 | 404 | 409, error: SealError, message: string): SealResponse => ({ status, body: { ok: false, error, message } });

interface VersionRow { status: string; sealed_by: string | null; sealed_at: string | null }

export async function sealTemplate(env: Pick<Env, "FACTORY" | "ARTIFACTS">, input: SealRequest, now = new Date().toISOString()): Promise<SealResponse> {
  if (input.sealed_role !== "owner") return fail(403, "owner_required", "Only an owner can approve a template.");
  const db = env.FACTORY;
  const id = input.template_version_id;
  const read = () => db.prepare("SELECT status, sealed_by, sealed_at FROM template_versions WHERE template_version_id = ?1").bind(id).first<VersionRow>();
  const sealed = (row: VersionRow): SealResponse => ({
    status: 200,
    body: { ok: true, template_version_id: id, sealed_by: row.sealed_by ?? "", sealed_at: row.sealed_at ?? "", already_sealed: true },
  });

  const row = await read();
  if (!row) return fail(404, "not_found", `Template version ${id} does not exist.`);
  if (row.status === "sealed") return sealed(row);
  if (row.status !== "certified") return fail(409, "not_certified", `The version is ${row.status}; only a version that passed every check can be approved.`);

  // Only the latest result per check counts; an old pass cannot hide a failed re-run.
  const { results } = await db.prepare(`SELECT id, check_name, result, artifact_r2_key FROM certifications
    WHERE id IN (SELECT MAX(id) FROM certifications WHERE template_version_id = ?1 GROUP BY check_name)`)
    .bind(id).all<{ id: number; check_name: string; result: string; artifact_r2_key: string | null }>();
  for (const viewport of VIEWPORTS) {
    const check = results.find((r) => r.check_name === viewport);
    const artifact = check?.result === "pass" && check.artifact_r2_key ? await env.ARTIFACTS.head(check.artifact_r2_key) : null;
    if (!artifact || artifact.size === 0 || artifact.httpMetadata?.contentType !== "image/png") {
      return fail(409, "missing_evidence", `The ${viewport.replace("screenshot_", "")} screenshot is missing. Submit the template again to re-run the checks.`);
    }
  }

  const latest = Math.max(...results.map((r) => r.id));
  const [update] = await db.batch([
    db.prepare(`UPDATE template_versions SET status = 'sealed', sealed_by = ?2, sealed_at = ?3
      WHERE template_version_id = ?1 AND status = 'certified'
      AND (SELECT MAX(id) FROM certifications WHERE template_version_id = ?1) = ?4`)
      .bind(id, input.sealed_by, now, latest),
    db.prepare(`INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
      SELECT ?1, 'owner', 'template.seal', 'template_version', ?2, ?3, ?4, ?5 WHERE changes() > 0`)
      .bind(input.sealed_by, id, JSON.stringify({ status: "certified" }), JSON.stringify({ status: "sealed", sealed_by: input.sealed_by, sealed_at: now }), now),
  ]);
  if (update?.meta.changes) {
    return { status: 200, body: { ok: true, template_version_id: id, sealed_by: input.sealed_by, sealed_at: now, already_sealed: false } };
  }
  const after = await read();
  if (after?.status === "sealed") return sealed(after);
  return fail(409, "certification_changed", "The checks changed while approving. Reload the template and try again.");
}
```

In `workers/factory/src/index.ts` add `import { parseSealRequest, sealTemplate } from "./seal.js";` and, before `return new Response("Not Found", { status: 404 });`:

```ts
    // POST /seal-template  { template_version_id, sealed_by, sealed_role }  (control panel Approve)
    if (url.pathname === "/seal-template") {
      const input = parseSealRequest(await request.json().catch(() => null));
      if (!input) return Response.json({ ok: false, error: "invalid", message: "template_version_id, sealed_by and sealed_role are required" }, { status: 400 });
      const outcome = await sealTemplate(env, input);
      return Response.json(outcome.body, { status: outcome.status });
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd workers/factory && bun run test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck` at the repo root. Expected: PASS.

```bash
git add workers/factory/src/seal.ts workers/factory/src/index.ts workers/factory/test/seal.test.ts
git commit -F - <<'EOF'
feat(factory): seal-template service for owner approval from the panel (FUS-345)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 9: Templates API in the control panel

**Files:**
- Modify: `packages/contracts/src/template-review.ts` (append list, detail, import and approve schemas)
- Create: `apps/web/src/server/templates.ts`
- Modify: `apps/web/src/server/index.ts` (route), `apps/web/src/server/env.ts` (`ARTIFACTS`, `TEMPLATE_MCP`), `apps/web/src/server/panel-roles.ts` (four actions)
- Modify: `apps/web/wrangler.jsonc`, `apps/web/wrangler.deploy.aduplift.jsonc`, `apps/web/wrangler.deploy.maimax.jsonc` (R2 binding, service binding)
- Modify: `apps/web/vitest.config.ts` (`r2Buckets`), `apps/web/test/env.d.ts`, `apps/web/test/helpers.ts` (`makeEnv`), `apps/web/test/build.node.test.ts`
- Test: `apps/web/test/templates-api.test.ts` (create)

**Interfaces:**
- Consumes: Task 3 `TEMPLATE_VERSION_REVIEW_STATUS`, `TemplateReviewStatus`, `TemplateSubmitResult`, `TemplateTextDefaults`, `templateSlug`; Task 7 `POST https://template-mcp/submit-url`; Task 8 `POST https://factory/seal-template`; existing `authorizePanel`, `decodePathSegment`.
- Produces:
  - Contracts: `TemplateVersionSummary`, `TemplateListResponse`, `TemplateCheckResult`, `TemplateDetailResponse`, `TemplateImportRequest` (`{ url: string; template_name: string }`), `TemplateApproveResponse` (`{ ok: true; template_version_id; sealed_by; sealed_at; already_sealed: boolean }`) and their types.
  - `handleTemplateRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext, email: string): Promise<Response | undefined>` serving:
    - `GET /api/templates` (employee+) -> `TemplateListResponse`
    - `GET /api/templates/:id` (employee+) -> `TemplateDetailResponse`
    - `GET /api/templates/:id/screenshots/(desktop|mobile)` (employee+) -> `image/png`
    - `POST /api/templates/:id/approve` (owner) -> `TemplateApproveResponse`; employee 403 `{ error: "forbidden_role", required_role: "owner" }`
    - `POST /api/templates/import` (employee+) body `TemplateImportRequest` -> `TemplateSubmitResult`
  - `PANEL_ROLE_TABLE` gains `listTemplates: "employee"`, `importTemplate: "employee"`, `approveTemplate: "owner"`, `manageBuilderKeys: "owner"`.
  - `Env.ARTIFACTS?: R2Bucket`, `Env.TEMPLATE_MCP?: Fetcher`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/templates-api.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TemplateDetailResponse, TemplateListResponse } from "@anjuna/contracts";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

const NOW = "2026-10-17T00:00:00.000Z";
const SHOT = "screenshots/tv-bolt-1/r/screenshot_desktop.png";
const DEFAULTS = { brand_name: "Harbor", title: "Harbor | Funding Options", description: "Check your funding options." };
let owner: string;
let employee: string;

beforeAll(setupDatabases);
beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id, name, framework, created_by, created_at) VALUES ('tpl-bolt', 'Bolt Harbor', 'react_spa', 'bk_1', ?1)").bind(NOW),
    env.FACTORY.prepare(`INSERT OR IGNORE INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, created_by, created_at, text_defaults_json, submitted_by_key_id, submitted_by_label)
      VALUES ('tv-bolt-1', 'tpl-bolt', 1, ?1, 'templates/tpl-bolt/a.zip', 'certified', 'bk_1', ?2, ?3, 'bk_1', 'Somchai (bolt.new)')`).bind("a".repeat(64), NOW, JSON.stringify(DEFAULTS)),
    env.FACTORY.prepare(`INSERT INTO certifications (template_version_id, check_name, result, details_json, artifact_r2_key, created_at)
      SELECT * FROM (VALUES
        ('tv-bolt-1', 'lint', 'pass', '{}', NULL, ?1),
        ('tv-bolt-1', 'identity_scan', 'pass', '{"similarity":{"summary":"PASS: no sealed templates to compare against yet."}}', NULL, ?1),
        ('tv-bolt-1', 'screenshot_desktop', 'pass', '{}', ?2, ?1),
        ('tv-bolt-1', 'screenshot_mobile', 'fail', '{"error":"timeout"}', NULL, ?1))
      WHERE NOT EXISTS (SELECT 1 FROM certifications WHERE template_version_id = 'tv-bolt-1')`).bind(NOW, SHOT),
  ]);
  await env.ARTIFACTS.put(SHOT, new Uint8Array([137, 80, 78, 71]), { httpMetadata: { contentType: "image/png" } });
});

const me = async (cookie: string) => ((await (await call("/api/me", { cookie })).json()) as { user: { id: string } }).user.id;

describe("templates API", () => {
  it("lists every version with its review status for owner and employee", async () => {
    expect((await call("/api/templates")).status).toBe(401);
    for (const cookie of [owner, employee]) {
      const response = await call("/api/templates", { cookie });
      expect(response.status).toBe(200);
      const { templates } = TemplateListResponse.parse(await response.json());
      expect(templates.find((t) => t.template_version_id === "tv-bolt-1")).toEqual({
        template_version_id: "tv-bolt-1", template_id: "tpl-bolt", name: "Bolt Harbor", version: 1, status: "awaiting_approval",
        submitted_by_label: "Somchai (bolt.new)", created_at: NOW, sealed_at: null,
      });
    }
  });

  it("returns the detail with checks, screenshots and text defaults, and serves the screenshot", async () => {
    const detail = TemplateDetailResponse.parse(await (await call("/api/templates/tv-bolt-1", { cookie: employee })).json());
    expect(detail.template).toMatchObject({ sha256: "a".repeat(64), text_defaults: DEFAULTS, sealed_by: null });
    expect(detail.checks.map((c) => [c.check_name, c.result])).toEqual([
      ["identity_scan", "pass"], ["lint", "pass"], ["screenshot_desktop", "pass"], ["screenshot_mobile", "fail"],
    ]);
    expect(detail.screenshots).toEqual({ desktop: "/api/templates/tv-bolt-1/screenshots/desktop", mobile: null });
    const shot = await call("/api/templates/tv-bolt-1/screenshots/desktop", { cookie: employee });
    expect(shot.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await shot.arrayBuffer())]).toEqual([137, 80, 78, 71]);
    expect((await call("/api/templates/tv-bolt-1/screenshots/mobile", { cookie: employee })).status).toBe(404);
    expect((await call("/api/templates/tv-missing", { cookie: employee })).status).toBe(404);
  });

  it("lets only an owner approve, through the factory with the owner's user id", async () => {
    const dispatched: Array<Record<string, string>> = [];
    const FACTORY_WORKER = { fetch: async (req: Request) => {
      const body = await req.json() as Record<string, string>;
      dispatched.push({ url: req.url, ...body });
      return Response.json({ ok: true, template_version_id: body.template_version_id, sealed_by: body.sealed_by, sealed_at: NOW, already_sealed: dispatched.length > 1 });
    } } as unknown as Fetcher;
    const testEnv = makeEnv({ FACTORY_WORKER });
    const denied = await call("/api/templates/tv-bolt-1/approve", { cookie: employee, method: "POST", body: {}, env: testEnv });
    expect([denied.status, await denied.json()]).toEqual([403, { error: "forbidden_role", required_role: "owner" }]);
    expect(dispatched).toHaveLength(0);
    const approved = await call("/api/templates/tv-bolt-1/approve", { cookie: owner, method: "POST", body: {}, env: testEnv });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ ok: true, already_sealed: false });
    expect(dispatched[0]).toEqual({ url: "https://factory/seal-template", template_version_id: "tv-bolt-1", sealed_by: await me(owner), sealed_role: "owner" });
    const again = await call("/api/templates/tv-bolt-1/approve", { cookie: owner, method: "POST", body: {}, env: testEnv });
    expect(await again.json()).toMatchObject({ ok: true, already_sealed: true });
  });

  it("passes a factory refusal through and reports a missing binding", async () => {
    const FACTORY_WORKER = { fetch: async () => Response.json({ ok: false, error: "not_certified", message: "The version is rejected." }, { status: 409 }) } as unknown as Fetcher;
    const refused = await call("/api/templates/tv-bolt-1/approve", { cookie: owner, method: "POST", body: {}, env: makeEnv({ FACTORY_WORKER }) });
    expect([refused.status, await refused.json()]).toEqual([409, { ok: false, error: "not_certified", message: "The version is rejected." }]);
    expect((await call("/api/templates/tv-bolt-1/approve", { cookie: owner, method: "POST", body: {} })).status).toBe(502);
  });

  it("imports from a URL through the template MCP with the user's email as submitter", async () => {
    const sent: unknown[] = [];
    const TEMPLATE_MCP = { fetch: async (req: Request) => {
      sent.push({ url: req.url, body: await req.json() });
      return Response.json({ status: "awaiting_approval", template_version_id: "tv_bolt-harbor-2_v1", version: 1, sha256: "b".repeat(64), dashboard_url: null, issues: [], warnings: [], text_defaults: null, similarity: null, next_step: "Submitted." });
    } } as unknown as Fetcher;
    const testEnv = makeEnv({ TEMPLATE_MCP });
    const response = await call("/api/templates/import", { cookie: employee, method: "POST", body: { url: "https://harbor.example.com/", template_name: "Bolt Harbor 2" }, env: testEnv });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "awaiting_approval" });
    expect(sent).toEqual([{ url: "https://template-mcp/submit-url", body: {
      url: "https://harbor.example.com/", template_id: "bolt-harbor-2", template_name: "Bolt Harbor 2",
      submitted_by: { key_id: null, label: "emp1@example.test" }, created_by: await me(employee),
    } }]);
    expect((await call("/api/templates/import", { cookie: employee, method: "POST", body: { url: "not a url", template_name: "x" }, env: testEnv })).status).toBe(422);
    expect(sent).toHaveLength(1);
    expect((await call("/api/templates/import", { cookie: employee, method: "POST", body: { url: "https://harbor.example.com/", template_name: "Bolt" } })).status).toBe(502);
  });
});
```

In `apps/web/test/build.node.test.ts` replace the `services` expectation with:

```ts
    expect(wrangler.services).toEqual([
      { binding: "CORE", service: "anjuna-core", entrypoint: "AdminService" },
      { binding: "CORE_LIFECYCLE", service: "anjuna-core", entrypoint: "PanelLifecycleService" },
      { binding: "FACTORY_WORKER", service: "anjuna-factory" },
      { binding: "TEMPLATE_MCP", service: "anjuna-template-mcp", entrypoint: "TemplateImportService" },
    ]);
    expect(wrangler.r2_buckets).toEqual([{ binding: "ARTIFACTS", bucket_name: "anjuna-artifacts" }]);
```

and add after the `DEV_ACCESS_BYPASS` `it.each`:

```ts
it.each(["wrangler.deploy.aduplift.jsonc", "wrangler.deploy.maimax.jsonc"])("%s binds the template import service and the artifacts bucket", (file) => {
  const config = JSON.parse(stripComments(readFileSync(path.join(root, file), "utf8")));
  expect(config.services).toContainEqual({ binding: "TEMPLATE_MCP", service: "anjuna-template-mcp", entrypoint: "TemplateImportService" });
  expect(config.r2_buckets).toEqual([{ binding: "ARTIFACTS", bucket_name: "anjuna-artifacts" }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && bun run test -- test/templates-api.test.ts test/build.node.test.ts`
Expected: FAIL: `/api/templates` returns 404 `{ error: "not_found", resource: "route" }`, `env.ARTIFACTS` is undefined, and the wrangler expectations fail.

- [ ] **Step 3: Add the contracts**

Append to `packages/contracts/src/template-review.ts`:

```ts
// ── Control panel: Templates screen ─────────────────────────────────────────────

/** Timestamps stay plain strings: rows written by hand with datetime('now') must still list. */
const Stamp = z.string().min(1);

export const TemplateVersionSummary = z.strictObject({
  template_version_id: z.string().min(1).max(128),
  template_id: z.string().min(1).max(64),
  name: z.string().min(1),
  version: z.number().int().positive(),
  status: TemplateReviewStatus,
  submitted_by_label: z.string().nullable(),
  created_at: Stamp,
  sealed_at: Stamp.nullable(),
});
export type TemplateVersionSummary = z.infer<typeof TemplateVersionSummary>;

export const TemplateListResponse = z.strictObject({ templates: z.array(TemplateVersionSummary) });
export type TemplateListResponse = z.infer<typeof TemplateListResponse>;

export const TemplateCheckResult = z.strictObject({
  check_name: z.enum(["lint", "identity_scan", "screenshot_desktop", "screenshot_mobile"]),
  result: z.enum(["pass", "fail"]),
  details: z.unknown(),
  created_at: Stamp,
});
export type TemplateCheckResult = z.infer<typeof TemplateCheckResult>;

export const TemplateDetailResponse = z.strictObject({
  template: TemplateVersionSummary.extend({
    sha256: z.string(),
    sealed_by: z.string().nullable(),
    text_defaults: TemplateTextDefaults.nullable(),
  }),
  checks: z.array(TemplateCheckResult),
  screenshots: z.strictObject({ desktop: z.string().nullable(), mobile: z.string().nullable() }),
});
export type TemplateDetailResponse = z.infer<typeof TemplateDetailResponse>;

export const TemplateImportRequest = z.strictObject({
  url: z.url(),
  template_name: z.string().trim().min(1).max(128),
});
export type TemplateImportRequest = z.infer<typeof TemplateImportRequest>;

export const TemplateApproveResponse = z.strictObject({
  ok: z.literal(true),
  template_version_id: z.string(),
  sealed_by: z.string(),
  sealed_at: z.string(),
  already_sealed: z.boolean(),
});
export type TemplateApproveResponse = z.infer<typeof TemplateApproveResponse>;
```

- [ ] **Step 4: Add the bindings and roles**

In `apps/web/src/server/env.ts` add inside `interface Env`:

```ts
  /** R2 (read): certification screenshots for the Templates screen. */
  ARTIFACTS?: R2Bucket;
  /** Service Binding to anjuna-template-mcp's TemplateImportService (Import from URL). */
  TEMPLATE_MCP?: Fetcher;
```

In `apps/web/src/server/panel-roles.ts` add to `PANEL_ROLE_TABLE`:

```ts
  /** Templates screen: list, detail and Import from URL are employee and owner; Approve is owner only. */
  listTemplates: "employee",
  importTemplate: "employee",
  approveTemplate: "owner",
  /** Builder keys for the template MCP: owner only. */
  manageBuilderKeys: "owner",
```

In `apps/web/wrangler.jsonc`, add `{ "binding": "TEMPLATE_MCP", "service": "anjuna-template-mcp", "entrypoint": "TemplateImportService" }` as the last entry of `services`, and after the `services` array:

```jsonc
  "r2_buckets": [{ "binding": "ARTIFACTS", "bucket_name": "anjuna-artifacts" }],
```

In `apps/web/wrangler.deploy.aduplift.jsonc` and `apps/web/wrangler.deploy.maimax.jsonc`, add after the `FACTORY_WORKER` object in `services`:

```json
    {
      "binding": "TEMPLATE_MCP",
      "service": "anjuna-template-mcp",
      "entrypoint": "TemplateImportService"
    }
```

and after the `services` array:

```json
  "r2_buckets": [
    {
      "binding": "ARTIFACTS",
      "bucket_name": "anjuna-artifacts"
    }
  ],
```

In `apps/web/vitest.config.ts` change `d1Databases: ["AUTH", "FACTORY"],` to:

```ts
                d1Databases: ["AUTH", "FACTORY"],
                r2Buckets: ["ARTIFACTS"],
```

In `apps/web/test/env.d.ts` add `ARTIFACTS: R2Bucket;` to `interface Env`. In `apps/web/test/helpers.ts`, in `makeEnv`, add `ARTIFACTS: env.ARTIFACTS,` after `FACTORY: env.FACTORY,`.

- [ ] **Step 5: Implement the routes**

Create `apps/web/src/server/templates.ts`:

```ts
/**
 * Templates screen API: versions from the factory D1, screenshots from R2, Approve through the factory
 * Worker (it seals with the owner's user id), Import from URL through the template MCP service binding.
 */
import {
  TEMPLATE_VERSION_REVIEW_STATUS,
  TemplateApproveResponse,
  TemplateDetailResponse,
  TemplateImportRequest,
  TemplateListResponse,
  TemplateSubmitResult,
  TemplateTextDefaults,
  templateSlug,
  type AdminRequestContext,
  type TemplateVersionStatusName,
} from "@anjuna/contracts";
import type { Env } from "./env.js";
import { decodePathSegment } from "./lifecycle.js";
import { authorizePanel } from "./panel-roles.js";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const forbidden = (required: "owner" | "employee") => json(403, { error: "forbidden_role", required_role: required });
const notFound = (resource: string) => json(404, { error: "not_found", resource });

interface VersionRow {
  template_version_id: string;
  template_id: string;
  name: string;
  version: number;
  status: TemplateVersionStatusName;
  submitted_by_label: string | null;
  created_at: string;
  sealed_at: string | null;
}

const SUMMARY_COLUMNS = "v.template_version_id, v.template_id, t.name, v.version, v.status, v.submitted_by_label, v.created_at, v.sealed_at";

const summary = (row: VersionRow) => ({
  template_version_id: row.template_version_id,
  template_id: row.template_id,
  name: row.name,
  version: row.version,
  status: TEMPLATE_VERSION_REVIEW_STATUS[row.status],
  submitted_by_label: row.submitted_by_label,
  created_at: row.created_at,
  sealed_at: row.sealed_at,
});

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function textDefaults(text: string | null) {
  const parsed = TemplateTextDefaults.safeParse(parseJson(text));
  return parsed.success ? parsed.data : null;
}

export async function handleTemplateRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext, email: string): Promise<Response | undefined> {
  const method = request.method;

  if (path === "/api/templates" && method === "GET") {
    if (!authorizePanel("listTemplates", ctx.actor_role).ok) return forbidden("employee");
    const { results } = await env.FACTORY.prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM template_versions v JOIN templates t ON t.template_id = v.template_id
       ORDER BY v.created_at DESC, v.template_version_id LIMIT 200`,
    ).all<VersionRow>();
    return json(200, TemplateListResponse.parse({ templates: results.map(summary) }));
  }

  if (path === "/api/templates/import" && method === "POST") {
    if (!authorizePanel("importTemplate", ctx.actor_role).ok) return forbidden("employee");
    const parsed = TemplateImportRequest.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return json(422, { error: "invalid", issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) });
    }
    if (!env.TEMPLATE_MCP) return json(502, { error: "template_import_unavailable", message: "Template MCP binding is missing" });
    let response: Response;
    try {
      response = await env.TEMPLATE_MCP.fetch(new Request("https://template-mcp/submit-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: parsed.data.url,
          template_id: templateSlug(parsed.data.template_name),
          template_name: parsed.data.template_name,
          submitted_by: { key_id: null, label: email },
          created_by: ctx.actor_id,
        }),
      }));
    } catch {
      return json(502, { error: "template_import_unavailable", message: "Template MCP transport failed" });
    }
    const body = await response.json().catch(() => null);
    if (response.ok) {
      const result = TemplateSubmitResult.safeParse(body);
      return result.success ? json(200, result.data) : json(502, { error: "bad_gateway" });
    }
    return json(response.status === 422 ? 422 : 502, body ?? { error: "template_import_unavailable" });
  }

  let m = path.match(/^\/api\/templates\/([^/]+)\/screenshots\/(desktop|mobile)$/);
  if (m && method === "GET") {
    if (!authorizePanel("listTemplates", ctx.actor_role).ok) return forbidden("employee");
    const id = decodePathSegment(m[1]!);
    if (id === null) return notFound("screenshot");
    const check = await env.FACTORY.prepare(
      `SELECT artifact_r2_key FROM certifications WHERE template_version_id = ?1 AND check_name = ?2
       AND result = 'pass' AND artifact_r2_key IS NOT NULL ORDER BY id DESC LIMIT 1`,
    ).bind(id, `screenshot_${m[2]}`).first<{ artifact_r2_key: string }>();
    const object = check && env.ARTIFACTS ? await env.ARTIFACTS.get(check.artifact_r2_key) : null;
    if (!object) return notFound("screenshot");
    return new Response(object.body, { headers: { "content-type": "image/png", "cache-control": "private, max-age=300" } });
  }

  m = path.match(/^\/api\/templates\/([^/]+)\/approve$/);
  if (m && method === "POST") {
    if (!authorizePanel("approveTemplate", ctx.actor_role).ok) return forbidden("owner");
    const id = decodePathSegment(m[1]!);
    if (id === null) return notFound("template");
    if (!env.FACTORY_WORKER) return json(502, { error: "factory_dispatch_failed", message: "Factory Worker binding is missing" });
    let response: Response;
    try {
      response = await env.FACTORY_WORKER.fetch(new Request("https://factory/seal-template", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ template_version_id: id, sealed_by: ctx.actor_id, sealed_role: ctx.actor_role }),
      }));
    } catch {
      return json(502, { error: "factory_dispatch_failed", message: "Factory Worker transport failed" });
    }
    const body = await response.json().catch(() => null);
    if (response.ok) {
      const approved = TemplateApproveResponse.safeParse(body);
      return approved.success ? json(200, approved.data) : json(502, { error: "bad_gateway" });
    }
    return json(response.status >= 500 ? 502 : response.status, body ?? { error: "factory_dispatch_failed" });
  }

  m = path.match(/^\/api\/templates\/([^/]+)$/);
  if (m && method === "GET") {
    if (!authorizePanel("listTemplates", ctx.actor_role).ok) return forbidden("employee");
    const id = decodePathSegment(m[1]!);
    if (id === null) return notFound("template");
    const row = await env.FACTORY.prepare(
      `SELECT ${SUMMARY_COLUMNS}, v.sha256, v.sealed_by, v.text_defaults_json
       FROM template_versions v JOIN templates t ON t.template_id = v.template_id WHERE v.template_version_id = ?1`,
    ).bind(id).first<VersionRow & { sha256: string; sealed_by: string | null; text_defaults_json: string | null }>();
    if (!row) return notFound("template");
    const { results: checks } = await env.FACTORY.prepare(
      `SELECT check_name, result, details_json, artifact_r2_key, created_at FROM certifications
       WHERE id IN (SELECT MAX(id) FROM certifications WHERE template_version_id = ?1 GROUP BY check_name) ORDER BY check_name`,
    ).bind(id).all<{ check_name: string; result: string; details_json: string | null; artifact_r2_key: string | null; created_at: string }>();
    const shot = (viewport: "desktop" | "mobile") =>
      checks.some((c) => c.check_name === `screenshot_${viewport}` && c.result === "pass" && c.artifact_r2_key)
        ? `/api/templates/${encodeURIComponent(id)}/screenshots/${viewport}`
        : null;
    return json(200, TemplateDetailResponse.parse({
      template: { ...summary(row), sha256: row.sha256, sealed_by: row.sealed_by, text_defaults: textDefaults(row.text_defaults_json) },
      checks: checks.map((c) => ({ check_name: c.check_name, result: c.result, details: parseJson(c.details_json), created_at: c.created_at })),
      screenshots: { desktop: shot("desktop"), mobile: shot("mobile") },
    }));
  }

  return undefined;
}
```

In `apps/web/src/server/index.ts` add `import { handleTemplateRoute } from "./templates.js";` and, in `route()` right after `if (lifecycle) return lifecycle;`:

```ts
  const templates = await handleTemplateRoute(request, env, path, ctx, email);
  if (templates) return templates;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/web && bun run test`
Expected: PASS, including `lifecycle-api.test.ts` (`/api/templates/sealed` is still answered by the lifecycle route first).

- [ ] **Step 7: Typecheck and commit**

Run: `bun run typecheck` at the repo root. Expected: PASS.

```bash
git add packages/contracts/src/template-review.ts apps/web/src/server apps/web/wrangler.jsonc apps/web/wrangler.deploy.aduplift.jsonc apps/web/wrangler.deploy.maimax.jsonc apps/web/vitest.config.ts apps/web/test
git commit -F - <<'EOF'
feat(web): templates API with owner approve and import from URL (FUS-345)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 10: Templates screen

**Files:**
- Create: `apps/web/src/client/screens/Templates.tsx`
- Modify: `apps/web/src/client/api.ts` (four methods), `apps/web/src/client/App.tsx` (view, nav, hash), `apps/web/src/client/styles.css` (one rule)
- Test: `apps/web/test/templates.ui.test.tsx` (create)

**Interfaces:**
- Consumes: Task 9 routes and contracts `TemplateListResponse`, `TemplateDetailResponse`, `TemplateSubmitResult`, `TemplateApproveResponse`, `TemplateImportRequest`.
- Produces:
  - `api.templates(): Promise<TemplateListResponse>`, `api.template(id: string): Promise<TemplateDetailResponse>`, `api.approveTemplate(id: string): Promise<TemplateApproveResponse>`, `api.importTemplate(body: TemplateImportRequest): Promise<TemplateSubmitResult>`
  - `TemplatesScreen({ me }: { me: Me }): JSX.Element`; opens the version named by `#templates/<id>` (the `dashboard_url` from Task 5).
  - `View` gains `"templates"`; nav item "เทมเพลต (Templates)" for every role.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/templates.ui.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplatesScreen } from "../src/client/screens/Templates";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const employee = { ...owner, id: "employee", role: "employee" as const };
const STAMP = "2026-10-17T00:00:00.000Z";
const SPA = "This site renders with JavaScript. Ask bolt.new to make it static HTML, then submit again.";
const summary = {
  template_version_id: "tv-bolt-1", template_id: "tpl-bolt", name: "Bolt Harbor", version: 1, status: "awaiting_approval",
  submitted_by_label: "Somchai (bolt.new)", created_at: STAMP, sealed_at: null,
};
const detail = {
  template: { ...summary, sha256: "a".repeat(64), sealed_by: null, text_defaults: { brand_name: "Harbor", title: "Harbor | Funding", description: "Check options." } },
  checks: [
    { check_name: "identity_scan", result: "pass", details: { similarity: { summary: "PASS: no sealed templates to compare against yet." } }, created_at: STAMP },
    { check_name: "lint", result: "pass", details: {}, created_at: STAMP },
  ],
  screenshots: { desktop: "/api/templates/tv-bolt-1/screenshots/desktop", mobile: null },
};

type Handler = (init?: RequestInit) => Response;
let routes: Map<string, Handler>;
let requests: Array<{ method: string; path: string; body: unknown }>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  requests = [];
  routes = new Map<string, Handler>([
    ["GET /api/templates", () => json({ templates: [summary] })],
    ["GET /api/templates/tv-bolt-1", () => json(detail)],
    ["POST /api/templates/tv-bolt-1/approve", () => json({ ok: true, template_version_id: "tv-bolt-1", sealed_by: "owner", sealed_at: STAMP, already_sealed: false })],
  ]);
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, path: input, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const handler = routes.get(`${method} ${input}`);
    if (!handler) throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
    return handler(init);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

describe("Templates screen", () => {
  it("lists versions with their review status and shows the detail", async () => {
    render(<TemplatesScreen me={owner} />);
    fireEvent.click(await screen.findByText("Bolt Harbor"));
    expect(await screen.findByRole("img", { name: "ภาพหน้าจอ desktop (desktop screenshot)" })).toBeTruthy();
    expect(screen.getByText("ไม่มีภาพ mobile (No mobile screenshot)")).toBeTruthy();
    expect(screen.getByText(/PASS: no sealed templates/)).toBeTruthy();
    expect(screen.getByText("Harbor | Funding")).toBeTruthy();
    expect(screen.getAllByText("รออนุมัติ (Awaiting approval)").length).toBeGreaterThan(0);
  });

  it("lets an owner approve and hides Approve from an employee", async () => {
    const first = render(<TemplatesScreen me={employee} />);
    fireEvent.click(await screen.findByText("Bolt Harbor"));
    await screen.findByText("Harbor | Funding");
    expect(screen.queryByRole("button", { name: "อนุมัติ (Approve)" })).toBeNull();
    first.unmount();
    render(<TemplatesScreen me={owner} />);
    fireEvent.click(await screen.findByText("Bolt Harbor"));
    fireEvent.click(await screen.findByRole("button", { name: "อนุมัติ (Approve)" }));
    expect(await screen.findByText("อนุมัติแล้ว (Approved)")).toBeTruthy();
    expect(requests.some((r) => r.method === "POST" && r.path === "/api/templates/tv-bolt-1/approve")).toBe(true);
  });

  it("opens the version named in the URL hash", async () => {
    window.location.hash = "#templates/tv-bolt-1";
    render(<TemplatesScreen me={owner} />);
    expect(await screen.findByText("Harbor | Funding")).toBeTruthy();
  });

  it("imports from a URL and shows the static HTML instruction on rejection", async () => {
    routes.set("POST /api/templates/import", () => json({
      status: "rejected", template_version_id: null, version: null, sha256: null, dashboard_url: null,
      issues: [{ rule: "static-html", file: "index.html", message: SPA, fix: "Prerender." }],
      warnings: [], text_defaults: null, similarity: null, next_step: SPA,
    }));
    render(<TemplatesScreen me={employee} />);
    await screen.findByText("Bolt Harbor");
    fireEvent.change(screen.getByLabelText("URL ของเว็บที่เผยแพร่ (Published URL)"), { target: { value: "https://harbor.example.com/" } });
    fireEvent.change(screen.getByLabelText("ชื่อเทมเพลต (Template name)"), { target: { value: "Harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "นำเข้า (Import)" }));
    expect((await screen.findAllByText(SPA)).length).toBeGreaterThan(0);
    expect(requests.find((r) => r.path === "/api/templates/import")?.body).toEqual({ url: "https://harbor.example.com/", template_name: "Harbor" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && bun run test -- test/templates.ui.test.tsx`
Expected: FAIL: "Failed to load url ../src/client/screens/Templates".

- [ ] **Step 3: Implement**

In `apps/web/src/client/api.ts`, extend the value import from `@anjuna/contracts`:

```ts
import { LatestUpgradeResponse, SealedTemplatesResponse, TemplateApproveResponse, TemplateDetailResponse, TemplateListResponse, TemplateSubmitResult } from "@anjuna/contracts";
```

add `TemplateImportRequest` to the type import list, and add to the `api` object:

```ts
  templates: () => request<unknown>("GET", "/api/templates").then((body) => TemplateListResponse.parse(body)),
  template: (id: string) => request<unknown>("GET", `/api/templates/${encodeURIComponent(id)}`).then((body) => TemplateDetailResponse.parse(body)),
  approveTemplate: (id: string) => request<unknown>("POST", `/api/templates/${encodeURIComponent(id)}/approve`, {}).then((body) => TemplateApproveResponse.parse(body)),
  importTemplate: (body: TemplateImportRequest) => request<unknown>("POST", "/api/templates/import", body).then((result) => TemplateSubmitResult.parse(result)),
```

Create `apps/web/src/client/screens/Templates.tsx`:

```tsx
import type { TemplateDetailResponse, TemplateReviewStatus, TemplateSubmitResult, TemplateVersionSummary } from "@anjuna/contracts";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Me } from "../api";

const statusLabel: Record<TemplateReviewStatus, string> = {
  checking: "กำลังตรวจ (Checking)",
  rejected: "ไม่ผ่าน (Rejected)",
  awaiting_approval: "รออนุมัติ (Awaiting approval)",
  approved: "อนุมัติแล้ว (Approved)",
};
const statusPill: Record<TemplateReviewStatus, string> = { checking: "", rejected: "alert", awaiting_approval: "warn", approved: "ok" };

const errorText = (e: unknown) => (e instanceof ApiError ? (e.body?.message ?? e.thai) : "ไม่สำเร็จ");

function selectedFromHash(): string | null {
  const match = /^#templates\/(.+)$/.exec(window.location.hash);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function TemplatesScreen({ me }: { me: Me }) {
  const [templates, setTemplates] = useState<TemplateVersionSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(selectedFromHash);
  const [detail, setDetail] = useState<TemplateDetailResponse | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [form, setForm] = useState({ url: "", template_name: "" });
  const [imported, setImported] = useState<TemplateSubmitResult | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.templates().then((r) => setTemplates(r.templates), (e) => setMsg({ kind: "err", text: errorText(e) })), []);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    setDetail(null);
    if (selected) void api.template(selected).then(setDetail, (e) => setMsg({ kind: "err", text: errorText(e) }));
  }, [selected]);

  async function approve(id: string) {
    setMsg(null);
    setBusy(true);
    try {
      const r = await api.approveTemplate(id);
      setMsg({ kind: "ok", text: r.already_sealed ? "อนุมัติไว้แล้ว (Already approved)" : "อนุมัติแล้ว (Approved)" });
      await load();
      setDetail(await api.template(id));
    } catch (e) {
      setMsg({ kind: "err", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function importUrl() {
    setMsg(null);
    setImported(null);
    setBusy(true);
    try {
      const r = await api.importTemplate(form);
      setImported(r);
      if (r.template_version_id) setSelected(r.template_version_id);
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>เทมเพลต (Templates)</h1>
      {msg && <div className={msg.kind === "ok" ? "ok" : "error"} role="status">{msg.text}</div>}
      <section className="card">
        <div className="form-inline">
          <h2>นำเข้าจาก URL (Import from URL)</h2>
          <input aria-label="URL ของเว็บที่เผยแพร่ (Published URL)" placeholder="https://…" type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          <input aria-label="ชื่อเทมเพลต (Template name)" placeholder="ชื่อเทมเพลต (Template name)" maxLength={128} value={form.template_name} onChange={(e) => setForm({ ...form, template_name: e.target.value })} />
          <button className="primary" disabled={busy || !form.url.trim() || !form.template_name.trim()} onClick={() => void importUrl()}>นำเข้า (Import)</button>
        </div>
        {imported && <SubmitOutcome result={imported} />}
      </section>
      <table className="table clickable">
        <thead>
          <tr><th>เทมเพลต (Template)</th><th>เวอร์ชัน (Version)</th><th>สถานะ (Status)</th><th>ส่งโดย (Submitted by)</th><th>เวลา (Created)</th></tr>
        </thead>
        <tbody>
          {(templates ?? []).map((t) => (
            <tr key={t.template_version_id} className={t.template_version_id === selected ? "selected" : undefined} onClick={() => setSelected(t.template_version_id)}>
              <td>{t.name}</td>
              <td>v{t.version}</td>
              <td><span className={`pill ${statusPill[t.status]}`}>{statusLabel[t.status]}</span></td>
              <td>{t.submitted_by_label ?? "-"}</td>
              <td className="muted small">{t.created_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {templates?.length === 0 && <p className="muted">ยังไม่มีเทมเพลต (No templates yet)</p>}
      {detail && <TemplateDetail me={me} detail={detail} busy={busy} onApprove={() => void approve(detail.template.template_version_id)} />}
    </>
  );
}

function TemplateDetail({ me, detail, busy, onApprove }: { me: Me; detail: TemplateDetailResponse; busy: boolean; onApprove: () => void }) {
  const t = detail.template;
  const identity = detail.checks.find((c) => c.check_name === "identity_scan");
  const similarity = (identity?.details as { similarity?: { summary?: string } } | null | undefined)?.similarity?.summary ?? null;
  const defaults = t.text_defaults;
  return (
    <section className="card section" aria-label="รายละเอียดเทมเพลต (Template detail)">
      <div className="row split">
        <h2>{`${t.name} · v${t.version}`}</h2>
        <span className={`pill ${statusPill[t.status]}`}>{statusLabel[t.status]}</span>
      </div>
      <p className="muted small">{t.template_version_id} · ส่งโดย (Submitted by) {t.submitted_by_label ?? "-"} · <code>{t.sha256.slice(0, 12)}</code></p>
      <div className="template-shots">
        {(["desktop", "mobile"] as const).map((viewport) =>
          detail.screenshots[viewport]
            ? <img key={viewport} src={detail.screenshots[viewport]!} alt={`ภาพหน้าจอ ${viewport} (${viewport} screenshot)`} />
            : <p key={viewport} className="muted">{`ไม่มีภาพ ${viewport} (No ${viewport} screenshot)`}</p>)}
      </div>
      <h3>ผลการตรวจ (Checks)</h3>
      <ul>
        {detail.checks.map((c) => <li key={c.check_name}><span className={`pill ${c.result === "pass" ? "ok" : "alert"}`}>{c.result}</span> {c.check_name}</li>)}
      </ul>
      {similarity && <p className="small">ความคล้าย (Similarity): {similarity}</p>}
      <h3>ข้อความเริ่มต้น (Text defaults)</h3>
      <div className="status-grid">
        <div><span className="muted small">ชื่อแบรนด์ (Brand name)</span><b>{defaults?.brand_name ?? "-"}</b></div>
        <div><span className="muted small">ชื่อหน้า (Page title)</span><b>{defaults?.title ?? "-"}</b></div>
        <div><span className="muted small">คำอธิบาย (Meta description)</span><b>{defaults?.description ?? "-"}</b></div>
      </div>
      {me.role === "owner" && t.status === "awaiting_approval" && (
        <button className="primary" disabled={busy} onClick={onApprove}>อนุมัติ (Approve)</button>
      )}
    </section>
  );
}

function SubmitOutcome({ result }: { result: TemplateSubmitResult }) {
  const title = result.status === "awaiting_approval" ? "ส่งแล้ว รออนุมัติ (Awaiting approval)" : result.status === "duplicate" ? "ซ้ำกับเวอร์ชันเดิม (Duplicate)" : "ไม่ผ่าน (Rejected)";
  return (
    <div className={result.status === "rejected" ? "error" : "ok"} role="status">
      <b>{title}</b>
      <p>{result.next_step}</p>
      {result.issues.length > 0 && (
        <ul>{result.issues.map((issue, i) => <li key={i}><code>{issue.rule}</code> {issue.file ? `${issue.file}: ` : ""}{issue.message}</li>)}</ul>
      )}
    </div>
  );
}
```

In `apps/web/src/client/styles.css` append:

```css
.template-shots { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0; }
.template-shots img { width: min(320px, 100%); border: 1px solid var(--line); border-radius: 6px; }
```

In `apps/web/src/client/App.tsx`: import `import { TemplatesScreen } from "./screens/Templates";`; change the `View` type to include `"templates"`; initialize the view from the hash:

```tsx
  const [view, setView] = useState<View>(() => (window.location.hash.startsWith("#templates") ? "templates" : "brands"));
```

add `{ id: "templates", label: "เทมเพลต (Templates)", show: true },` after the `brands` nav entry, and in `<main>` add:

```tsx
        {view === "templates" && <TemplatesScreen me={me} />}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && bun run test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck` at the repo root. Expected: PASS.

```bash
git add apps/web/src/client apps/web/test/templates.ui.test.tsx
git commit -F - <<'EOF'
feat(web): Templates screen with review detail, approve and import from URL (FUS-345)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 11: Builder keys API and screen

**Files:**
- Create: `packages/contracts/src/builder-keys.ts`; modify `packages/contracts/src/index.ts`
- Create: `apps/web/src/server/builder-keys.ts`
- Modify: `apps/web/src/server/index.ts` (route), `apps/web/src/server/audit.ts` (`FACTORY_AUDIT_PREFIXES`)
- Create: `apps/web/src/client/screens/BuilderKeys.tsx`
- Modify: `apps/web/src/client/api.ts`, `apps/web/src/client/App.tsx`
- Modify: `workers/template-mcp/README.md` (minting section)
- Test: `apps/web/test/builder-keys-api.test.ts`, `apps/web/test/builder-keys.ui.test.tsx` (create both)

**Interfaces:**
- Consumes: factory D1 `builder_keys` (migration 0002), `PANEL_ROLE_TABLE.manageBuilderKeys` (Task 9), `writeFactoryAudit`.
- Produces:
  - Contracts: `BUILDER_KEY_PREFIX = "anj_mcp_"`, `BuilderKeySummary` (`{ key_id, label, created_by, created_at, last_used_at: string | null, revoked_at: string | null }`), `BuilderKeyListResponse` (`{ keys }`), `BuilderKeyCreateRequest` (`{ label }`, 1-80 chars), `BuilderKeyCreateResponse` (`{ key, secret }`, secret `anj_mcp_` + 43 base64url chars).
  - `handleBuilderKeyRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext): Promise<Response | undefined>`: `GET /api/builder-keys`, `POST /api/builder-keys` (201, secret shown once), `POST /api/builder-keys/:id/revoke` (200, idempotent; 404 unknown). Owner only; employee 403.
  - `api.builderKeys()`, `api.createBuilderKey(label)`, `api.revokeBuilderKey(id)`; `BuilderKeysScreen()`; `View` gains `"builder-keys"` (owner only).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/builder-keys-api.test.ts`:

```ts
import { createHash } from "node:crypto";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BuilderKeyCreateResponse, BuilderKeyListResponse } from "@anjuna/contracts";
import { call, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;
beforeAll(setupDatabases);
beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
});

const post = (cookie: string, path: string, body: unknown = {}) => call(path, { cookie, method: "POST", body });

describe("builder keys API", () => {
  it("lets only an owner create, list and revoke keys; the secret is shown once and only its hash is stored", async () => {
    expect((await call("/api/builder-keys", { cookie: employee })).status).toBe(403);
    expect((await post(employee, "/api/builder-keys", { label: "x" })).status).toBe(403);

    const created = await post(owner, "/api/builder-keys", { label: "Somchai (bolt.new)" });
    expect(created.status).toBe(201);
    const { key, secret } = BuilderKeyCreateResponse.parse(await created.json());
    const stored = await env.FACTORY.prepare("SELECT key_hash, label FROM builder_keys WHERE key_id = ?1").bind(key.key_id).first();
    expect(stored).toEqual({ key_hash: createHash("sha256").update(secret).digest("hex"), label: "Somchai (bolt.new)" });

    const listed = BuilderKeyListResponse.parse(await (await call("/api/builder-keys", { cookie: owner })).json());
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(listed.keys.find((k) => k.key_id === key.key_id)).toMatchObject({ label: "Somchai (bolt.new)", last_used_at: null, revoked_at: null });

    const revoked = await post(owner, `/api/builder-keys/${key.key_id}/revoke`);
    expect(revoked.status).toBe(200);
    const revokedAt = ((await revoked.json()) as { key: { revoked_at: string } }).key.revoked_at;
    expect(revokedAt).toEqual(expect.any(String));
    const again = await post(owner, `/api/builder-keys/${key.key_id}/revoke`);
    expect(((await again.json()) as { key: { revoked_at: string } }).key.revoked_at).toBe(revokedAt);
    expect((await post(owner, "/api/builder-keys/bk_missing/revoke")).status).toBe(404);

    const audit = await env.FACTORY.prepare("SELECT action, after_json FROM audit_log WHERE entity_id = ?1 ORDER BY id").bind(key.key_id).all<{ action: string; after_json: string }>();
    expect(audit.results.map((r) => r.action)).toEqual(["builder_key.create", "builder_key.revoke"]);
    expect(audit.results.map((r) => r.after_json).join("")).not.toContain(secret);
  });

  it("rejects an empty or over-long label", async () => {
    for (const label of ["", "   ", "x".repeat(81)]) expect((await post(owner, "/api/builder-keys", { label })).status, label).toBe(422);
  });

  it("shows the last use the template MCP recorded", async () => {
    await env.FACTORY.prepare("INSERT OR IGNORE INTO builder_keys (key_id, label, key_hash, created_by, created_at, last_used_at) VALUES ('bk_used', 'used', ?1, 'system', '2026-10-01T00:00:00.000Z', '2026-10-17T08:00:00.000Z')")
      .bind("c".repeat(64)).run();
    const listed = BuilderKeyListResponse.parse(await (await call("/api/builder-keys", { cookie: owner })).json());
    expect(listed.keys.find((k) => k.key_id === "bk_used")?.last_used_at).toBe("2026-10-17T08:00:00.000Z");
  });
});
```

Create `apps/web/test/builder-keys.ui.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuilderKeysScreen } from "../src/client/screens/BuilderKeys";

const SECRET = `anj_mcp_${"A".repeat(43)}`;
const active = { key_id: "bk_1", label: "Somchai (bolt.new)", created_by: "owner", created_at: "2026-10-17T00:00:00.000Z", last_used_at: null, revoked_at: null };
let keys: unknown[];
let requests: Array<{ method: string; path: string }>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  keys = [active];
  requests = [];
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, path: input });
    if (method === "GET" && input === "/api/builder-keys") return json({ keys });
    if (method === "POST" && input === "/api/builder-keys") {
      const key = { ...active, key_id: "bk_2", label: JSON.parse(String(init!.body)).label };
      keys = [key, ...keys];
      return json({ key, secret: SECRET }, 201);
    }
    if (method === "POST" && input === "/api/builder-keys/bk_1/revoke") {
      keys = [{ ...active, revoked_at: "2026-10-17T01:00:00.000Z" }];
      return json({ key: keys[0] });
    }
    throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Builder keys screen", () => {
  it("lists keys with their last use", async () => {
    render(<BuilderKeysScreen />);
    expect(await screen.findByText("Somchai (bolt.new)")).toBeTruthy();
    expect(screen.getByText("ยังไม่เคยใช้ (Never)")).toBeTruthy();
  });

  it("shows a new key once, then hides it", async () => {
    render(<BuilderKeysScreen />);
    await screen.findByText("Somchai (bolt.new)");
    fireEvent.change(screen.getByLabelText("ชื่อคีย์ (Key label)"), { target: { value: "Malee (bolt.new)" } });
    fireEvent.click(screen.getByRole("button", { name: "สร้างคีย์ (Create key)" }));
    expect(await screen.findByText(SECRET)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ปิด (Close)" }));
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(await screen.findByText("Malee (bolt.new)")).toBeTruthy();
  });

  it("revokes a key after confirmation", async () => {
    render(<BuilderKeysScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "ยกเลิกคีย์ Somchai (bolt.new) (Revoke)" }));
    expect(await screen.findByText("ยกเลิกแล้ว (Revoked)")).toBeTruthy();
    expect(requests).toContainEqual({ method: "POST", path: "/api/builder-keys/bk_1/revoke" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && bun run test -- test/builder-keys-api.test.ts test/builder-keys.ui.test.tsx`
Expected: FAIL: `/api/builder-keys` returns 404 and "Failed to load url ../src/client/screens/BuilderKeys".

- [ ] **Step 3: Implement the contracts and the API**

Create `packages/contracts/src/builder-keys.ts`:

```ts
/** Template MCP builder keys managed from the control panel (owner only). Only a SHA-256 hash is stored. */
import { z } from "zod";

export const BUILDER_KEY_PREFIX = "anj_mcp_";

/** Timestamps stay plain strings: keys minted by hand may carry datetime('now') values. */
export const BuilderKeySummary = z.strictObject({
  key_id: z.string().min(1).max(64),
  label: z.string().min(1),
  created_by: z.string().min(1),
  created_at: z.string().min(1),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});
export type BuilderKeySummary = z.infer<typeof BuilderKeySummary>;

export const BuilderKeyListResponse = z.strictObject({ keys: z.array(BuilderKeySummary) });
export type BuilderKeyListResponse = z.infer<typeof BuilderKeyListResponse>;

export const BuilderKeyCreateRequest = z.strictObject({ label: z.string().trim().min(1).max(80) });
export type BuilderKeyCreateRequest = z.infer<typeof BuilderKeyCreateRequest>;

export const BuilderKeyCreateResponse = z.strictObject({
  key: BuilderKeySummary,
  /** Shown once; the server keeps only its SHA-256 hash. */
  secret: z.string().regex(/^anj_mcp_[A-Za-z0-9_-]{43}$/),
});
export type BuilderKeyCreateResponse = z.infer<typeof BuilderKeyCreateResponse>;
```

Append `export * from "./builder-keys.js";` to `packages/contracts/src/index.ts`.

In `apps/web/src/server/audit.ts` add `"builder_key"` to `FACTORY_AUDIT_PREFIXES`.

Create `apps/web/src/server/builder-keys.ts`:

```ts
/**
 * Builder keys for the template MCP (factory D1 builder_keys). Replaces scripts/mint-key.mjs for staff keys.
 * The key is shown once in the create response; the table and the audit log hold only its label and hash.
 */
import {
  BUILDER_KEY_PREFIX,
  BuilderKeyCreateRequest,
  BuilderKeyCreateResponse,
  BuilderKeyListResponse,
  BuilderKeySummary,
  type AdminRequestContext,
} from "@anjuna/contracts";
import { writeFactoryAudit } from "./audit.js";
import type { Env } from "./env.js";
import { decodePathSegment } from "./lifecycle.js";
import { authorizePanel } from "./panel-roles.js";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const COLUMNS = "key_id, label, created_by, created_at, last_used_at, revoked_at";

/** 32 random bytes, base64url without padding: the same format scripts/mint-key.mjs prints. */
function newSecret(): string {
  let binary = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(32))) binary += String.fromCharCode(byte);
  return BUILDER_KEY_PREFIX + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleBuilderKeyRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  const revoke = path.match(/^\/api\/builder-keys\/([^/]+)\/revoke$/);
  if (path !== "/api/builder-keys" && !revoke) return undefined;
  if (!authorizePanel("manageBuilderKeys", ctx.actor_role).ok) return json(403, { error: "forbidden_role", required_role: "owner" });

  if (path === "/api/builder-keys" && request.method === "GET") {
    const { results } = await env.FACTORY.prepare(`SELECT ${COLUMNS} FROM builder_keys ORDER BY created_at DESC, key_id`).all();
    return json(200, BuilderKeyListResponse.parse({ keys: results }));
  }

  if (path === "/api/builder-keys" && request.method === "POST") {
    const parsed = BuilderKeyCreateRequest.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return json(422, { error: "invalid", issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) });
    }
    const secret = newSecret();
    const key = {
      key_id: `bk_${crypto.randomUUID()}`, label: parsed.data.label, created_by: ctx.actor_id,
      created_at: new Date().toISOString(), last_used_at: null, revoked_at: null,
    };
    await env.FACTORY.prepare("INSERT INTO builder_keys (key_id, label, key_hash, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(key.key_id, key.label, await sha256Hex(secret), key.created_by, key.created_at)
      .run();
    await writeFactoryAudit(env.FACTORY, {
      actor_id: ctx.actor_id, actor_role: ctx.actor_role, action: "builder_key.create",
      entity_type: "builder_key", entity_id: key.key_id, after: { label: key.label },
    });
    return json(201, BuilderKeyCreateResponse.parse({ key, secret }));
  }

  if (revoke && request.method === "POST") {
    const keyId = decodePathSegment(revoke[1]!);
    if (keyId === null) return json(404, { error: "not_found", resource: "builder_key" });
    const now = new Date().toISOString();
    const update = await env.FACTORY.prepare("UPDATE builder_keys SET revoked_at = ?2 WHERE key_id = ?1 AND revoked_at IS NULL").bind(keyId, now).run();
    const row = await env.FACTORY.prepare(`SELECT ${COLUMNS} FROM builder_keys WHERE key_id = ?1`).bind(keyId).first();
    if (!row) return json(404, { error: "not_found", resource: "builder_key" });
    if (update.meta.changes === 1) {
      await writeFactoryAudit(env.FACTORY, {
        actor_id: ctx.actor_id, actor_role: ctx.actor_role, action: "builder_key.revoke",
        entity_type: "builder_key", entity_id: keyId, after: { revoked_at: now },
      });
    }
    return json(200, { key: BuilderKeySummary.parse(row) });
  }

  return json(405, { error: "method_not_allowed" });
}
```

In `apps/web/src/server/index.ts` add `import { handleBuilderKeyRoute } from "./builder-keys.js";` and after the templates route:

```ts
  const builderKeys = await handleBuilderKeyRoute(request, env, path, ctx);
  if (builderKeys) return builderKeys;
```

- [ ] **Step 4: Implement the screen**

In `apps/web/src/client/api.ts` add `BuilderKeyCreateResponse, BuilderKeyListResponse, BuilderKeySummary` to the value import from `@anjuna/contracts` and add to `api`:

```ts
  builderKeys: () => request<unknown>("GET", "/api/builder-keys").then((body) => BuilderKeyListResponse.parse(body)),
  createBuilderKey: (label: string) => request<unknown>("POST", "/api/builder-keys", { label }).then((body) => BuilderKeyCreateResponse.parse(body)),
  revokeBuilderKey: (id: string) => request<{ key: unknown }>("POST", `/api/builder-keys/${encodeURIComponent(id)}/revoke`, {}).then((body) => BuilderKeySummary.parse(body.key)),
```

Create `apps/web/src/client/screens/BuilderKeys.tsx`:

```tsx
import type { BuilderKeySummary } from "@anjuna/contracts";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";

export function BuilderKeysScreen() {
  const [keys, setKeys] = useState<BuilderKeySummary[] | null>(null);
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<{ label: string; secret: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => api.builderKeys().then((r) => setKeys(r.keys), (e) => setMsg(e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ")), []);
  useEffect(() => void load(), [load]);

  async function run(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.thai : "ไม่สำเร็จ");
    }
  }

  return (
    <>
      <h1>คีย์ Builder (Builder keys)</h1>
      <p className="muted">คีย์สำหรับเชื่อม bolt.new กับ template MCP หนึ่งคนต่อหนึ่งคีย์ (One key per staff member for the bolt.new connector)</p>
      {msg && <div className="error">{msg}</div>}
      <table className="table">
        <thead>
          <tr><th>ชื่อคีย์ (Label)</th><th>สร้างเมื่อ (Created)</th><th>ใช้ล่าสุด (Last used)</th><th>สถานะ (Status)</th><th /></tr>
        </thead>
        <tbody>
          {(keys ?? []).map((k) => (
            <tr key={k.key_id}>
              <td>{k.label}</td>
              <td className="muted small">{k.created_at}</td>
              <td className="muted small">{k.last_used_at ?? "ยังไม่เคยใช้ (Never)"}</td>
              <td><span className={`pill ${k.revoked_at ? "alert" : "ok"}`}>{k.revoked_at ? "ยกเลิกแล้ว (Revoked)" : "ใช้งาน (Active)"}</span></td>
              <td>
                {!k.revoked_at && (
                  <button
                    className="danger"
                    aria-label={`ยกเลิกคีย์ ${k.label} (Revoke)`}
                    onClick={() => { if (window.confirm(`ยกเลิกคีย์ ${k.label}? bolt.new ที่ใช้คีย์นี้จะเชื่อมต่อไม่ได้ทันที`)) void run(() => api.revokeBuilderKey(k.key_id)); }}
                  >
                    ยกเลิก (Revoke)
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="card form-inline">
        <h2>สร้างคีย์ใหม่ (New key)</h2>
        <input aria-label="ชื่อคีย์ (Key label)" placeholder="เช่น Somchai (bolt.new)" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
        <button
          className="primary"
          disabled={!label.trim()}
          onClick={() => void run(async () => {
            const r = await api.createBuilderKey(label.trim());
            setCreated({ label: r.key.label, secret: r.secret });
            setLabel("");
          })}
        >
          สร้างคีย์ (Create key)
        </button>
      </div>
      {created && <SecretModal label={created.label} secret={created.secret} onClose={() => setCreated(null)} />}
    </>
  );
}

function SecretModal({ label, secret, onClose }: { label: string; secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="modal-wrap" role="dialog" aria-modal="true" aria-label="คีย์ใหม่ (New key)">
      <div className="card modal">
        <h2>{`คีย์ใหม่: ${label} (New key)`}</h2>
        <div className="warn">คุณจะไม่เห็นคีย์นี้อีก (you will not see this again). คัดลอกแล้ววางใน bolt.new: Connectors, API key</div>
        <code className="token">{secret}</code>
        <div className="row">
          <button className="primary" onClick={async () => { await navigator.clipboard?.writeText(secret).catch(() => undefined); setCopied(true); }}>
            {copied ? "คัดลอกแล้ว (Copied)" : "คัดลอก (Copy)"}
          </button>
          <button onClick={onClose}>ปิด (Close)</button>
        </div>
      </div>
    </div>
  );
}
```

In `apps/web/src/client/App.tsx`: import `import { BuilderKeysScreen } from "./screens/BuilderKeys";`; add `"builder-keys"` to `View`; add `{ id: "builder-keys", label: "คีย์ Builder (Builder keys)", show: me.role === "owner" },` after the `users` nav entry; and in `<main>`:

```tsx
        {view === "builder-keys" && me.role === "owner" && <BuilderKeysScreen />}
```

In `workers/template-mcp/README.md`, replace the sentence starting "Mint one with `node scripts/mint-key.mjs`" with: "Staff keys are created, listed (with last use) and revoked by an owner in the control panel under Builder keys. `node scripts/mint-key.mjs "<label>"` remains for keys minted outside the panel."

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && bun run test`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `bun run typecheck` at the repo root. Expected: PASS.

```bash
git add packages/contracts/src/builder-keys.ts packages/contracts/src/index.ts apps/web/src apps/web/test/builder-keys-api.test.ts apps/web/test/builder-keys.ui.test.tsx workers/template-mcp/README.md
git commit -F - <<'EOF'
feat(web): builder keys screen, owner only, key shown once (FUS-345)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 12: Site text storage: leads D1, contracts and core

**Files:**
- Create: `packages/leads-db/migrations/0011_brand_site_text.sql`
- Modify: `packages/leads-db/src/index.ts` (`LEADS_DB_MIGRATIONS`, `BrandRuntimeRow`), `packages/leads-db/test/leads-db.test.ts`
- Modify: `packages/contracts/src/leads-rpc.ts` (`BrandSettingsRequest`, `BrandSettingsResponse`)
- Modify: `packages/contracts/src/admin-api.ts` (`BrandConfig`, `BRAND_PATCH_FIELDS`, `BrandPatchRequest`, `BRAND_PATCH_FIELD_GROUPS`)
- Modify: `packages/contracts/fixtures/admin/brand.get.response.json`, `brand.get.response.no-token.json`, `brand.patch.response.json`, `brand.patch.response.rotate.json`
- Modify: `packages/contracts/test/admin-api.test.ts`, `packages/contracts/test/leads-rpc.test.ts`
- Modify: `workers/core/src/rpc/runtime.ts`, `workers/core/src/rpc/index.ts`, `workers/core/src/admin/index.ts`
- Modify: `workers/core/test/rpc.test.ts`, `workers/core/test/admin.test.ts`
- Modify: `apps/web/src/server/mock-core.ts` (brand-b), `apps/web/test/lifecycle.ui.test.tsx` (`initialConfig`)

**Interfaces:**
- Consumes: Task 3 `SiteBrandName`, `SiteTitle`, `SiteDescription`.
- Produces:
  - Columns `brand_runtime.brand_name` (1-80), `site_title` (1-70), `site_description` (1-160), all nullable; NULL = template default.
  - `BrandSettingsRequest`: `{ brand_id; include_site_text?: true }`. `BrandSettingsResponse` gains optional `brand_name`, `site_title`, `site_description` (`string | null`), present only when the request set `include_site_text: true`.
  - `BrandConfig` gains `brand_name`, `site_title`, `site_description` (`string | null`). `BRAND_PATCH_FIELDS` and `BrandPatchRequest` gain the same three (null resets). Field group `site_text` (`min_role: "employee"`, `plan_action: "Edit site text"`).
  - `RuntimeRow` gains the three columns; `publicSettings(row: RuntimeRow, includeSiteText = false): BrandSettingsResponse` (a stored value that fails validation is returned as null).

- [ ] **Step 1: Write the failing tests**

Append inside `describe("brand_runtime", ...)` in `packages/leads-db/test/leads-db.test.ts`:

```ts
    it("stores per-brand site text and enforces the length limits", async () => {
      await insert({ brand_id: "brand-text", brand_name: "Quick Funds", site_title: "Quick Funds | Options", site_description: "Compare options." });
      expect(await env.DB.prepare("SELECT brand_name, site_title, site_description FROM brand_runtime WHERE brand_id = 'brand-text'").first())
        .toEqual({ brand_name: "Quick Funds", site_title: "Quick Funds | Options", site_description: "Compare options." });
      await expect(insert({ brand_id: "brand-text-2", site_title: "T".repeat(71) })).rejects.toThrow(/CHECK constraint failed/);
      await expect(insert({ brand_id: "brand-text-3", site_description: "d".repeat(161) })).rejects.toThrow(/CHECK constraint failed/);
      await expect(insert({ brand_id: "brand-text-4", brand_name: "" })).rejects.toThrow(/CHECK constraint failed/);
    });
```

In `packages/contracts/test/leads-rpc.test.ts` add inside `describe("brandSettings", ...)`:

```ts
  it("site text is optional on the wire and validated when present", () => {
    const data = fixture<object>("rpc/brandSettings.response.json");
    expect(BrandSettingsResponse.parse({ ...data, brand_name: "Quick Funds", site_title: null, site_description: null })).toMatchObject({ brand_name: "Quick Funds" });
    expect(BrandSettingsResponse.safeParse({ ...data, site_title: "Personal Loans" }).success).toBe(false);
    expect(BrandSettingsRequest.parse({ brand_id: "brand-a", include_site_text: true })).toEqual({ brand_id: "brand-a", include_site_text: true });
    expect(BrandSettingsRequest.safeParse({ brand_id: "brand-a", include_site_text: false }).success).toBe(false);
  });
```

In `packages/contracts/test/admin-api.test.ts`:
- replace `const ownerOnly = BRAND_PATCH_FIELDS.filter((f) => f !== "keyword_default");` with:

```ts
    const employeeFields: string[] = ["keyword_default", "brand_name", "site_title", "site_description"];
    const ownerOnly = BRAND_PATCH_FIELDS.filter((f) => !employeeFields.includes(f));
```

- add to `PLAN_MATRIX` after the "Edit keyword default" row:

```ts
  { action: "Edit site text", employee: "yes", covered_by: ["patch:site_text"] },
```

- add inside `describe("authorize()", ...)`:

```ts
  it("employee may edit site text; values are validated", () => {
    expect(authorize("patchBrand", "employee", { brand_name: "Quick Funds", site_title: null }).ok).toBe(true);
    expect(BrandPatchRequest.safeParse({ site_description: "Personal Loan offers" }).success).toBe(false);
    expect(BrandPatchRequest.safeParse({ site_title: "T".repeat(71) }).success).toBe(false);
    expect(BrandPatchRequest.safeParse({ brand_name: null }).success).toBe(true);
  });
```

Append at the end of `workers/core/test/rpc.test.ts` inside its top-level `describe` (after the existing brandSettings golden test):

```ts
  it("returns site text only to runtimes that ask for it, and drops a stored value that no longer validates", async () => {
    await h.db.prepare("UPDATE brand_runtime SET brand_name = 'Quick Funds', site_title = 'Quick Funds | Options', site_description = 'Personal loans fast' WHERE brand_id = 'brand-a'").run();
    const legacy = await (await rpc("brandSettings", { brand_id: "brand-a" })).json() as Record<string, unknown>;
    expect(legacy).toEqual(JSON.parse(fixtureText("rpc/brandSettings.response.json")));
    const current = await (await rpc("brandSettings", { brand_id: "brand-a", include_site_text: true })).json();
    expect(current).toMatchObject({ brand_name: "Quick Funds", site_title: "Quick Funds | Options", site_description: null });
  });
```

Append at the end of `workers/core/test/admin.test.ts` (a new top-level `describe`, so the earlier tests keep their `updated_at` values):

```ts
describe("site text through the admin API", () => {
  const save = (body: unknown) => h.admin("/admin/brands/brand-a", employee, { method: "PATCH", body: JSON.stringify(body) });

  it("lets an employee edit site text, validates it, and resets a field with null", async () => {
    const ok = await save({ brand_name: "Quick Funds", site_title: "Quick Funds | Check Your Options", site_description: "Compare funding options from lending partners." });
    expect(ok.status).toBe(200);
    expect(BrandPatchResponse.parse(await ok.json())).toMatchObject({ changed: ["brand_name", "site_title", "site_description"], brand: { brand_name: "Quick Funds" } });
    for (const bad of [{ site_title: "T".repeat(71) }, { site_description: "Personal Loans for everyone" }, { brand_name: "Anjuna Funds" }, { site_title: "<b>Bold</b>" }]) {
      expect((await save(bad)).status, JSON.stringify(bad)).toBe(422);
    }
    const reset = await save({ site_title: null });
    expect(BrandPatchResponse.parse(await reset.json()).brand.site_title).toBeNull();
    const brand = GetBrandResponse.parse(await (await h.admin("/admin/brands/brand-a", employee)).json()).brand;
    expect(brand).toMatchObject({ brand_name: "Quick Funds", site_title: null, site_description: "Compare funding options from lending partners." });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/leads-db && bun run test`
Expected: FAIL: "table brand_runtime has no column named brand_name".

Run: `cd packages/contracts && bun run test`
Expected: FAIL: `include_site_text` is an unrecognized key and "no role table row for patch:site_text".

Run: `cd workers/core && bun run test -- test/rpc.test.ts test/admin.test.ts`
Expected: FAIL: "no such column: brand_name".

- [ ] **Step 3: Implement storage and contracts**

Create `packages/leads-db/migrations/0011_brand_site_text.sql`:

```sql
-- Migration 0011: per-brand site text edited in the control panel.
-- NULL means "use the template default" (the revision's config_json text_defaults).
-- Core validates values on save (length, brand clean, no "personal loan" wording); the CHECKs bound the length.

ALTER TABLE brand_runtime ADD COLUMN brand_name TEXT
  CHECK (brand_name IS NULL OR length(brand_name) BETWEEN 1 AND 80);
ALTER TABLE brand_runtime ADD COLUMN site_title TEXT
  CHECK (site_title IS NULL OR length(site_title) BETWEEN 1 AND 70);
ALTER TABLE brand_runtime ADD COLUMN site_description TEXT
  CHECK (site_description IS NULL OR length(site_description) BETWEEN 1 AND 160);
```

In `packages/leads-db/src/index.ts` add `"0011_brand_site_text.sql",` after `"0010_zip_lookup_seed.sql",` and add to `BrandRuntimeRow` after `last_lifecycle_install_id`:

```ts
  /** Site text from the control panel; null = the template default. */
  brand_name: string | null;
  site_title: string | null;
  site_description: string | null;
```

In `packages/contracts/src/leads-rpc.ts` add `import { SiteBrandName, SiteDescription, SiteTitle } from "./site-text.js";` and replace the two settings schemas:

```ts
export const BrandSettingsRequest = z.strictObject({
  brand_id: BrandId,
  /** Brand runtimes with site text support ask for it. Older runtimes omit it and keep the old strict shape. */
  include_site_text: z.literal(true).optional(),
});
export const BrandSettingsResponse = z.strictObject({
  flow_gate_mode: FlowGateMode,
  paused: z.boolean(),
  amount_buckets: AmountBuckets,
  ab_config: AbConfig.nullable(),
  keyword_default: Keyword.nullable(),
  form_route: FormRoute,
  /** Present only when the request set include_site_text. Null = use the template default. */
  brand_name: SiteBrandName.nullable().optional(),
  site_title: SiteTitle.nullable().optional(),
  site_description: SiteDescription.nullable().optional(),
});
```

In `packages/contracts/src/admin-api.ts` add `import { SiteBrandName, SiteDescription, SiteTitle } from "./site-text.js";` and:
- in `BrandConfig`, after `keyword_default: Keyword.nullable(),`:

```ts
  /** Site text edited in the control panel. Null = the template default. */
  brand_name: SiteBrandName.nullable(),
  site_title: SiteTitle.nullable(),
  site_description: SiteDescription.nullable(),
```

- in `BRAND_PATCH_FIELDS`, after `"keyword_default",`: `"brand_name", "site_title", "site_description",`
- in `BrandPatchRequest`, after the `keyword_default` line:

```ts
    /** Null resets the field to the template default. */
    brand_name: SiteBrandName.nullable().optional(),
    site_title: SiteTitle.nullable().optional(),
    site_description: SiteDescription.nullable().optional(),
```

- in `BRAND_PATCH_FIELD_GROUPS`, after the `keyword` group:

```ts
  site_text: {
    min_role: "employee",
    fields: ["brand_name", "site_title", "site_description"],
    plan_action: "Edit site text",
  },
```

In each of `packages/contracts/fixtures/admin/brand.get.response.json`, `brand.get.response.no-token.json`, `brand.patch.response.json` and `brand.patch.response.rotate.json`, add after the `"keyword_default": ...` property of the `brand` object (not the `changed` array):

```json
    "brand_name": null,
    "site_title": null,
    "site_description": null,
```

In `apps/web/src/server/mock-core.ts`, in the brand-b object, add after `keyword_default: null,`:

```ts
    brand_name: null,
    site_title: null,
    site_description: null,
```

In `apps/web/test/lifecycle.ui.test.tsx`, in `initialConfig`, add `brand_name: null, site_title: null, site_description: null,` after `keyword_default: "Quick Loan",`.

- [ ] **Step 4: Implement core**

In `workers/core/src/rpc/runtime.ts` replace the file's import line, `RuntimeRow`, `getRuntime` and `publicSettings` with:

```ts
import { BrandSettingsResponse, SiteBrandName, SiteDescription, SiteTitle, type BrandSettingsResponse as PublicSettings } from "@anjuna/contracts";
import type { Env } from "../env.js";

export interface RuntimeRow {
  brand_id: string;
  hostnames: string;
  aid: string;
  prepop_base: string;
  amount_buckets: string;
  flow_gate_mode: "param" | "signed_cookie";
  paused: number;
  ab_config_json: string | null;
  keyword_default: string | null;
  form_route: string;
  brand_name: string | null;
  site_title: string | null;
  site_description: string | null;
}

export function getRuntime(env: Env, brandId: string): Promise<RuntimeRow | null> {
  return env.LEADS.prepare(`SELECT brand_id, hostnames, aid, prepop_base, amount_buckets,
    flow_gate_mode, paused, ab_config_json, keyword_default, form_route,
    brand_name, site_title, site_description
    FROM brand_runtime WHERE brand_id = ?1`).bind(brandId).first<RuntimeRow>();
}

/** A stored value that no longer passes the site text rules is served as null (template default), never as a 503. */
function validOrNull(schema: { safeParse(value: unknown): { success: true; data: string } | { success: false } }, value: string | null): string | null {
  if (value === null) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function publicSettings(row: RuntimeRow, includeSiteText = false): PublicSettings {
  return BrandSettingsResponse.parse({
    flow_gate_mode: row.flow_gate_mode, paused: row.paused === 1,
    amount_buckets: JSON.parse(row.amount_buckets),
    ab_config: row.ab_config_json === null ? null : JSON.parse(row.ab_config_json),
    keyword_default: row.keyword_default, form_route: row.form_route,
    // Old brand runtimes parse this response strictly: add site text only when asked.
    ...(includeSiteText ? {
      brand_name: validOrNull(SiteBrandName, row.brand_name),
      site_title: validOrNull(SiteTitle, row.site_title),
      site_description: validOrNull(SiteDescription, row.site_description),
    } : {}),
  });
}
```

Keep `ownsHostname` and `randomToken` unchanged.

In `workers/core/src/rpc/index.ts` replace the `brandSettings` case with:

```ts
        case "brandSettings": return json(publicSettings(brand, (parsed.data as LeadsRpcRequest<"brandSettings">).include_site_text === true));
```

In `workers/core/src/admin/index.ts`:
- add to `interface BrandRow` after `keyword_default`: `brand_name: string | null; site_title: string | null; site_description: string | null;`
- in `brandConfig`, after `keyword_default: row.keyword_default,`: `brand_name: row.brand_name, site_title: row.site_title, site_description: row.site_description,`
- in `brandColumns`, change `"keyword_default", "created_at", "updated_at",` to `"keyword_default", "brand_name", "site_title", "site_description", "created_at", "updated_at",`
- in `patchBrand`'s `candidates`, after the `keyword_default` entry:

```ts
    ["brand_name", "brand_name", patch.brand_name, before.brand_name, patch.brand_name],
    ["site_title", "site_title", patch.site_title, before.site_title, patch.site_title],
    ["site_description", "site_description", patch.site_description, before.site_description, patch.site_description],
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/leads-db && bun run test`, `cd packages/contracts && bun run test`, `cd workers/core && bun run test`, `cd apps/web && bun run test`.
Expected: PASS for all four (the brandSettings golden test still matches because the legacy request gets the old shape).

- [ ] **Step 6: Typecheck and commit**

Run: `bun run typecheck` at the repo root. Expected: PASS.

```bash
git add packages/leads-db packages/contracts workers/core apps/web/src/server/mock-core.ts apps/web/test/lifecycle.ui.test.tsx
git commit -F - <<'EOF'
feat(core): per-brand site text in brand_runtime, admin patch and live settings (FUS-345)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 13: Text defaults in brand revisions and the site text defaults API

**Files:**
- Modify: `packages/contracts/src/site-text.ts` (append `withTextDefaults`, `SiteTextDefaultsResponse`), `packages/contracts/test/site-text.test.ts`
- Modify: `workers/factory/src/workflows/upgrade-all.ts` (`create_revisions` step), `workers/factory/test/workflows.test.ts`
- Modify: `apps/web/src/server/lifecycle.ts` (`createDraft`), `apps/web/src/server/templates.ts` (site text route)
- Test: `apps/web/test/site-text-api.test.ts` (create)

**Interfaces:**
- Consumes: Task 4 `template_versions.text_defaults_json`; Task 3 `TemplateTextDefaults`; Task 12 `BrandPatchRequest` site text fields.
- Produces:
  - `withTextDefaults(configJson: string, textDefaultsJson: string | null): string` (sets `config.text_defaults` to the valid defaults, or removes the key)
  - `SiteTextDefaultsResponse` (`{ brand_id: string; defaults: TemplateTextDefaults | null }`)
  - `GET /api/brands/:id/site-text` (employee+) -> `SiteTextDefaultsResponse`, read from the brand's current revision (or its latest revision before the first install).
  - Revisions created by draft creation and by Upgrade-all carry `config_json.text_defaults` of their template version. Rollback restores the older revision's own value; redeploy copies the current revision.

- [ ] **Step 1: Write the failing tests**

Append to `packages/contracts/test/site-text.test.ts` (add `withTextDefaults` to the import):

```ts
describe("withTextDefaults", () => {
  const defaults = { brand_name: "Harbor", title: "Harbor | Funding", description: null };
  it("sets valid defaults and replaces earlier ones", () => {
    expect(JSON.parse(withTextDefaults('{"keyword_default":"Quick Loan","text_defaults":{"brand_name":"Old","title":null,"description":null}}', JSON.stringify(defaults))))
      .toEqual({ keyword_default: "Quick Loan", text_defaults: defaults });
  });
  it("drops missing or invalid defaults", () => {
    expect(JSON.parse(withTextDefaults('{"keyword_default":"Quick Loan","text_defaults":{"brand_name":"Old","title":null,"description":null}}', null))).toEqual({ keyword_default: "Quick Loan" });
    expect(JSON.parse(withTextDefaults("{}", '{"brand_name":"Personal Loans","title":null,"description":null}'))).toEqual({});
    expect(JSON.parse(withTextDefaults("{}", "not json"))).toEqual({});
  });
});
```

Add to `workers/factory/test/workflows.test.ts`, inside the same `describe` as the `canary %s` test, modelled on it:

```ts
  it("copies the target template's text defaults into the upgrade revision", async () => {
    const f = await fixture(true);
    await env.FACTORY.prepare("DELETE FROM installs WHERE install_id=?").bind(f.install).run();
    const target = `target-text-${f.id}`;
    const defaults = { brand_name: "Copperline", title: "Copperline | Funding Options", description: "Check your funding options." };
    await env.FACTORY.prepare("INSERT INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_at,created_by,created_at,text_defaults_json) VALUES (?,?,3,?,?,'sealed',?,'owner',?,?)")
      .bind(target, f.template, target, `${f.id}/site.zip`, now, now, JSON.stringify(defaults)).run();
    f.bindings.INSTALL_WORKFLOW = { create: vi.fn(async ({ params }: { params: InstallParams }) => {
      await env.FACTORY.prepare("UPDATE installs SET status='ready' WHERE install_id=?").bind(params.install_id).run();
      await env.FACTORY.prepare("INSERT INTO install_receipts (install_id,step,status,output_json,created_at) VALUES (?,'sync_runtime','ok','{}',?)").bind(params.install_id, now).run();
      return { id: params.install_id };
    }) } as unknown as Workflow;
    const params: UpgradeAllParams = { from_template_version_id: f.version, to_template_version_id: target, form_artifact_id: f.artifact, canary_brand_id: f.brand, started_by: "owner", started_role: "owner" };
    await UpgradeAllWorkflow.prototype.run.call({ env: f.bindings } as unknown as UpgradeAllWorkflow, event(params), steps().step);
    const revision = await env.FACTORY.prepare("SELECT config_json FROM brand_revisions WHERE brand_id=? AND template_version_id=?").bind(f.brand, target).first<{ config_json: string }>();
    expect(JSON.parse(revision!.config_json).text_defaults).toEqual(defaults);
  });
```

Create `apps/web/test/site-text-api.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, resetState, sessions, setupDatabases } from "./helpers";

const NOW = "2026-10-17T00:00:00.000Z";
const DEFAULTS = { brand_name: "Copperline", title: "Copperline | Funding Options", description: "Check your funding options." };
let employee: string;

beforeAll(setupDatabases);
beforeEach(async () => {
  resetState();
  employee = await sessions.employee();
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id, name, framework, created_by, created_at) VALUES ('tpl-text', 'Copperline', 'react_spa', 'bk_1', ?1)").bind(NOW),
    env.FACTORY.prepare(`INSERT OR IGNORE INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at, text_defaults_json)
      VALUES ('tv-text', 'tpl-text', 1, ?1, 'templates/tpl-text/a.zip', 'sealed', 'owner', ?2, 'bk_1', ?2, ?3)`).bind("d".repeat(64), NOW, JSON.stringify(DEFAULTS)),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id, git_sha, r2_key, manifest_sha256, payload_version, bundle_form_version, created_at) VALUES ('fa-text', 'abcdef9', 'forms/fa-text', 'manifest', '2026-01', 'form@abcdef9', ?1)").bind(NOW),
  ]);
});

describe("site text defaults", () => {
  it("copies the template's text defaults into the first revision and serves them", async () => {
    const draft = await call("/api/brands/drafts", { cookie: employee, method: "POST", body: { domain: "copperline.test", keyword_default: "Quick Loan", template_version_id: "tv-text" } });
    expect(draft.status).toBe(201);
    const { brand } = (await draft.json()) as { brand: { brand_id: string } };
    const revision = await env.FACTORY.prepare("SELECT config_json FROM brand_revisions WHERE brand_id = ?1").bind(brand.brand_id).first<{ config_json: string }>();
    expect(JSON.parse(revision!.config_json)).toEqual({ keyword_default: "Quick Loan", text_defaults: DEFAULTS });
    const response = await call(`/api/brands/${brand.brand_id}/site-text`, { cookie: employee });
    expect([response.status, await response.json()]).toEqual([200, { brand_id: brand.brand_id, defaults: DEFAULTS }]);
  });

  it("answers null defaults for a brand the factory does not know, and 401 without a session", async () => {
    expect(await (await call("/api/brands/brand-a/site-text", { cookie: employee })).json()).toEqual({ brand_id: "brand-a", defaults: null });
    expect((await call("/api/brands/brand-a/site-text")).status).toBe(401);
  });

  it("saves site text through the brand PATCH and validates it", async () => {
    const ok = await call("/api/brands/brand-a", { cookie: employee, method: "PATCH", body: { site_title: "Brand A | Options" } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { brand: { site_title: string } }).brand.site_title).toBe("Brand A | Options");
    for (const body of [{ site_description: "Personal loans now" }, { brand_name: "x".repeat(81) }, { site_title: 'Say "hi"' }]) {
      expect((await call("/api/brands/brand-a", { cookie: employee, method: "PATCH", body })).status, JSON.stringify(body)).toBe(422);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/contracts && bun run test -- test/site-text.test.ts`
Expected: FAIL: `withTextDefaults is not a function`.

Run: `cd workers/factory && bun run test -- test/workflows.test.ts`
Expected: FAIL: `text_defaults` is undefined in the upgrade revision.

Run: `cd apps/web && bun run test -- test/site-text-api.test.ts`
Expected: FAIL: the revision `config_json` lacks `text_defaults`, and `/api/brands/:id/site-text` returns 404.

- [ ] **Step 3: Implement**

Append to `packages/contracts/src/site-text.ts`:

```ts
/**
 * A brand revision's config_json with the template version's text defaults: the fallback the brand
 * Worker serves when core is unreachable. Missing or invalid defaults remove the key.
 */
export function withTextDefaults(configJson: string, textDefaultsJson: string | null): string {
  const config = JSON.parse(configJson) as Record<string, unknown>;
  delete config.text_defaults;
  if (textDefaultsJson) {
    try {
      const parsed = TemplateTextDefaults.safeParse(JSON.parse(textDefaultsJson));
      if (parsed.success) config.text_defaults = parsed.data;
    } catch {
      /* invalid JSON: no defaults */
    }
  }
  return JSON.stringify(config);
}

export const SiteTextDefaultsResponse = z.strictObject({
  brand_id: z.string().min(1).max(128),
  defaults: TemplateTextDefaults.nullable(),
});
export type SiteTextDefaultsResponse = z.infer<typeof SiteTextDefaultsResponse>;
```

In `workers/factory/src/workflows/upgrade-all.ts` add `withTextDefaults` to the imports from `@anjuna/contracts` (add `import { withTextDefaults } from "@anjuna/contracts";` if the file has no contracts import), and in the `create_revisions` step read the target once before the loop and use it in the INSERT:

```ts
    const { revision_map } = await step.do("create_revisions", async () => {
      const target = await db.prepare("SELECT text_defaults_json FROM template_versions WHERE template_version_id = ?")
        .bind(params.to_template_version_id).first<{ text_defaults_json: string | null }>();
      const entries: Array<{ brand_id: string; revision_id: string }> = [];
      for (const brand_id of brand_ids) {
        const current = await db.prepare("SELECT revision, config_json FROM brand_revisions WHERE brand_id = ? ORDER BY revision DESC LIMIT 1").bind(brand_id).first<{ revision: number; config_json: string }>();
        if (!current) throw new Error(`Current revision not found for ${brand_id}`);
        const revision_id = await upgradeRevisionId(params.from_template_version_id, params.to_template_version_id, params.form_artifact_id, brand_id, params.started_by, params.started_role, params.canary_brand_id);
        await db.prepare(
          `INSERT OR IGNORE INTO brand_revisions (revision_id, brand_id, revision, template_version_id, form_artifact_id, config_json, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(revision_id, brand_id, current.revision + 1, params.to_template_version_id, params.form_artifact_id,
          withTextDefaults(current.config_json, target?.text_defaults_json ?? null), params.started_by, now).run();
        entries.push({ brand_id, revision_id });
      }
      return { revision_map: Object.fromEntries(entries.map((entry) => [entry.brand_id, entry.revision_id])) };
    });
```

In `apps/web/src/server/lifecycle.ts` add `withTextDefaults` to the `@anjuna/contracts` import, and in `createDraft` replace the template lookup and the `config` line:

```ts
  const template = await env.FACTORY.prepare("SELECT template_version_id, text_defaults_json FROM template_versions WHERE template_version_id = ?1 AND status = 'sealed'")
    .bind(template_version_id).first<{ template_version_id: string; text_defaults_json: string | null }>();
```

```ts
  const config = withTextDefaults(JSON.stringify({ keyword_default }), template.text_defaults_json);
```

In `apps/web/src/server/templates.ts` add `SiteTextDefaultsResponse` and `authorize` to the `@anjuna/contracts` import and add before the final `return undefined;`:

```ts
  m = path.match(/^\/api\/brands\/([^/]+)\/site-text$/);
  if (m && method === "GET") {
    if (!authorize("getBrand", ctx.actor_role).ok) return forbidden("employee");
    const brandId = decodePathSegment(m[1]!);
    if (brandId === null) return notFound("brand");
    // The deployed revision's defaults; before the first install, the latest revision's.
    const row = await env.FACTORY.prepare(
      `SELECT r.config_json FROM brands b JOIN brand_revisions r ON r.revision_id = COALESCE(b.current_revision_id,
         (SELECT revision_id FROM brand_revisions WHERE brand_id = b.brand_id ORDER BY revision DESC LIMIT 1))
       WHERE b.brand_id = ?1`,
    ).bind(brandId).first<{ config_json: string }>();
    const stored = row ? (parseJson(row.config_json) as { text_defaults?: unknown } | null)?.text_defaults ?? null : null;
    const defaults = TemplateTextDefaults.safeParse(stored);
    return json(200, SiteTextDefaultsResponse.parse({ brand_id: brandId, defaults: defaults.success ? defaults.data : null }));
  }
```

`TemplateTextDefaults.safeParse(null)` fails, so a revision without defaults returns `defaults: null`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/contracts && bun run test`, `cd workers/factory && bun run test`, `cd apps/web && bun run test`.
Expected: PASS for all three.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck` at the repo root. Expected: PASS.

```bash
git add packages/contracts workers/factory apps/web/src/server apps/web/test/site-text-api.test.ts
git commit -F - <<'EOF'
feat(factory): bake template text defaults into brand revisions (FUS-345)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 14: Brand Worker writes the site text

**Files:**
- Create: `packages/brand-runtime/src/site-text.ts`
- Modify: `packages/brand-runtime/src/config.ts` (`BrandSettings` fields)
- Modify: `packages/brand-runtime/src/settings-cache.ts` (request flag)
- Modify: `packages/brand-runtime/src/worker.ts` (`serveHtml`, `handle`)
- Test: `packages/brand-runtime/test/site-text.test.ts` (create), `packages/brand-runtime/test/worker.test.ts` (one expectation)

**Interfaces:**
- Consumes: Task 3 `TemplateTextDefaults`, `SiteBrandName`, `SiteTitle`, `SiteDescription`; Task 12 `include_site_text` and the three response fields; Task 13 `config_json.text_defaults` (reaches `BRAND_CONFIG` through `assembleBrandConfig`, which spreads the revision config).
- Produces:
  - `BrandSettings` gains `text_defaults: TemplateTextDefaults | null`, `brand_name`, `site_title`, `site_description` (`string | null`); each falls back to null on an invalid value, so a bad baked value never stops the Worker.
  - `interface EffectiveSiteText { brand: string; title: string | null; description: string | null; templateBrand: string | null }`
  - `effectiveSiteText(settings: BrandSettings): EffectiveSiteText` (brand: dashboard value, else template default, else `settings.brand`)
  - `applySiteText(rewriter: HTMLRewriter, text: EffectiveSiteText, page: "index" | "other"): HTMLRewriter`
  - `cfg.brand` and the `x-consent-brand` value equal `EffectiveSiteText.brand`.

- [ ] **Step 1: Write the failing tests**

Create `packages/brand-runtime/test/site-text.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import leadFixture from "../../contracts/fixtures/form/lead.lite_v1.json";
import settingsFixture from "../../contracts/fixtures/rpc/brandSettings.response.json";
import { createBrandWorker, type BrandWorkerConfig } from "../src/index.js";
import { MockCoreClient } from "../src/testing.js";
import { cfg, HANDOFF } from "./helpers.js";

const INDEX = '<!doctype html><html><head><title>Harbor | Funding Options</title><meta name="description" content="Harbor helps you compare."><meta property="og:title" content="Harbor | Funding Options"><meta property="og:description" content="Harbor helps you compare."></head><body><header><a href="/" data-brand>Harbor</a></header><h1><span data-kw>Funding Options</span></h1><form data-cta method="get" action="/go"><input name="zip"></form><footer><span data-brand>Harbor</span></footer></body></html>';
const PRIVACY = '<!doctype html><html><head><title>Privacy Policy | Harbor &amp; Co</title><meta name="description" content="How Harbor uses data."></head><body><a href="/" data-brand>Harbor</a></body></html>';
const FORM = '<!doctype html><html><head><title>Request</title></head><body><span data-brand>Harbor</span><script type="application/json" id="cfg">{}</script></body></html>';
const DEFAULTS = { brand_name: "Harbor", title: "Harbor | Funding Options", description: "Harbor helps you compare." };

function site(overrides: Partial<BrandWorkerConfig> = {}) {
  const core = new MockCoreClient();
  const pages: Record<string, string> = { "/index.html": INDEX, "/privacy/index.html": PRIVACY, "/_f/index.html": FORM };
  const assets = { fetch: vi.fn(async (request: Request) => {
    const body = pages[new URL(request.url).pathname];
    return body ? new Response(body, { headers: { "content-type": "text/html" } }) : new Response("missing", { status: 404 });
  }) };
  const worker = createBrandWorker({
    brand_id: "brand-a", hostname: "brand-a.example", brand: "Brand A", formRoute: "/request",
    amount_buckets: [500, 750, 1000, 1750, 5000], text_defaults: DEFAULTS, core, assets, ...overrides,
  });
  return { core, get: (path: string, init?: RequestInit) => worker.fetch(new Request(`https://brand-a.example${path}`, init)) };
}
const live = (text: Record<string, string | null>) => ({ ...structuredClone(settingsFixture), flow_gate_mode: "param" as const, ...text });

afterEach(() => vi.restoreAllMocks());

describe("site text", () => {
  it("serves the template defaults when nothing was edited", async () => {
    const html = await (await site().get("/")).text();
    expect(html).toContain("<title>Harbor | Funding Options</title>");
    expect(html).toContain('<a href="/" data-brand>Harbor</a>');
  });

  it("writes edited title, description and og tags on the index page", async () => {
    const { get, core } = site();
    core.settings = live({ brand_name: "Quick Funds", site_title: "Quick Funds | Check Options", site_description: "Fast & fair options." });
    const html = await (await get("/")).text();
    expect(html).toContain("<title>Quick Funds | Check Options</title>");
    expect(html).toContain('<meta name="description" content="Fast &amp; fair options.">');
    expect(html).toContain('<meta property="og:title" content="Quick Funds | Check Options">');
    expect(html).toContain('<meta property="og:description" content="Fast &amp; fair options.">');
    expect(html).toContain('<a href="/" data-brand>Quick Funds</a>');
    expect(html).toContain("<footer><span data-brand>Quick Funds</span></footer>");
    expect(html).not.toContain("Harbor");
  });

  it("replaces only the brand name in other pages' titles and keeps their descriptions", async () => {
    const { get, core } = site();
    core.settings = live({ brand_name: "Quick Funds", site_title: null, site_description: null });
    const html = await (await get("/privacy")).text();
    expect(html).toContain("<title>Privacy Policy | Quick Funds &amp; Co</title>");
    expect(html).toContain('<meta name="description" content="How Harbor uses data.">');
    expect(html).toContain('<a href="/" data-brand>Quick Funds</a>');
  });

  it("uses one brand name for the page, cfg.brand and the consent header", async () => {
    const { get, core } = site();
    core.settings = live({ brand_name: "Quick Funds", site_title: null, site_description: null });
    const form = await get(`/request?${HANDOFF}`);
    const body = await form.clone().text();
    expect((await cfg(form)).brand).toBe("Quick Funds");
    expect(body).toContain("<span data-brand>Quick Funds</span>");
    const submit = vi.spyOn(core, "submitLead");
    await get("/api/leads", { method: "POST", body: JSON.stringify(leadFixture) });
    expect(submit).toHaveBeenCalledWith(expect.anything(), { consent_brand: "Quick Funds" });
  });

  it("asks core for site text and serves the baked defaults when core is unreachable", async () => {
    const { get, core } = site();
    core.failure = new Error("core down");
    expect(await (await get("/")).text()).toContain("<title>Harbor | Funding Options</title>");
    expect(core.calls.brandSettings).toEqual([{ brand_id: "brand-a", include_site_text: true }]);
  });

  it("shows an edit within the 60 second settings TTL", async () => {
    const { get, core } = site();
    core.settings = live({ brand_name: null, site_title: "First Title", site_description: null });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    expect(await (await get("/")).text()).toContain("<title>First Title</title>");
    core.settings = live({ brand_name: null, site_title: "Second Title", site_description: null });
    clock.mockReturnValue(1_060_000);
    expect(await (await get("/")).text()).toContain("<title>Second Title</title>");
  });

  it("serves identical HTML to every visitor", async () => {
    const { get, core } = site();
    core.settings = live({ brand_name: "Quick Funds", site_title: null, site_description: null });
    const bodies = new Set<string>();
    for (const headers of [{ "user-agent": "Mozilla/5.0" }, { "user-agent": "AdsBot-Google", "cf-connecting-ip": "66.249.66.1" }, { referer: "https://www.google.com/" }]) {
      bodies.add(await (await get("/", { headers })).text());
    }
    expect(bodies.size).toBe(1);
  });

  it("keeps serving with the factory brand name when baked text defaults are invalid or missing", async () => {
    const bad = site({ text_defaults: { brand_name: "Personal Loans Inc", title: "x", description: null } as never });
    expect(await (await bad.get("/")).text()).toContain('<a href="/" data-brand>Brand A</a>');
    const none = site({ text_defaults: undefined });
    expect(await (await none.get("/")).text()).toContain('<a href="/" data-brand>Brand A</a>');
  });
});
```

In `packages/brand-runtime/test/worker.test.ts` replace `expect(core.calls.brandSettings).toEqual([{ brand_id: "brand-a" }]);` with:

```ts
    expect(core.calls.brandSettings).toEqual([{ brand_id: "brand-a", include_site_text: true }]);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/brand-runtime && bun run test -- test/site-text.test.ts test/worker.test.ts`
Expected: FAIL: the edited title is not written, and `calls.brandSettings` lacks `include_site_text`.

- [ ] **Step 3: Implement**

In `packages/brand-runtime/src/config.ts` add `SiteBrandName, SiteDescription, SiteTitle, TemplateTextDefaults` to the `@anjuna/contracts` import and add to the `BrandSettings` object after `keyword_default`:

```ts
  /** Template defaults baked into the revision (factory config_json.text_defaults). Invalid values become null. */
  text_defaults: TemplateTextDefaults.nullable().default(null).catch(null),
  /** Dashboard site text from core live settings. Null = template default. */
  brand_name: SiteBrandName.nullable().default(null).catch(null),
  site_title: SiteTitle.nullable().default(null).catch(null),
  site_description: SiteDescription.nullable().default(null).catch(null),
```

In `packages/brand-runtime/src/settings-cache.ts` replace the core call with:

```ts
          const result = await withCoreTimeout(() => config.core.brandSettings({ brand_id: fallback.brand_id, include_site_text: true }), config.coreTimeoutMs);
```

Create `packages/brand-runtime/src/site-text.ts`:

```ts
/**
 * Site text the brand Worker writes into every page. Values come from core's live settings (dashboard
 * edits), then the revision's baked template defaults. Output depends only on settings, never on the visitor.
 */
import type { BrandSettings } from "./config.js";

export interface EffectiveSiteText {
  /** [data-brand] text, cfg.brand and the consent header: dashboard value, else template default, else the factory brand name. */
  brand: string;
  title: string | null;
  description: string | null;
  /** The template's own brand name, replaced inside other pages' <title>. */
  templateBrand: string | null;
}

export function effectiveSiteText(settings: BrandSettings): EffectiveSiteText {
  const defaults = settings.text_defaults;
  return {
    brand: settings.brand_name ?? defaults?.brand_name ?? settings.brand,
    title: settings.site_title ?? defaults?.title ?? null,
    description: settings.site_description ?? defaults?.description ?? null,
    templateBrand: defaults?.brand_name ?? null,
  };
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'" };
const decodeBasicEntities = (text: string) => text.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (entity) => ENTITIES[entity]!);
/** lol-html escapes the double quote in attribute values; the ampersand is escaped here. Values never contain < > " (contract). */
const attributeValue = (value: string) => value.replace(/&/g, "&amp;");

export function applySiteText(rewriter: HTMLRewriter, text: EffectiveSiteText, page: "index" | "other"): HTMLRewriter {
  let next = rewriter.on("[data-brand]", { element(element) { element.setInnerContent(text.brand); } });
  if (page === "index") {
    const { title, description } = text;
    if (title !== null) {
      next = next
        .on("title", { element(element) { element.setInnerContent(title); } })
        .on('meta[property="og:title"]', { element(element) { element.setAttribute("content", attributeValue(title)); } });
    }
    if (description !== null) {
      next = next
        .on('meta[name="description"]', { element(element) { element.setAttribute("content", attributeValue(description)); } })
        .on('meta[property="og:description"]', { element(element) { element.setAttribute("content", attributeValue(description)); } });
    }
    return next;
  }
  const from = text.templateBrand;
  if (!from || from === text.brand) return next;
  // <title> text can arrive in several chunks: collect them, then write the replaced text once.
  let buffer = "";
  return next.on("title", { text(chunk) {
    buffer += chunk.text;
    if (!chunk.lastInTextNode) {
      chunk.remove();
      return;
    }
    const decoded = decodeBasicEntities(buffer);
    if (decoded.includes(from)) chunk.replace(decoded.split(from).join(text.brand));
    else chunk.replace(buffer, { html: true });
    buffer = "";
  } });
}
```

In `packages/brand-runtime/src/worker.ts`:
- add `import { applySiteText, effectiveSiteText, type EffectiveSiteText } from "./site-text.js";`
- change the `serveHtml` signature and add the site text handlers after the `[data-kw]` handler:

```ts
async function serveHtml(url: URL, config: BrandWorkerConfig, assetPath: string, keyword: string | null,
  extra: { cfg?: RuntimeConfig; cta?: ClickParams; site?: { text: EffectiveSiteText; page: "index" | "other" } } = {}): Promise<Response> {
```

```ts
  if (extra.site) rewriter = applySiteText(rewriter, extra.site.text, extra.site.page);
```

- in `handle`, after the `if (staticAsset) { ... }` block, add:

```ts
  const site = effectiveSiteText(settings);
```

- replace the legal page line with:

```ts
  if (legal) return serveHtml(url, config, `${legal}/index.html`, null, { site: { text: site, page: "other" } });
```

- replace the `/` call with:

```ts
      serveHtml(url, config, "/index.html", keyword, { cta: adParams(url), site: { text: site, page: "index" } }),
```

- replace the form page call with:

```ts
    return finish(await serveHtml(url, config, "/_f/index.html", keyword, {
      cfg: { brand: site.brand, amount: handoff.amount, zip: handoff.zip, keyword,
        formRoute: settings.formRoute, variant: assignment.variant, proxies: settings.proxies },
      site: { text: site, page: "other" },
    }));
```

- in the `/api/leads` branch replace `{ consent_brand: settings.brand,` with `{ consent_brand: site.brand,`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/brand-runtime && bun run test`
Expected: PASS, including the existing consent test (`consent_brand: "Brand A"`: no defaults and no edits).

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck` at the repo root. Expected: PASS.

```bash
git add packages/brand-runtime
git commit -F - <<'EOF'
feat(brand-runtime): write brand name, title and description into every page (FUS-345)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 15: Site text card in the brand config panel

**Files:**
- Modify: `apps/web/src/client/screens/ConfigPanel.tsx` (load defaults, `SiteTextSection`)
- Modify: `apps/web/src/client/api.ts` (`siteTextDefaults`), `apps/web/src/client/styles.css` (preview rules)
- Modify: `apps/web/test/lifecycle.ui.test.tsx` (one route)
- Test: `apps/web/test/site-text.ui.test.tsx` (create)

**Interfaces:**
- Consumes: Task 12 `BrandConfig` site text fields and the `site_text` field group; Task 13 `GET /api/brands/:id/site-text`; Task 3 `SITE_TEXT_LIMITS`, `SiteBrandName`, `SiteTitle`, `SiteDescription`, `TemplateTextDefaults`.
- Produces: `api.siteTextDefaults(brandId: string): Promise<SiteTextDefaultsResponse>`; `SiteTextSection` in `ConfigPanel` (shown when `roleAtLeast(me.role, BRAND_PATCH_FIELD_GROUPS.site_text.min_role)`), which saves through `api.patchBrand` with `brand_name`, `site_title`, `site_description` (null = back to template).

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/site-text.ui.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import brandFixture from "@anjuna/contracts/fixtures/admin/brand.get.response.json";
import { ConfigPanel } from "../src/client/screens/ConfigPanel";

const employee = { id: "employee", email: "emp1@example.test", role: "employee" as const };
const DEFAULTS = { brand_name: "Copperline", title: "Copperline | Funding Options", description: "Check your funding options." };
const brand = { ...brandFixture.brand, brand_name: null, site_title: "Edited Title", site_description: null };
let patches: unknown[];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  patches = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && input === "/api/brands/brand-a") return json({ brand });
    if (method === "GET" && input === "/api/brands/brand-a/site-text") return json({ brand_id: "brand-a", defaults: DEFAULTS });
    if (method === "PATCH" && input === "/api/brands/brand-a") {
      patches.push(JSON.parse(String(init!.body)));
      return json({ brand, changed: ["site_title"], audit_id: 1 });
    }
    throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("Site text card", () => {
  it("prefills from the template, marks edited fields and counts characters", async () => {
    render(<ConfigPanel me={employee} brandId="brand-a" onClose={() => {}} onChanged={() => {}} />);
    await waitFor(() => expect(field("ชื่อแบรนด์ (Brand name)").value).toBe("Copperline"));
    expect(field("ชื่อหน้า (Page title)").value).toBe("Edited Title");
    expect(screen.getAllByText("จากเทมเพลต (From template)")).toHaveLength(2);
    expect(screen.getAllByText("แก้ไขแล้ว (Edited)")).toHaveLength(1);
    expect(screen.getByText("12/70")).toBeTruthy();
    expect(screen.getByLabelText("แท็บเบราว์เซอร์ (Browser tab)").textContent).toBe("Edited Title");
  });

  it("resets a field to the template and saves null for it", async () => {
    render(<ConfigPanel me={employee} brandId="brand-a" onClose={() => {}} onChanged={() => {}} />);
    await waitFor(() => expect(field("ชื่อหน้า (Page title)").value).toBe("Edited Title"));
    fireEvent.click(screen.getByRole("button", { name: "รีเซ็ต ชื่อหน้า (Page title) (Reset to template)" }));
    expect(field("ชื่อหน้า (Page title)").value).toBe(DEFAULTS.title);
    fireEvent.click(screen.getByRole("button", { name: "บันทึกข้อความหน้าเว็บ (Save site text)" }));
    await waitFor(() => expect(patches).toEqual([{ site_title: null, expected_updated_at: brand.updated_at }]));
  });

  it("blocks saving text with markup characters or banned wording", async () => {
    render(<ConfigPanel me={employee} brandId="brand-a" onClose={() => {}} onChanged={() => {}} />);
    await waitFor(() => expect(field("คำอธิบาย (Meta description)").value).toBe(DEFAULTS.description));
    fireEvent.change(field("คำอธิบาย (Meta description)"), { target: { value: "Personal loans <today>" } });
    expect((screen.getByRole("button", { name: "บันทึกข้อความหน้าเว็บ (Save site text)" }) as HTMLButtonElement).disabled).toBe(true);
    expect(patches).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && bun run test -- test/site-text.ui.test.tsx`
Expected: FAIL: "Unable to find a label with the text of: ชื่อแบรนด์ (Brand name)".

- [ ] **Step 3: Implement**

In `apps/web/src/client/api.ts` add `SiteTextDefaultsResponse` to the value import from `@anjuna/contracts` and add to `api`:

```ts
  siteTextDefaults: (brandId: string) => request<unknown>("GET", `/api/brands/${encodeURIComponent(brandId)}/site-text`).then((body) => SiteTextDefaultsResponse.parse(body)),
```

In `apps/web/src/client/screens/ConfigPanel.tsx`, change the contracts import to:

```tsx
import {
  BRAND_PATCH_FIELD_GROUPS, SITE_TEXT_LIMITS, SiteBrandName, SiteDescription, SiteTitle, roleAtLeast,
  type BrandConfig, type BrandPatchRequest, type FlowGateMode, type TemplateTextDefaults,
} from "@anjuna/contracts";
```

Inside `ConfigPanel`, after the `issuedToken` state, add:

```tsx
  const [defaults, setDefaults] = useState<TemplateTextDefaults | null>(null);
  useEffect(() => { void api.siteTextDefaults(brandId).then((r) => setDefaults(r.defaults), () => setDefaults(null)); }, [brandId]);
```

After `<KeywordSection ... />` add:

```tsx
      {can(me, "site_text") && (
        <SiteTextSection key={`s${brand.updated_at}${defaults ? "d" : ""}`} brand={brand} defaults={defaults}
          onSave={(patch) => save(patch, "บันทึกข้อความหน้าเว็บแล้ว (Site text saved)")} />
      )}
```

Append to the same file:

```tsx
type SiteField = "brand_name" | "site_title" | "site_description";
const SITE_FIELDS: Array<{ field: SiteField; source: keyof TemplateTextDefaults; label: string; max: number; schema: typeof SiteTitle }> = [
  { field: "brand_name", source: "brand_name", label: "ชื่อแบรนด์ (Brand name)", max: SITE_TEXT_LIMITS.brand_name, schema: SiteBrandName },
  { field: "site_title", source: "title", label: "ชื่อหน้า (Page title)", max: SITE_TEXT_LIMITS.title, schema: SiteTitle },
  { field: "site_description", source: "description", label: "คำอธิบาย (Meta description)", max: SITE_TEXT_LIMITS.description, schema: SiteDescription },
];

/** Brand name, page title and meta description: template defaults, editable per brand. Empty or equal to the default saves null. */
function SiteTextSection({ brand, defaults, onSave }: { brand: BrandConfig; defaults: TemplateTextDefaults | null; onSave: (patch: BrandPatchRequest) => void }) {
  const fallback = (f: (typeof SITE_FIELDS)[number]) => defaults?.[f.source] ?? "";
  const [values, setValues] = useState<Record<SiteField, string>>(
    () => Object.fromEntries(SITE_FIELDS.map((f) => [f.field, brand[f.field] ?? fallback(f)])) as Record<SiteField, string>,
  );
  const edited = (f: (typeof SITE_FIELDS)[number]) => values[f.field].trim() !== "" && values[f.field].trim() !== fallback(f);
  const errors = SITE_FIELDS.map((f) => {
    const value = values[f.field].trim();
    if (!value) return null;
    const parsed = f.schema.safeParse(value);
    return parsed.success ? null : `${f.label}: ${parsed.error.issues[0]?.message ?? "invalid"}`;
  }).filter((e): e is string => e !== null);
  const patch: BrandPatchRequest = {};
  for (const f of SITE_FIELDS) {
    const next = edited(f) ? values[f.field].trim() : null;
    if (next !== brand[f.field]) patch[f.field] = next;
  }
  const changed = Object.keys(patch).length > 0;
  const shown = (field: SiteField) => values[field].trim() || "-";

  return (
    <Section title="ข้อความหน้าเว็บ (Site text)">
      {SITE_FIELDS.map((f) => (
        <div key={f.field} className="site-field">
          <div className="row split">
            <span>{f.label}</span>
            <span className="badge">{edited(f) ? "แก้ไขแล้ว (Edited)" : "จากเทมเพลต (From template)"}</span>
          </div>
          <input aria-label={f.label} value={values[f.field]} onChange={(e) => setValues({ ...values, [f.field]: e.target.value })} />
          <div className="row split small">
            <span className={values[f.field].trim().length > f.max ? "error" : "muted"}>{`${values[f.field].trim().length}/${f.max}`}</span>
            <button className="link" aria-label={`รีเซ็ต ${f.label} (Reset to template)`} onClick={() => setValues({ ...values, [f.field]: fallback(f) })}>
              รีเซ็ตเป็นค่าเทมเพลต (Reset to template)
            </button>
          </div>
        </div>
      ))}
      {errors.map((e) => <div key={e} className="error small">{e}</div>)}
      <div className="site-preview" aria-label="ตัวอย่าง (Preview)">
        <div className="preview-tab" aria-label="แท็บเบราว์เซอร์ (Browser tab)">{shown("site_title")}</div>
        <div className="preview-serp">
          <div className="muted small">{brand.hostnames[0]}</div>
          <div className="preview-serp-title">{shown("site_title")}</div>
          <div className="small">{shown("site_description")}</div>
        </div>
        <div className="preview-brand"><span className="muted small">Header / footer</span> <b>{shown("brand_name")}</b></div>
      </div>
      <button className="primary" disabled={!changed || errors.length > 0} onClick={() => onSave(patch)}>บันทึกข้อความหน้าเว็บ (Save site text)</button>
    </Section>
  );
}
```

In `apps/web/src/client/styles.css` append:

```css
.site-field { margin-bottom: 10px; } .site-field input { width: 100%; }
.site-preview { display: grid; gap: 8px; margin: 10px 0; }
.preview-tab { background: var(--bg); border: 1px solid var(--line); border-radius: 8px 8px 0 0; padding: 6px 10px; font-size: .8rem; max-width: 260px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.preview-serp { background: var(--bg); border-radius: 6px; padding: 10px; }
.preview-serp-title { color: var(--accent); font-size: 1.05rem; }
.preview-brand { padding: 6px 10px; border: 1px dashed var(--line); border-radius: 6px; }
```

In `apps/web/test/lifecycle.ui.test.tsx`, add to the initial `routes` map next to `["GET /api/brands/brand-a", ...]`:

```ts
    ["GET /api/brands/brand-a/site-text", () => json({ brand_id: "brand-a", defaults: null })],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && bun run test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck` at the repo root. Expected: PASS.

```bash
git add apps/web/src/client apps/web/test/site-text.ui.test.tsx apps/web/test/lifecycle.ui.test.tsx
git commit -F - <<'EOF'
feat(web): Site text card with template badges, counters, reset and preview (FUS-345)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 16: Template MCP for maimax and CI deploy

**Files:**
- Create: `workers/template-mcp/wrangler.maimax.jsonc`
- Modify: `.github/workflows/deploy.yml` (two steps per tenant job)
- Modify: `workers/template-mcp/README.md` (Deploy section)
- Test: `scripts/test/template-mcp-deploy.test.ts` (create)

**Interfaces:**
- Consumes: `tenants/aduplift.config.ts`, `tenants/maimax.config.ts` (`accountId`, `appDomain`, `d1.factory`, `name`); Task 5 `DASHBOARD_URL` var; Task 7 `TemplateImportService` (bound by anjuna-web, so the template MCP deploy must run before the web deploy).
- Produces: deploy steps `Deploy template MCP (<tenant>)` and `Smoke test template MCP (<tenant>)` in `deploy-aduplift` (always) and `deploy-maimax` (behind `MAIMAX_ENABLED`).

- [ ] **Step 1: Write the failing test**

Create `scripts/test/template-mcp-deploy.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import aduplift from "@anjuna/tenants/aduplift.config";
import maimax from "@anjuna/tenants/maimax.config";

const root = new URL("../../", import.meta.url);
const stripComments = (text: string) => text.replace(/^\s*\/\/.*$/gm, "");
const mcpConfig = (file: string) => JSON.parse(stripComments(readFileSync(new URL(`workers/template-mcp/${file}`, root), "utf8")));
const tenants = [
  { tenant: aduplift, file: "wrangler.jsonc" },
  { tenant: maimax, file: "wrangler.maimax.jsonc" },
];

describe("template MCP per tenant (no deployment)", () => {
  it.each(tenants)("$file targets its own account, factory D1 and domain", ({ tenant, file }) => {
    const config = mcpConfig(file);
    expect(config.name).toBe("anjuna-template-mcp");
    expect(config.account_id).toBe(tenant.accountId);
    expect(config.d1_databases).toEqual([expect.objectContaining({ binding: "FACTORY", database_name: `${tenant.name}-factory`, database_id: tenant.d1!.factory })]);
    expect(config.routes).toEqual([{ pattern: tenant.appDomain.replace(/^app\./, "mcp."), custom_domain: true }]);
    expect(config.vars.DASHBOARD_URL).toBe(`https://${tenant.appDomain}`);
    expect(config.workers_dev).toBe(false);
    expect(config.compatibility_flags).toContain("global_fetch_strictly_public");
    expect(config.durable_objects.bindings).toEqual([{ name: "MCP_OBJECT", class_name: "TemplateMcp" }]);
    expect(config.r2_buckets).toEqual([{ binding: "ARTIFACTS", bucket_name: "anjuna-artifacts" }]);
  });

  it("deploys the template MCP after migrations and before the web Worker in both tenant jobs", () => {
    const workflow = parseDocument(readFileSync(new URL(".github/workflows/deploy.yml", root), "utf8")).toJS() as {
      jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
    };
    for (const [tenant, file, host] of [["aduplift", "wrangler.jsonc", "mcp.aduplift.ai"], ["maimax", "wrangler.maimax.jsonc", "mcp.maimax.fit"]] as const) {
      const steps = workflow.jobs[`deploy-${tenant}`]!.steps;
      const names = steps.map((step) => step.name);
      const deploy = names.indexOf(`Deploy template MCP (${tenant})`);
      expect(deploy, tenant).toBeGreaterThan(names.indexOf(`Apply D1 migrations (${tenant})`));
      expect(deploy, tenant).toBeLessThan(names.indexOf(`Deploy web (${tenant})`));
      expect(steps[deploy]!.run?.trim()).toBe(`bun x wrangler deploy --config workers/template-mcp/${file}`);
      expect(steps[names.indexOf(`Smoke test template MCP (${tenant})`)]?.run).toContain(`https://${host}/health`);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd scripts && bun run test -- test/template-mcp-deploy.test.ts`
Expected: FAIL: "ENOENT ... wrangler.maimax.jsonc" and `expected -1 to be greater than ...`.

- [ ] **Step 3: Implement**

Create `workers/template-mcp/wrangler.maimax.jsonc` (no comments, so plain JSON tools can read it):

```json
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "anjuna-template-mcp",
  "main": "src/index.ts",
  "account_id": "c1a44deffd54a8ce35cb9e68abeb7b11",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["global_fetch_strictly_public", "nodejs_compat"],
  "workers_dev": false,
  "preview_urls": false,
  "routes": [{ "pattern": "mcp.maimax.fit", "custom_domain": true }],
  "d1_databases": [
    {
      "binding": "FACTORY",
      "database_name": "maimax-factory",
      "database_id": "4d83cd96-8a12-48aa-96a0-1f97c2028dcf",
      "migrations_dir": "../../packages/factory-db/migrations"
    }
  ],
  "r2_buckets": [{ "binding": "ARTIFACTS", "bucket_name": "anjuna-artifacts" }],
  "browser": { "binding": "BROWSER" },
  "durable_objects": { "bindings": [{ "name": "MCP_OBJECT", "class_name": "TemplateMcp" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["TemplateMcp"] }],
  "vars": { "RATE_LIMIT_PER_MINUTE": "60", "SIMILARITY_THRESHOLD": "0.5", "DASHBOARD_URL": "https://app.maimax.fit" }
}
```

In `.github/workflows/deploy.yml`, in `deploy-aduplift`, insert before `- name: Deploy web (aduplift)`:

```yaml
      - name: Deploy template MCP (aduplift)
        run: bun x wrangler deploy --config workers/template-mcp/wrangler.jsonc

      - name: Smoke test template MCP (aduplift)
        run: |
          STATUS=$(curl -s -o /dev/null -w "%{http_code}" https://mcp.aduplift.ai/health)
          test "$STATUS" = "200" || (echo "template MCP smoke test failed: got $STATUS"; exit 1)

```

In `deploy-maimax`, insert before `- name: Deploy web (maimax)`:

```yaml
      - name: Deploy template MCP (maimax)
        run: bun x wrangler deploy --config workers/template-mcp/wrangler.maimax.jsonc

      - name: Smoke test template MCP (maimax)
        run: |
          STATUS=$(curl -s -o /dev/null -w "%{http_code}" https://mcp.maimax.fit/health)
          test "$STATUS" = "200" || (echo "maimax template MCP smoke test failed: got $STATUS"; exit 1)

```

In `workers/template-mcp/README.md` replace the "Deploy (owner-gated, not done here)" section body with:

```markdown
CI deploys the template MCP on every `v*` tag, after the factory D1 migrations and before the web Worker (anjuna-web binds its `TemplateImportService` entrypoint):

- aduplift: `wrangler.jsonc`, Custom Domain `mcp.aduplift.ai`, D1 `aduplift-factory`.
- maimax: `wrangler.maimax.jsonc`, Custom Domain `mcp.maimax.fit`, D1 `maimax-factory`, only when the repo variable `MAIMAX_ENABLED` is `true`. Builder keys are per tenant because each tenant has its own factory D1. Maimax works only after its tenant setup (factory deploy, Access, R2 bucket, `MAIMAX_CORE_TOKEN`, `MAIMAX_CF_ACCESS_CLIENT_ID`, `MAIMAX_CF_ACCESS_CLIENT_SECRET`) is done.

Both jobs smoke-test `GET /health` for HTTP 200.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd scripts && bun run test`
Expected: PASS, including the existing "validates workflow YAML, shell syntax, tenant wiring" test (`bash -n` accepts the new steps).

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck` at the repo root. Expected: PASS.

```bash
git add workers/template-mcp/wrangler.maimax.jsonc workers/template-mcp/README.md .github/workflows/deploy.yml scripts/test/template-mcp-deploy.test.ts
git commit -F - <<'EOF'
ci: deploy the template MCP for aduplift and maimax before the web Worker (FUS-345)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 17: Live acceptance on aduplift (owner-assisted, no code)

Every step is an owner step. Record the evidence (command output, screenshots, URLs) in the PR description. No commit.

- [ ] **Step 1: Release.** Owner tags a release (`v*`). Expected: the Deploy workflow is green, including `Apply D1 migrations (aduplift)` (factory 0005 and 0006, leads 0011), `Deploy template MCP (aduplift)` and `Smoke test template MCP (aduplift)`.
- [ ] **Step 2: Builder key.** In the control panel, owner opens Builder keys, creates "Acceptance (bolt.new)", copies the key. Expected: the key shows once; the list shows "ยังไม่เคยใช้ (Never)".
- [ ] **Step 3: Connect bolt.new.** In bolt.new, add the custom MCP connector `https://mcp.aduplift.ai/mcp` with the key as API key. Expected: Builder keys shows a "last used" time within a minute.
- [ ] **Step 4: Publish and submit from chat.** In a bolt.new project, ask: "Read get_template_contract, build static HTML, publish the site, run probe_url on the published URL, then call submit_template_url." Expected: `probe_url` returns `ok: true`; `submit_template_url` returns `status: "awaiting_approval"` with a `dashboard_url`, or `rejected` with issues that the AI fixes and resubmits until `awaiting_approval`.
- [ ] **Step 5: SPA rejection.** Submit (or "Import from URL") a client-rendered page. Expected: `rejected` with "This site renders with JavaScript. Ask bolt.new to make it static HTML, then submit again."
- [ ] **Step 6: Approve.** Open the `dashboard_url`. Expected: the Templates screen opens the version with desktop and mobile screenshots, checks, text defaults, submitter "Acceptance (bolt.new)". Sign in as an employee: no Approve button, and `POST /api/templates/<id>/approve` returns 403 `forbidden_role`. As owner, click Approve. Expected: status "อนุมัติแล้ว (Approved)"; a second Approve returns "อนุมัติไว้แล้ว (Already approved)".
- [ ] **Step 7: Test brand.** Create a draft brand on a test domain from the approved version and install it. Expected: install `ready`; `curl -s https://<test-domain>/ | grep -o '<title>[^<]*</title>'` prints the template title.
- [ ] **Step 8: Edit site text.** In the brand's config panel, Site text card: set the page title to "Acceptance Brand | Check Your Options" and the brand name to "Acceptance Brand", Save. Expected within 60 s: the curl in step 7 prints the new title; `curl -s https://<test-domain>/privacy/ | grep -o '<title>[^<]*</title>'` shows "Acceptance Brand" in place of the template brand name; the form page `cfg.brand` is "Acceptance Brand".
- [ ] **Step 9: Revoke.** Revoke the key in Builder keys. Expected: the next bolt.new tool call fails with 401 and `wrangler tail anjuna-template-mcp` logs `auth_failure` with reason `revoked_api_key`.

