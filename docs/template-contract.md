# Landing template contract

This is the contract for anyone, human or AI builder (OpenDesign, Bolt.new, v0, Stitch or Magic Patterns exports), who makes a landing template for an Anjuna brand. Submission gates follow `packages/template-cert/src/policy.ts` (FUS-360). The guidance below also includes owner-review advisories; its **must** wording does not make every item a submission blocker.

The four blocking groups are clean brand bytes; no external scripts; a valid amount-and-ZIP CTA to `/go` plus a KeywordSlot inside H1; and all four legal pages. Archive validity, traversal and size/count limits, Personal Loan wording, server/non-static output, SSRF/import failures and template-name ownership remain safety blockers. Unknown check ids block.

Similarity/fingerprint findings, metadata, guarantee claims, PII advisories, non-script external resources and broken internal links are warnings. They are stored in certification details, returned on submit and duplicate, and shown in yellow in Templates detail. Import notices are stored separately. Missing or failed screenshots warn at submit; owner approval and seal still require passing desktop and mobile PNG evidence. Requirement IDs refer to `docs/PRODUCT-BRIEF.md` (TP-1, TP-2, BR-2, BR-4, BR-5).

Reference implementations:

- Astro: `packages/template-astro-starter` (recommended; start every new template from it).
- React (vinext / Next.js static export, Vite SPA): `packages/keyword-slot-react`.

## Render-time copy and legal data (FUS-361)

The factory exposes `fillCopy(draft, deps) -> Promise<{copy, issues}>` in
`workers/factory/src/copy-fill.ts`. The draft has `brand_name`, `keyword_default`,
and optional `copy: {h1, cta, sub}`. Only absent, null, empty or whitespace-only
fields are eligible for filling. Nonempty employee text is preserved byte for byte.
There is currently no AI binding. Without `deps.generate`, a deterministic template
supplies copy. An injected adapter receives only the brand name, default keyword,
keyword marker and requested fields; it returns an object with plain-text values.
Adapters must be called during installation/rendering, never per visitor.

`validateCopy(copy, keywordDefault)` is exported from `@anjuna/contracts` and returns
field/code/message issues. H1 must contain exactly one `{{keyword}}` token. This is
the plain-text representation of the existing KeywordSlot, not HTML from the AI.
Use `renderCopyH1(copy.h1, keyword_default)` for the single H1's inner HTML: it escapes
text and emits exactly one `<span data-kw>default keyword</span>`. Continue inserting
CTA and subheading as escaped text. Site title/description settings do not map to H1.
The existing runtime KeywordSlot handling remains unchanged.

Limits: H1 **140 visible characters** after default-keyword expansion, CTA **40**,
subheading **240**. All fields must be nonempty single-line plain text, without HTML,
control characters or double quotes. Only H1 accepts the keyword token. No other
placeholders, Personal Loan wording, platform names, generated brand IDs, analytics
keys or Sentry DSNs are accepted. Every proposed fill is validated together with the
employee's text. On any issue the entire proposed fill is discarded and the original
copy is returned. Adapter failure returns a readable issue; it does not silently use
the fallback. Callers must resolve issues before rendering or saving generated copy.

### Legal placeholders

`renderBrand(templateFiles, formFiles, brandId, revisionId, {brand_name, profile})`
fills explicit legal slots from the revision's `config_json.profile.contact` and
`.disclosures`. Pass the public brand/company display name as `brand_name`, never an
internal ID. The existing four-argument call remains valid and leaves every slot as the template wrote it.
The install caller owns loading this data; the renderer performs no database or network calls.

The starter currently has reviewed-copy placeholders rather than structured legal
slots. Builders opt in by replacing those placeholders with the following markup on
`terms/index.html` and `disclosures/index.html` (flat `terms.html` / `disclosures.html`
and leading `/` are also supported):

```html
<p>Service operator: <span data-legal="brand_name">Not provided.</span></p>
<p>Address: <span data-legal="contact.address">Not provided.</span></p>
<p>Email: <span data-legal="contact.email">Not provided.</span></p>
<p>Phone: <span data-legal="contact.phone">Not provided.</span></p>
<p>Maximum APR: <span data-legal="disclosures.apr_max">Not provided.</span></p>
<p>Repayment term: <span data-legal="disclosures.term_range">Not provided.</span></p>
<p>Representative example: <span data-legal="disclosures.representative_example">Not provided.</span></p>
<p>Unsupported states: <span data-legal="disclosures.unsupported_states">Not provided.</span></p>
```

Each placeholder must be a standalone `span` containing text only, with no nested
slots. Unknown keys and other element types fail rendering. Values are escaped text,
never HTML, URLs, attributes, scripts or CSS. No replacement occurs in other pages or
in legal pages without these slots. Reviewed surrounding legal wording remains intact.

| Slot | Rendered value |
|---|---|
| `brand_name` | Public company/brand display name supplied by the caller. |
| `contact.address`, `contact.email`, `contact.phone` | The corresponding profile text. |
| `disclosures.apr_max` | Supplied APR plus `%`; zero remains `0%`. |
| `disclosures.term_min_months`, `disclosures.term_max_months` | Supplied integer plus ` months`. |
| `disclosures.term_range` | `min–max months`, only when both bounds are supplied. |
| `disclosures.representative_example` | The operator's supplied example, without calculated figures. |
| `disclosures.unsupported_states` | Supplied state codes separated by commas. |

A slot with no value keeps the text between its tags, so the template's own APR table,
term range, example and state list stay on the page. The brand wizard does not ask for
APR, term, example or states; the lender sets the real rate at review. No APR, term,
example or state defaults are invented. Invalid supplied profile data
fails validation. Rendering still checks source bytes and final output with
`assertCleanBrandBytes`. Legal fill uses revision data only; the resulting static bytes
are identical for every visitor. Privacy and do-not-sell pages are still required and
remain reviewed template content.

## 1. What you hand over

- **Static output only (TP-1).** Deliver the built `dist/` folder (zipped). Anjuna never builds templates and never runs template server code.
  - Astro: `output: 'static'` (`astro build`). Use `build.format: 'directory'` so routes are `/<page>/index.html`.
  - vinext / Next.js: `output: 'export'`.
  - React SPA: `vite build`.
- No server functions, middleware, API routes, edge functions or `_worker.js`. Anything that only works on a server is ignored at best and rejected at worst.
- The brand Worker serves the files as they are, plus these runtime paths it owns: `/go`, the form route, `/_f/*` and `/api/*`. **Do not create files or routes at those paths.**

## 2. Required pages

| Path | Content |
|---|---|
| `/` (`index.html`) | Landing page with the keyword H1 and the CTA form. |
| `/privacy/` | Privacy policy. |
| `/terms/` | Terms of use. |
| `/do-not-sell/` | "Do Not Sell or Share My Personal Information" notice. |
| `/disclosures/` | Disclosures (not a lender, rates/terms vary by lender and state, not all applicants qualify, state availability). |

Link every legal page from the footer of every page, and show a short disclosure in the footer. The starter ships placeholder copy marked `[Placeholder]`; replace it with reviewed copy before sealing.

## 3. Required slots

### 3.1 Keyword slot (BR-4, TP-2)

Exactly **one** keyword slot on the landing page, **inside the `<h1>`**:

```astro
---
import KeywordSlot from '../components/KeywordSlot.astro';
---
<h1><KeywordSlot default="Funding Options" /> | Check Your Options in Minutes</h1>
```

It renders `<span data-kw>Funding Options</span>`. Rules:

- The span contains plain text only (the default). No nested elements, icons or line breaks inside it.
- The default text must read well on its own; it is what visitors see when the ad has no keyword.
- The rest of the H1 must read well with any 1–60 character title-cased phrase in the slot (for example "Fast Cash Loans", "Bad Credit Options").
- `data-kw` appears nowhere else in the page.

React templates use the package instead of hand-writing the span:

```tsx
import { KeywordSlot } from '@anjuna/keyword-slot-react';

<h1><KeywordSlot default="Funding Options" /> | Check Your Options in Minutes</h1>
```

### 3.2 CTA form (BR-2, TP-2)

Exactly one CTA form on the landing page:

```html
<form method="get" action="/go" data-cta>
  <select name="requested_amount" required>
    <option value="350">$350</option> … <option value="5000">$5,000</option>
  </select>
  <input name="zip" inputmode="numeric" pattern="[0-9]{5}" minlength="5" maxlength="5" required>
  <button type="submit">Continue</button>
</form>
```

- `method="get"`, `action="/go"`, and the `data-cta` attribute.
- Exactly two named fields: `requested_amount` (a `<select>`) and `zip` (5 digits).
- `requested_amount` values are the canonical buckets: **350, 500, 750, 1000, 1500, 1750, 2000, 3000, 3250, 4500, 5000**. The option value is the bare number; the label may be formatted (`$1,000`). `/go` rejects any other value.
- Do not add hidden inputs; the brand Worker appends the allowlisted ad params (`gclid`, `gbraid`, `wbraid`, `msclkid`, `utm_*`, `keyword`) itself.
- The form must work without JavaScript (a plain HTML submit).

### 3.3 Runtime config (BR-5)

The brand Worker writes `<script type="application/json" id="cfg">` (brand name, amount, ZIP, keyword, form route, A/B variant, proxy paths). A template may read it (the React `KeywordSlot` reads `cfg.keyword`), but must never write to it, depend on fields not listed here, or put its own data in an element with `id="cfg"`.

### 3.4 Page title, description and brand name

The dashboard edits three texts per brand: brand name, page title and meta description. The template supplies the defaults.

- `/index.html` **must** have a `<title>` (the first 70 characters are used) and `<meta name="description" content="...">` (the first 160 characters are used). When the dashboard edits the title or description, the brand Worker writes the edited value into the tag, and into `og:title` or `og:description` when those tags exist. An unedited title and `og:title` are served as the template wrote them, with the template's brand name replaced by the brand's name (whole words only). An unedited description is served as written.
- Put `data-brand` on every element whose text is the brand name: header logo text, footer, legal pages. The element must hold only the brand name text, no icons or images, because the Worker replaces its whole content: `<a href="/"><img src="/logo.svg" alt=""><span data-brand>Harbor Funding</span></a>`.
- A template without any `data-brand` still passes, with a warning. New templates should always have it.
- The install replaces the template's brand name everywhere else too: body text becomes `<span data-brand>`, and `alt`, `title`, `aria-label`, `placeholder`, meta content and JSON-LD get the brand's name. Certification warns with a count when the brand name appears in body text outside `data-brand`.
- The install writes the brand's wizard copy into the landing page: `h1` (the `<span data-kw>` slot stays), the CTA form's submit button, and the first `<p>` after the H1 and before the CTA form. An empty field keeps the template text.
- Contact: `tel:` and `mailto:` links get the brand's phone and email (href and text), and the numbers and addresses of those links are replaced in page text. `<span data-contact="phone|email|address">` slots get the profile value; an `<a>` slot also gets a `tel:` or `mailto:` href.
- On pages other than `/`, the Worker replaces the template's brand name inside `<title>` with the brand's name. Write legal page titles like `Privacy Policy | Harbor Funding`.

## 4. Banned content

A template **must not** contain:

- **The words "Personal Loan" or "Personal Loans"** in any case, anywhere (copy, titles, alt text, metadata, file names). Use neutral wording such as "funding options", "loan options" or "cash".
- **PII inputs.** No fields for name, email, phone, address, SSN, date of birth, income, bank or employer, and no `type="email"`, `type="tel"` or `type="password"`. The Anjuna Form collects these.
- **External scripts or analytics.** No `<script src="https://…">`, Google Tag / gtag, Tag Manager, PostHog, Sentry, Meta pixel, chat widgets or embeds. Analytics run only through the brand Worker's first-party proxies.
- **External runtime resources** that leak visits to third parties (remote fonts, CDN CSS, hotlinked images). Ship assets inside `dist/`.
- **Platform or other-brand identifiers.** No "anjuna" or "aurum", no other brand's name or domain, no keys, DSNs or IDs.
- **Cloaking or visitor-dependent logic.** Nothing that changes content by user agent, IP, referrer, gclid or bot detection.
- Rate, approval or speed guarantees ("guaranteed approval", "no credit check", "instant approval").

## 5. Styling and assets

- **Astro: mark shared styles `<style is:global>`** (TP-2). Astro scopes component styles by default, and scoped selectors break when the Worker rewrites markup.
- Prefer CSS inlined into the HTML (`build.inlineStylesheets: 'always'`) or hashed files under `dist/`.
- Brand tokens (name, colors, copy) live only in HTML or JSON, never baked into JS bundles, so certification and identity scans can read them.
- Mobile first: the H1 and the CTA must be above the fold at 375 px width.

## 6. How keyword insertion works

1. The ad's final URL carries `?keyword={keyword}` (set as the campaign's Final URL suffix).
2. The brand Worker cleans it (BR-4): non letter/number characters other than space, `&`, `'` and `-` are dropped, whitespace is collapsed, the result is cut to 60 characters and title-cased. An empty result means "no keyword".
3. When a keyword exists, the Worker's HTMLRewriter replaces the **text** of `[data-kw]` with it (`setInnerContent`, text mode, never HTML) and writes it to `cfg.keyword`. Otherwise the default text stays.
4. The keyword travels through `/go` to the form, whose header shows the same keyword (message match).

Because the text is replaced on the server, the keyword appears in the first byte of HTML with no flash and no JavaScript.

### React hydration

In a hydrated React page the static HTML has the default text, but the browser receives the Worker-rewritten keyword. `@anjuna/keyword-slot-react` handles this without a hydration mismatch:

- During hydration it renders the default (the server snapshot), matching the build output; the text difference is confined to the one span and silenced by `suppressHydrationWarning`, so React keeps the Worker's text.
- Right after hydration it re-renders from `cfg.keyword`, so React state equals the DOM.
- In a client-only SPA (`createRoot`) it renders `cfg.keyword` on the first paint.

Do not hand-roll this with `useEffect` + `useState` on the span text or with `dangerouslySetInnerHTML`.

## 7. Certification checklist (what T11 checks)

- [ ] `dist/` is static; `index.html`, `privacy/`, `terms/`, `do-not-sell/`, `disclosures/` exist.
- [ ] Exactly one `<span data-kw>` and it is inside the `<h1>`.
- [ ] Exactly one `form[data-cta]` with `method="get"`, `action="/go"`, fields `requested_amount` (canonical buckets) and `zip`.
- [ ] No "Personal Loan(s)", no PII inputs, no external scripts or analytics, no platform or other-brand identifiers.
- [ ] Tokens only in HTML or JSON; Astro styles `is:global`.
- [ ] `/index.html` has `<title>` and `<meta name="description">`; brand name text carries `data-brand`.
- [ ] Desktop and mobile screenshots reviewed; owner seals the version (SHA-256, immutable).

## 8. Builder prompts

**OpenDesign / Bolt.new (Astro):** "Start from `packages/template-astro-starter`. Keep `KeywordSlot` inside the H1, keep `CtaForm` unchanged except styling and labels, keep all four legal pages, keep `<style is:global>`. Do not add scripts, analytics, fonts from CDNs or any new form fields. Output: `astro build` → `dist/`."

**v0 (Next.js static export):** "Use `output: 'export'`. Render the H1 with `<KeywordSlot default=\"…\" />` from `@anjuna/keyword-slot-react`. Add exactly one `<form method=\"get\" action=\"/go\" data-cta>` with `requested_amount` (canonical buckets) and a 5-digit `zip`. Create `/privacy`, `/terms`, `/do-not-sell`, `/disclosures`. No analytics, no external scripts, no PII inputs, never the words \"Personal Loan\"."

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
7. Only if the site cannot be published: call `begin_upload`, then `upload_files` with every file in `dist/` as `{ "path", "content", "encoding", "part" }`, at most 20,000 characters of content per call (cut larger files into parts 0, 1, 2 ...), then `finish_upload`. The result is the same as `submit_template_url`. The batch size is `UPLOAD_BATCH_CHARS` in `workers/template-mcp/src/submit.ts`.

Hosting badges that the platform injects at publish time (today: the bolt.host `https://bolt.new/badge.js` script) are removed during URL import and reported as a `host-badge` warning. They never reach the sealed template.

The owner and employees can paste the same published URL into "Import from URL" on the dashboard's Templates screen. It runs the same pipeline.

## 10. Local agents (Open Design)

Builders that run on the user's machine with a shell (Open Design, Claude Code, Codex, Cursor) upload the site as a ZIP with `curl`. The `get_template_contract` tool serves these steps as `local_agent_submit`. The Open Design plugin is in `integrations/open-design/anjuna-landing-template/`.

1. Write the static site into one folder, for example `site/` or `dist/`. Every required page is real HTML with its text in the file.
2. Zip the contents of that folder: `(cd site && zip -r ../site.zip .)` (PowerShell: `Compress-Archive -Path site/* -DestinationPath site.zip -Force`).
3. Submit it:
   ```sh
   curl -sS -X POST https://<template MCP host>/submit-zip \
     -H "Authorization: Bearer $ANJUNA_BUILDER_KEY" \
     -F file=@site.zip -F template_id=<slug> -F template_name="<name>"
   ```
   The host is the same host as the MCP URL the builder was given. The key may also go in `X-API-Key` or `Api-Key`.
4. Read the JSON result. It has the same statuses as `submit_template_url`:
   - `awaiting_approval`: done. The owner approves it in the dashboard (Templates).
   - `rejected`: fix every item in `issues`, zip again and submit again.
   - `duplicate`: this exact build was already submitted. Nothing changed.
5. Read the key from the `ANJUNA_BUILDER_KEY` environment variable. Never print the key, write it into a file or commit it.

HTTP errors: `401` means the key is missing, unknown or revoked. `429` means the key passed its per-minute rate limit. `422` with `invalid` means a bad field or upload, and `422` with `needs_build` means the ZIP holds a source project in place of built HTML. Other form fields are ignored: the submitter is always the builder key.
