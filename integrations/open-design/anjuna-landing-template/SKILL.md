---
name: anjuna-landing-template
description: Build a static multi-page lead-gen landing template in its own design, check it against the Anjuna template contract, zip it and submit it with the builder key.
triggers:
  - landing template
  - anjuna template
  - lead-gen landing
od:
  category: brand-page
  surface: web
  scenario: marketing
---

# Anjuna landing template

You build one landing template for one brand. The inputs are the template name (`brandName`) and the template id (`templateId`, a lowercase slug such as `harbor-funding`).

## 1. Read the contract

If the `anjuna-template` MCP server is connected, call `get_template_contract` first and follow it. It is the source of truth and wins over this file. Its `local_agent_submit` field holds the submit steps. Without the MCP server, follow the summary below.

## 2. Contract summary

- Deliver static HTML only: no server code, no `_worker.js`, no `functions/`, no API routes. Every page holds its real text in the HTML file. A page that is an empty `<div id="root">` filled by JavaScript is rejected.
- Required pages, each as `<page>/index.html`:
  - `/` (`index.html`): landing page with the keyword H1 and the CTA form.
  - `/privacy/` (`privacy/index.html`): privacy policy.
  - `/terms/` (`terms/index.html`): terms of use.
  - `/do-not-sell/` (`do-not-sell/index.html`): Do Not Sell or Share My Personal Information notice.
  - `/disclosures/` (`disclosures/index.html`): not a lender, rates and terms vary, not all applicants qualify.
- Also ship `/rates-and-fees/` (`rates-and-fees/index.html`): APR range, repayment terms, amounts, a representative cost example labeled as an example, and the fees a lender may charge. The starter has it. Replace its figures with the network's real ranges.
- Every page has a footer that links `/privacy/`, `/terms/`, `/do-not-sell/`, `/disclosures/` and `/rates-and-fees/` and shows a short disclosure.
- Reserved paths: never create files or folders at `/go`, `/api` or `/_f`.
- Keyword slot: exactly one `<span data-kw>` on the landing page, inside the `<h1>`, plain text of 1 to 60 characters. `data-kw` appears nowhere else. Example: `<h1><span data-kw>Funding Options</span> | Check Your Options in Minutes</h1>`. The rest of the H1 must read well with any short title-cased phrase in the slot.
- CTA form: exactly one form on the landing page. It works without JavaScript, has no hidden inputs and only these two named fields:
  ```html
  <form method="get" action="/go" data-cta>
    <select name="requested_amount" required>
      <option value="350">$350</option>
      <option value="500">$500</option>
      <option value="750">$750</option>
      <option value="1000">$1,000</option>
      <option value="1500">$1,500</option>
      <option value="1750">$1,750</option>
      <option value="2000">$2,000</option>
      <option value="3000">$3,000</option>
      <option value="3250">$3,250</option>
      <option value="4500">$4,500</option>
      <option value="5000">$5,000</option>
    </select>
    <input name="zip" inputmode="numeric" pattern="[0-9]{5}" minlength="5" maxlength="5" required>
    <button type="submit">Continue</button>
  </form>
  ```
  The option values are bare numbers from 350, 500, 750, 1000, 1500, 1750, 2000, 3000, 3250, 4500, 5000. Labels may be styled freely.
- No inputs for name, email, phone, address, SSN, date of birth, income, bank or employer. No `type=email`, `tel` or `password`. No `textarea`.
- Banned phrases anywhere (copy, titles, alt text, metadata, file names): "Personal Loan / Personal Loans", "guaranteed approval", "no credit check", "instant approval". Also no "100% approved" or other rate, approval or speed guarantees. Use "funding options", "check your options", "not all applicants qualify".
- No external scripts, analytics, tag managers, pixels, chat widgets, embeds or iframes. No remote fonts, CDN CSS or hotlinked images: put every asset inside the site folder.
- No cloaking: nothing reads the user agent, IP, referrer, gclid or bot signals to change what is shown.
- Never create an element with `id="cfg"`.
- Every internal link, stylesheet, script, image and CSS `url()` resolves to a file in the site folder. Use root-relative paths and trailing-slash routes (`/privacy/`).
- `index.html` has a `<title>` (up to 70 characters) and `<meta name="description" content="...">` (up to 160 characters).
- Every element whose text is the brand name carries `data-brand` and holds only that text, for example `<span data-brand>Harbor Funding</span>`.
- Limits: 30 MB per archive, 2000 files, 10 MB per file.

## 3. Brand-clean site

The site you build must not contain the strings "anjuna" or "aurum", or another brand's name or domain. Check every file in the site folder, including CSS, JSON and comments. Only the template name you were given appears as the brand name.

## 4. Design

Give this brand its own design: layout, visual identity, copy and imagery. Never reuse a layout, copy or images from another brand's template, because identical sites risk ad-account bans. Use the active Open Design design system.

## Starter skeleton

If the project folder has no `site/` yet, copy `starter/site/` from this plugin (the folder that holds this file) into the project's `site/` and redesign from there. The skeleton is plain HTML and CSS with no JavaScript. It already passes the contract and is visually neutral on purpose.

Change layout, colors, type, imagery and copy. Keep every structural element:

- the `<span data-kw>` inside the single `<h1>` on `index.html`
- the CTA form, its two fields (`requested_amount`, `zip`) and the amount options
- the five footer links, the disclosure line and the footer on every page
- the `data-brand` spans, holding only the brand name

Each section carries a `<!-- REDESIGN: ... -->` comment that says what to restyle or rewrite. Remove each comment when its section is done. Start the visual design in the custom properties at the top of `assets/site.css`. Replace "Brand Name" in the title, the `data-brand` spans and the logo with the given template name, and replace the `[Placeholder]` paragraphs on the legal pages with reviewed legal copy or tell the user that the owner still has to supply it.

## 5. Build

Write plain static HTML and CSS into `site/` in the project folder. No framework build is needed. If you do use a framework, submit its built output folder.

## 6. Submit

Follow `local_agent_submit` from `get_template_contract`, or these steps:

1. Zip the contents of `site/`: `(cd site && zip -r ../site.zip .)` (PowerShell: `Compress-Archive -Path site/* -DestinationPath site.zip -Force`).
2. Submit it to the same host as the MCP URL you were given:
   ```sh
   curl -sS -X POST https://<template MCP host>/submit-zip \
     -H "Authorization: Bearer $ANJUNA_BUILDER_KEY" \
     -F file=@site.zip -F template_id=<templateId> -F template_name="<brandName>"
   ```
3. Read the JSON result:
   - `awaiting_approval`: done.
   - `rejected`: fix every item in `issues` (each has `rule`, `file`, `message`, `fix`), zip again and submit again. Repeat until the status is `awaiting_approval` or `duplicate`.
   - `duplicate`: this exact build was already submitted. Nothing changed.
4. Read the key only from the `ANJUNA_BUILDER_KEY` environment variable. Never print the key, write it into a file or commit it. If the variable is empty, stop and ask the user to set it.

When the status is `awaiting_approval` or `duplicate`, tell the user that the owner approves the template in the dashboard under Templates.
