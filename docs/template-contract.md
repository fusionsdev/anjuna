# Landing template contract

This is the contract for anyone, human or AI builder (OpenDesign, Bolt.new, v0, Stitch or Magic Patterns exports), who makes a landing template for an Anjuna brand. A template that breaks any **must** rule below is rejected at certification (T11) with a repair message. Requirement IDs refer to `docs/PRODUCT-BRIEF.md` (TP-1, TP-2, BR-2, BR-4, BR-5).

Reference implementations:

- Astro: `packages/template-astro-starter` (recommended; start every new template from it).
- React (vinext / Next.js static export, Vite SPA): `packages/keyword-slot-react`.

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
- [ ] Desktop and mobile screenshots reviewed; owner seals the version (SHA-256, immutable).

## 8. Builder prompts

**OpenDesign / Bolt.new (Astro):** "Start from `packages/template-astro-starter`. Keep `KeywordSlot` inside the H1, keep `CtaForm` unchanged except styling and labels, keep all four legal pages, keep `<style is:global>`. Do not add scripts, analytics, fonts from CDNs or any new form fields. Output: `astro build` → `dist/`."

**v0 (Next.js static export):** "Use `output: 'export'`. Render the H1 with `<KeywordSlot default=\"…\" />` from `@anjuna/keyword-slot-react`. Add exactly one `<form method=\"get\" action=\"/go\" data-cta>` with `requested_amount` (canonical buckets) and a 5-digit `zip`. Create `/privacy`, `/terms`, `/do-not-sell`, `/disclosures`. No analytics, no external scripts, no PII inputs, never the words \"Personal Loan\"."
