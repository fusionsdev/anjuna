import { UPLOAD_BATCH_CHARS } from "./submit";
/**
 * The landing template contract (docs/template-contract.md) as data. One source for the
 * `get_template_contract` tool and for the rule ids / constants the checker reports against.
 * A test keeps the constants in sync with the markdown document.
 */

export const AMOUNT_BUCKETS = [350, 500, 750, 1000, 1500, 1750, 2000, 3000, 3250, 4500, 5000] as const;
export const REQUIRED_PAGES = [
  { route: "/", file: "index.html", what: "Landing page with the keyword H1 and the CTA form" },
  { route: "/privacy/", file: "privacy/index.html", what: "Privacy policy" },
  { route: "/terms/", file: "terms/index.html", what: "Terms of use" },
  { route: "/do-not-sell/", file: "do-not-sell/index.html", what: "Do Not Sell or Share My Personal Information notice" },
  { route: "/disclosures/", file: "disclosures/index.html", what: "Disclosures (not a lender, rates and terms vary, not all applicants qualify)" },
] as const;
/** Paths the brand Worker owns; a template must not ship files here. */
export const RESERVED_PATHS = ["go", "api", "_f"] as const;

export type RuleId =
  | "static-output"
  | "reserved-path"
  | "required-pages"
  | "legal-footer-links"
  | "keyword-slot"
  | "cta-form"
  | "pii-inputs"
  | "banned-wording"
  | "guarantee-claims"
  | "external-scripts"
  | "external-resources"
  | "cloaking"
  | "brand-clean"
  | "cfg-element"
  | "links-resolve"
  | "page-text"
  | "brand-slot";

export interface ContractRule {
  id: RuleId;
  level: "must" | "should";
  rule: string;
  how: string;
}

export const CONTRACT_RULES: readonly ContractRule[] = [
  {
    id: "static-output",
    level: "must",
    rule: "Hand over the static build output (dist/) only. No server code of any kind.",
    how: "Astro: output 'static', build.format 'directory'. Next.js: output 'export'. Vite SPA: vite build. No _worker.js, functions/, middleware, API routes or server files (.php etc.).",
  },
  {
    id: "reserved-path",
    level: "must",
    rule: "Never create files or routes at /go, /api/*, /_f/*. The brand Worker owns them.",
    how: "Rename any page or asset folder that collides with go, api or _f.",
  },
  {
    id: "required-pages",
    level: "must",
    rule: "Ship the landing page and four legal pages as /<page>/index.html: privacy, terms, do-not-sell, disclosures.",
    how: "Create privacy/index.html, terms/index.html, do-not-sell/index.html, disclosures/index.html next to index.html.",
  },
  {
    id: "legal-footer-links",
    level: "must",
    rule: "Every page links all four legal pages from its footer and shows a short disclosure.",
    how: "Add <a href=\"/privacy/\">, /terms/, /do-not-sell/, /disclosures/ to a shared footer used on every page.",
  },
  {
    id: "keyword-slot",
    level: "must",
    rule: "Exactly one <span data-kw> on the landing page, inside the <h1>, containing plain text only (1-60 chars). data-kw appears nowhere else.",
    how: "<h1><span data-kw>Funding Options</span> | Check Your Options in Minutes</h1>. The rest of the H1 must read well with any 1-60 char title-cased phrase in the slot. React: <KeywordSlot default=\"Funding Options\" /> from @anjuna/keyword-slot-react.",
  },
  {
    id: "cta-form",
    level: "must",
    rule: "Exactly one CTA form on the landing page: <form method=\"get\" action=\"/go\" data-cta> with exactly two named fields, select requested_amount and 5-digit zip. It must work without JavaScript. No hidden inputs, no other forms.",
    how: `requested_amount option values are bare numbers from: ${AMOUNT_BUCKETS.join(", ")} (labels may be formatted like $1,000). zip: <input name="zip" inputmode="numeric" pattern="[0-9]{5}" minlength="5" maxlength="5" required>. Add a submit button.`,
  },
  {
    id: "pii-inputs",
    level: "must",
    rule: "No inputs for name, email, phone, address, SSN, date of birth, income, bank or employer; no type=email/tel/password; no textarea. The Anjuna Form collects these.",
    how: "Delete the field. Do not rename it to dodge the check.",
  },
  {
    id: "banned-wording",
    level: "must",
    rule: "The words \"Personal Loan(s)\" appear nowhere: copy, titles, alt text, metadata, file names.",
    how: "Use \"funding options\", \"loan options\" or \"cash\".",
  },
  {
    id: "guarantee-claims",
    level: "must",
    rule: "No rate, approval or speed guarantees (\"guaranteed approval\", \"no credit check\", \"instant approval\", \"100% approved\").",
    how: "Use hedged wording: \"check your options\", \"not all applicants qualify\".",
  },
  {
    id: "external-scripts",
    level: "must",
    rule: "No external scripts, analytics, tag managers, pixels, chat widgets or embeds. Analytics run only through the brand Worker's first-party proxies.",
    how: "Remove every <script src=\"https://...\"> and inline analytics snippet (gtag, GTM, PostHog, Sentry, Meta pixel, Hotjar, Intercom...).",
  },
  {
    id: "external-resources",
    level: "must",
    rule: "No external runtime resources: remote fonts, CDN CSS, hotlinked images, iframes. Ship every asset inside dist/.",
    how: "Download fonts and images into the project and reference them with relative or root-relative paths. Remove preconnect/dns-prefetch to third parties.",
  },
  {
    id: "cloaking",
    level: "must",
    rule: "No cloaking: nothing may change content by user agent, IP, referrer, gclid or bot detection.",
    how: "Remove code that reads navigator.userAgent, document.referrer or gclid to change what is shown.",
  },
  {
    id: "brand-clean",
    level: "must",
    rule: "No platform or other-brand identifiers: the strings \"anjuna\"/\"aurum\", another brand's name or domain, analytics keys or DSNs.",
    how: "Search the whole dist/ (including JS, JSON and source maps) and remove the offending strings.",
  },
  {
    id: "cfg-element",
    level: "must",
    rule: "Never create an element with id=\"cfg\"; the brand Worker writes <script type=\"application/json\" id=\"cfg\">.",
    how: "Rename the element. Read cfg at runtime only if needed; never write to it.",
  },
  {
    id: "links-resolve",
    level: "must",
    rule: "Every internal link, stylesheet, script, image and CSS url() resolves to a file in dist/ (the runtime paths /go, /api/*, /_f/* excepted).",
    how: "Fix broken paths. Use root-relative paths and trailing-slash routes (/privacy/).",
  },
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
];

export const CONTRACT_BANNED_PHRASES = [
  "Personal Loan / Personal Loans",
  "guaranteed approval",
  "no credit check",
  "instant approval",
] as const;

export function contractForBuilders() {
  return {
    title: "Anjuna landing template contract",
    intro:
      "You are building a landing template for one Anjuna brand. Every brand must have its OWN unique design: never reuse a layout, copy or images from another brand's template (identical sites risk ad-account bans). Your output is the static dist/ of a site. Before you finish, call check_template (zip or URL) and similarity_check, fix every issue they report, and call them again until both pass.",
    deliverable: "Static output only: the built dist/ folder (max 30 MB, 2000 files, 10 MB per file). Every page must be real HTML, not an empty <div id=\"root\"> filled by JavaScript.",
    how_to_submit: [
      "1. Build static HTML: run npm run build. Every page in dist/ must contain its real text; a dist/index.html that is only <div id=\"root\"></div> plus a script is rejected.",
      "2. Publish the site in bolt.new. Use the published URL exactly as bolt.new shows it.",
      "3. Call probe_url with that URL. ok must be true. If status is 404 (\"Website not found\"), publish again and wait a minute. If client_rendered is true, make the pages static HTML first.",
      "4. Call submit_template_url with url, template_id (lowercase slug, e.g. harbor-funding) and template_name. Do not paste files or zips into a tool call.",
      "5. status awaiting_approval: done; tell the user the owner approves it in the dashboard. status rejected: fix every item in issues (each has rule, file, message, fix), publish again and call submit_template_url again. status duplicate: this exact build was already submitted; nothing changed.",
      "6. \"reduce image sizes\" means the build is over 30 MB, 2000 files or 10 MB per file: compress or resize images and submit again.",
      `7. Only if you cannot publish: call begin_upload, then upload_files with every file in dist/ ({ path, content, encoding, part }) using at most ${UPLOAD_BATCH_CHARS} characters of content per call (cut larger files into parts 0, 1, 2 ...), then finish_upload. Never paste a zip.`,
    ],
    required_pages: REQUIRED_PAGES,
    reserved_paths: RESERVED_PATHS.map((p) => `/${p}`),
    amount_buckets: AMOUNT_BUCKETS,
    keyword_slot_example: '<h1><span data-kw>Funding Options</span> | Check Your Options in Minutes</h1>',
    cta_form_example:
      '<form method="get" action="/go" data-cta>\n' +
      '  <select name="requested_amount" required>\n' +
      AMOUNT_BUCKETS.map((b) => `    <option value="${b}">$${b.toLocaleString("en-US")}</option>`).join("\n") +
      '\n  </select>\n' +
      '  <input name="zip" inputmode="numeric" pattern="[0-9]{5}" minlength="5" maxlength="5" required>\n' +
      '  <button type="submit">Continue</button>\n</form>',
    rules: CONTRACT_RULES,
    banned_phrases: CONTRACT_BANNED_PHRASES,
    workflow: [
      "1. Design a unique layout, visual identity, copy and imagery for this brand.",
      "2. Build to static HTML (npm run build) and publish it.",
      "3. Call probe_url, then submit_template_url. It runs the same checks as check_template and similarity_check.",
      "4. If status is rejected, fix every issue, publish again and submit again. Stop when status is awaiting_approval or duplicate.",
      "5. Without submit access: zip dist/, call check_template and similarity_check until both pass, and hand the zip to the owner.",
    ],
    source: "docs/template-contract.md",
  };
}
