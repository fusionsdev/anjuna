/**
 * Template contract checker (docs/template-contract.md, section 7). Pure functions over a file map:
 * it parses HTML as text and never executes template JavaScript.
 */
import { AMOUNT_BUCKETS, REQUIRED_PAGES, RESERVED_PATHS, type RuleId } from "./contract";
import type { FileMap } from "./archive";
import {
  TEXT_EXT,
  allElements,
  cssUrls,
  decode,
  hasAncestor,
  isExternalUrl,
  parseHtml,
  rawText,
  snippet,
  srcsetUrls,
  visibleText,
  type Element,
} from "./html";

export interface Issue {
  rule: RuleId;
  severity: "error" | "warning";
  file?: string;
  message: string;
  fix: string;
  evidence?: string;
}

export interface CheckReport {
  pass: boolean;
  summary: string;
  errors: number;
  warnings: number;
  issues: Issue[];
  stats: { files: number; html_pages: number; bytes: number };
}

export interface OtherBrand {
  name: string;
  domain: string;
}

const MAX_PER_RULE = 8;
const BUCKETS = new Set<string>(AMOUNT_BUCKETS.map(String));

const PII_TOKENS = new Set([
  "name", "firstname", "lastname", "fullname", "fname", "lname", "surname", "email", "mail", "phone", "mobile",
  "cell", "tel", "telephone", "address", "street", "ssn", "social", "dob", "birth", "birthday", "bday",
  "income", "salary", "bank", "routing", "employer", "employment", "password", "passwd", "given", "family",
]);

const GUARANTEE_PATTERNS: [RegExp, string][] = [
  [/guaranteed?\s+(?:instant\s+)?(?:approval|approved|funding|funds|loans?|cash|rates?|offers?|acceptance|decision)/i, "guaranteed approval/funding claim"],
  [/(?:approval|funding|acceptance)\s+(?:is\s+)?guaranteed/i, "approval guaranteed claim"],
  [/\bwe\s+guarantee\b/i, "\"we guarantee\" claim"],
  [/100\s*%\s*(?:approv|guarantee|accept)/i, "100% approval claim"],
  [/\bno\s+credit\s+(?:check|inquir)/i, "\"no credit check\" claim"],
  [/\b(?:instant|immediate)\s+(?:approval|decision)/i, "instant approval claim"],
  [/\beveryone\s+(?:is\s+)?(?:approved|qualifies)/i, "everyone approved claim"],
];
const SPEED_PATTERNS: RegExp[] = [
  /\b(?:same[- ]day|instant|immediate)\s+(?:funding|cash|deposit|funds)/i,
  /\bfunds?\s+(?:in|within)\s+\d+\s*(?:minutes?|hours?|seconds?)/i,
];

const ANALYTICS =
  /googletagmanager\.com|google-analytics\.com|\bgtag\s*\(|connect\.facebook\.net|\bfbq\s*\(|posthog|sentry|hotjar|clarity\.ms|segment\.(?:com|io)|mixpanel|amplitude|intercom|tawk\.to|hs-scripts|doubleclick\.net|fullstory|logrocket|crisp\.chat|drift\.com|tiktok\.com\/i18n|snap(?:chat)?\.com\/scevent/i;

function legalRoute(route: string): string {
  return route.replace(/[?#].*$/, "").replace(/\/index\.html?$/i, "").replace(/\.html?$/i, "").replace(/\/+$/, "") || "/";
}

export interface NormalizedRoot {
  files: FileMap;
  notes: Issue[];
}

/** Drop OS junk and unwrap a wrapping folder (`dist/`) so builders who zip the folder itself still get a real check. */
export function normalizeRoot(input: FileMap): NormalizedRoot {
  const notes: Issue[] = [];
  let files: FileMap = new Map();
  for (const [path, bytes] of input) {
    if (path.startsWith("__MACOSX/") || path.split("/").some((s) => s === ".DS_Store")) continue;
    files.set(path, bytes);
  }
  if (!files.has("index.html")) {
    const tops = new Set([...files.keys()].map((p) => p.split("/")[0]!));
    const candidates = tops.size === 1 && files.has(`${[...tops][0]}/index.html`) ? [[...tops][0]!] : [];
    if (files.has("dist/index.html")) candidates.unshift("dist");
    const wrap = candidates[0];
    if (wrap) {
      const prefix = `${wrap}/`;
      const stripped: FileMap = new Map();
      for (const [path, bytes] of files) if (path.startsWith(prefix)) stripped.set(path.slice(prefix.length), bytes);
      files = stripped;
      notes.push({
        rule: "static-output",
        severity: "warning",
        message: `The archive wraps the site in a "${wrap}/" folder; it was unwrapped for this check.`,
        fix: `Zip the contents of ${wrap}/ (index.html at the archive root), not the folder itself.`,
      });
    }
  }
  return { files, notes };
}

export function checkTemplate(input: FileMap, opts: { otherBrands?: OtherBrand[] } = {}): CheckReport {
  const { files, notes } = normalizeRoot(input);
  const issues: Issue[] = [...notes];
  const counts = new Map<RuleId, number>();
  const add = (issue: Issue) => {
    const n = (counts.get(issue.rule) ?? 0) + 1;
    counts.set(issue.rule, n);
    if (n <= MAX_PER_RULE || issue.severity === "error" && n <= MAX_PER_RULE * 2) issues.push(issue);
  };

  const paths = [...files.keys()];
  let bytes = 0;
  for (const b of files.values()) bytes += b.length;
  const text = new Map<string, string>();
  for (const [path, data] of files) if (TEXT_EXT.test(path)) text.set(path, decode(data));
  const htmlPaths = paths.filter((p) => /\.html?$/i.test(p));
  const parsed = new Map(htmlPaths.map((p) => [p, parseHtml(text.get(p) ?? "")] as const));
  const elementsOf = new Map([...parsed].map(([p, doc]) => [p, allElements(doc)] as const));

  // static-output, reserved paths
  for (const path of paths) {
    const first = path.split("/")[0]!;
    const base = path.split("/").pop()!;
    if (/^_worker\.js$/.test(first) || first === "functions" || /^_middleware\./.test(base) || first === "node_modules" || first === ".wrangler") {
      add({ rule: "static-output", severity: "error", file: path, message: `Server-side or build-tool file in the build output: ${path}.`, fix: "Ship only the static dist/ output: remove functions/, _worker.js, middleware and node_modules." });
    } else if (/\.(php|py|rb|jsp|aspx?|cgi|pl)$/i.test(base)) {
      add({ rule: "static-output", severity: "error", file: path, message: `Server-side script file: ${path}.`, fix: "Templates are static only; remove this file." });
    }
    if ((RESERVED_PATHS as readonly string[]).includes(first) || path === "go.html") {
      add({ rule: "reserved-path", severity: "error", file: path, message: `File at the reserved runtime path /${first}: ${path}.`, fix: `The brand Worker owns /go, /api/* and /_f/*. Rename the page or folder "${first}".` });
    }
  }
  if (paths.includes("package.json") && !paths.includes("index.html")) {
    add({ rule: "static-output", severity: "error", message: "This looks like a source project, not a build output (package.json present, no index.html).", fix: "Run the build (astro build / vite build / next build with output 'export') and zip the contents of dist/ (or out/)." });
  }

  // required pages
  for (const page of REQUIRED_PAGES) {
    const alt = page.file === "index.html" ? null : `${page.file.split("/")[0]}.html`;
    if (!files.has(page.file) && !(alt && files.has(alt))) {
      add({ rule: "required-pages", severity: "error", file: page.file, message: `Missing required page ${page.route} (${page.what}).`, fix: `Create ${page.file}. With Astro set build.format to 'directory'; with Next.js export set trailingSlash: true.` });
    }
  }

  const indexDoc = parsed.get("index.html");
  const indexEls = elementsOf.get("index.html") ?? [];

  if (indexDoc) {
    // keyword slot
    const slots = indexEls.filter((e) => "data-kw" in e.attribs);
    const rawCount = (text.get("index.html")!.match(/data-kw/g) ?? []).length;
    if (slots.length !== 1) {
      add({ rule: "keyword-slot", severity: "error", file: "index.html", message: slots.length === 0 ? "No keyword slot: index.html has no element with data-kw." : `${slots.length} keyword slots found; exactly one is allowed.`, fix: 'Put exactly one <span data-kw>Default Text</span> inside the page <h1>, e.g. <h1><span data-kw>Funding Options</span> | Check Your Options in Minutes</h1>.' });
    } else {
      const slot = slots[0]!;
      if (slot.name !== "span") add({ rule: "keyword-slot", severity: "error", file: "index.html", message: `The keyword slot is a <${slot.name}>; it must be a <span>.`, fix: "Use <span data-kw>…</span>." });
      if (!hasAncestor(slot, "h1")) add({ rule: "keyword-slot", severity: "error", file: "index.html", message: "The keyword slot is not inside the <h1>.", fix: "Move the <span data-kw> into the page's <h1>." });
      if (slot.children.some((c) => c.type !== "text")) add({ rule: "keyword-slot", severity: "error", file: "index.html", message: "The keyword slot contains nested elements, icons or line breaks.", fix: "The span must contain plain text only: <span data-kw>Funding Options</span>." });
      const def = rawText(slot).trim();
      if (def.length < 1 || def.length > 60) add({ rule: "keyword-slot", severity: "error", file: "index.html", message: `The default keyword text is ${def.length} characters; it must be 1-60.`, fix: "Use a short title-cased default such as \"Funding Options\"." });
      if (/\n/.test(rawText(slot).trim())) add({ rule: "keyword-slot", severity: "error", file: "index.html", message: "The default keyword text has a line break.", fix: "Keep the default on one line." });
    }
    if (rawCount > slots.length) add({ rule: "keyword-slot", severity: "error", file: "index.html", message: "data-kw appears more than once in the page source (CSS, script or comment).", fix: "Remove every other use of data-kw (style the slot with a class instead)." });
    const h1s = indexEls.filter((e) => e.name === "h1");
    if (h1s.length !== 1) add({ rule: "keyword-slot", severity: "warning", file: "index.html", message: `The landing page has ${h1s.length} <h1> elements; use exactly one.`, fix: "Keep a single <h1> containing the keyword slot." });

    // CTA form
    const forms = indexEls.filter((e) => e.name === "form");
    const cta = forms.filter((f) => "data-cta" in f.attribs);
    for (const f of forms.filter((f) => !("data-cta" in f.attribs))) {
      add({ rule: "cta-form", severity: "error", file: "index.html", message: "An extra <form> on the landing page (newsletter, contact, search…).", fix: "Remove it. The page has exactly one form: the CTA form.", evidence: snippet(String(f.attribs.action ?? ""), 0, 40) || undefined });
    }
    if (cta.length !== 1) {
      add({ rule: "cta-form", severity: "error", file: "index.html", message: cta.length === 0 ? "No CTA form: no <form data-cta> on the landing page." : `${cta.length} CTA forms found; exactly one is allowed.`, fix: 'Add <form method="get" action="/go" data-cta> with select requested_amount, input zip and a submit button.' });
    } else {
      checkCta(cta[0]!, add);
    }
  }

  // PII inputs: every page
  for (const [path, els] of elementsOf) {
    for (const el of els) {
      if (el.name === "textarea") {
        add({ rule: "pii-inputs", severity: "error", file: path, message: "A <textarea> collects free text (PII risk).", fix: "Remove it; the Anjuna Form collects any personal data." });
        continue;
      }
      if (el.name !== "input" && el.name !== "select") continue;
      const type = (el.attribs.type ?? "text").toLowerCase();
      if (["submit", "button", "reset", "image"].includes(type)) continue;
      if (["email", "tel", "password"].includes(type)) {
        add({ rule: "pii-inputs", severity: "error", file: path, message: `A type="${type}" input collects personal data.`, fix: "Remove the field; the Anjuna Form collects it." });
        continue;
      }
      const hits = piiTokens([el.attribs.name, el.attribs.id, el.attribs.placeholder, el.attribs.autocomplete, el.attribs["aria-label"]]);
      if (hits.length > 0) {
        add({ rule: "pii-inputs", severity: "error", file: path, message: `A field looks like a PII input (${hits.join(", ")}): name="${el.attribs.name ?? ""}".`, fix: "Remove the field; the template may only ask for requested_amount and zip." });
      }
    }
  }

  // legal links + footer
  const legalRoutes = ["/privacy", "/terms", "/do-not-sell", "/disclosures"];
  for (const path of htmlPaths) {
    const els = elementsOf.get(path)!;
    const linked = new Set<string>();
    for (const a of els.filter((e) => e.name === "a" && e.attribs.href)) {
      const resolved = resolveInternal(a.attribs.href!, path);
      if (resolved && resolved !== "runtime") linked.add(legalRoute(`/${resolved}`));
    }
    const missing = legalRoutes.filter((r) => !linked.has(r));
    if (missing.length > 0) {
      add({ rule: "legal-footer-links", severity: "error", file: path, message: `Missing footer links to: ${missing.join(", ")}.`, fix: "Link all four legal pages (/privacy/, /terms/, /do-not-sell/, /disclosures/) from the footer of every page." });
    }
    if (!els.some((e) => e.name === "footer")) {
      add({ rule: "legal-footer-links", severity: "warning", file: path, message: "No <footer> element (legal links and a short disclosure belong there).", fix: "Add a <footer> with the legal links and a one-sentence disclosure." });
    }
  }

  // text scans over every text file
  const personal = /personal[\s\-_.]*loans?/i;
  for (const path of paths) {
    if (personal.test(path)) add({ rule: "banned-wording", severity: "error", file: path, message: `File name contains "personal loan": ${path}.`, fix: "Rename the file; use neutral wording." });
  }
  for (const [path, raw] of text) {
    const norm = raw.replace(/&nbsp;|&#160;|&#xa0;|&shy;|&#173;/gi, " ").replace(/[ ​-‍⁠﻿­]/g, " ");
    const hay = /\.html?$/i.test(path) ? `${norm}\n${visibleText(parsed.get(path)!)}` : norm;
    const m = personal.exec(hay);
    if (m) add({ rule: "banned-wording", severity: "error", file: path, message: 'The banned wording "Personal Loan(s)" appears.', fix: 'Replace with "funding options", "loan options" or "cash".', evidence: snippet(hay, m.index, m[0].length) });

    if (/\.html?$/i.test(path)) {
      const visible = visibleText(parsed.get(path)!) + " " + attrText(elementsOf.get(path)!);
      for (const [re, label] of GUARANTEE_PATTERNS) {
        const g = re.exec(visible);
        if (g) add({ rule: "guarantee-claims", severity: "error", file: path, message: `Guarantee claim: ${label}.`, fix: 'Use hedged wording such as "check your options" and "not all applicants qualify".', evidence: snippet(visible, g.index, g[0].length) });
      }
      for (const re of SPEED_PATTERNS) {
        const g = re.exec(visible);
        if (g) add({ rule: "guarantee-claims", severity: "warning", file: path, message: "Speed claim that reads like a guarantee.", fix: "Avoid promising funding speed; say what the form does instead (\"Check your options in minutes\").", evidence: snippet(visible, g.index, g[0].length) });
      }
    }

    // brand-clean
    const platform = /anjuna|aurum/i.exec(norm);
    if (platform) add({ rule: "brand-clean", severity: "error", file: path, message: `Platform identifier "${platform[0]}" found.`, fix: "Remove it from the build output (including JS bundles, JSON and source maps).", evidence: snippet(norm, platform.index, platform[0].length) });
    if (/\bph[cx]_[A-Za-z0-9]{20,}\b/.test(norm)) add({ rule: "brand-clean", severity: "error", file: path, message: "A PostHog key is embedded.", fix: "Remove it; analytics run through the brand Worker only." });
    if (/https?:\/\/[a-f0-9]{16,}@[^\s"']*sentry|ingest(?:\.[a-z]{2})?\.sentry\.io/i.test(norm)) add({ rule: "brand-clean", severity: "error", file: path, message: "A Sentry DSN is embedded.", fix: "Remove it; error reporting runs through the brand Worker only." });
    for (const brand of opts.otherBrands ?? []) {
      const domain = brand.domain.toLowerCase();
      if (domain && norm.toLowerCase().includes(domain)) add({ rule: "brand-clean", severity: "error", file: path, message: `Another brand's domain "${brand.domain}" appears.`, fix: "Remove every reference to other brands." });
      else if (brand.name.length >= 4 && /\.(html?|json|webmanifest|txt|xml)$/i.test(path) && new RegExp(`\\b${escapeRe(brand.name)}\\b`, "i").test(/\.html?$/i.test(path) ? visibleText(parsed.get(path)!) : norm)) {
        add({ rule: "brand-clean", severity: "error", file: path, message: `Another brand's name "${brand.name}" appears.`, fix: "Remove every reference to other brands, including copy copied from their sites." });
      }
    }

    // analytics / cloaking in script text
    if (/\.(m?js|cjs)$/i.test(path)) {
      scanScript(path, norm, add);
    }
    if (/\.css$/i.test(path)) scanCss(path, norm, add);
  }

  // per-page structure: scripts, external resources, cfg, links
  for (const path of htmlPaths) {
    for (const el of elementsOf.get(path)!) {
      const attrs = el.attribs;
      if (attrs.id === "cfg") add({ rule: "cfg-element", severity: "error", file: path, message: 'An element with id="cfg" exists.', fix: "The brand Worker writes #cfg. Rename your element." });
      if (el.name === "script") {
        if (attrs.src !== undefined) {
          if (isExternalUrl(attrs.src)) add({ rule: "external-scripts", severity: "error", file: path, message: `External script: ${attrs.src}`, fix: "Remove it, or bundle the code into dist/ if it is needed. Analytics, tag managers, chat widgets and embeds are not allowed." });
          else checkLink(path, attrs.src, "script", add, files);
        } else {
          const body = rawText(el);
          if (ANALYTICS.test(body)) add({ rule: "external-scripts", severity: "error", file: path, message: "Inline analytics or tracking snippet.", fix: "Remove it. Tracking runs only through the brand Worker's first-party proxies." });
          scanScript(path, body, add);
        }
      } else if (el.name === "link") {
        const rel = (attrs.rel ?? "").toLowerCase();
        const href = attrs.href;
        if (href === undefined) continue;
        const resource = /(stylesheet|preload|modulepreload|prefetch|icon|manifest|preconnect|dns-prefetch)/.test(rel);
        if (resource && isExternalUrl(href)) add({ rule: "external-resources", severity: "error", file: path, message: `External ${rel} resource: ${href}`, fix: "Download fonts, CSS and images into dist/ and reference them locally. Remove preconnect/dns-prefetch to third parties." });
        else if (resource && !/preconnect|dns-prefetch/.test(rel)) checkLink(path, href, "link", add, files);
      } else if (["img", "source", "video", "audio", "track", "iframe", "embed", "object", "frame", "input"].includes(el.name)) {
        const urls = [attrs.src, attrs.data, attrs.poster, ...(attrs.srcset ? srcsetUrls(attrs.srcset) : [])].filter((u): u is string => !!u);
        for (const url of urls) {
          if (isExternalUrl(url)) {
            const embed = ["iframe", "embed", "object", "frame"].includes(el.name);
            add({ rule: "external-resources", severity: "error", file: path, message: embed ? `External embed <${el.name}>: ${url}` : `Hotlinked ${el.name}: ${url}`, fix: embed ? "Remove the embed (video, map, chat or booking widgets are not allowed)." : "Download the asset into dist/ and reference it locally." });
          } else checkLink(path, url, el.name, add, files);
        }
      } else if (el.name === "a" && attrs.href) {
        checkLink(path, attrs.href, "a", add, files);
      }
      if (el.name === "style") for (const u of cssUrls(rawText(el))) cssRef(path, u, path, add, files);
      if (attrs.style) for (const u of cssUrls(attrs.style)) cssRef(path, u, path, add, files);
    }
  }
  for (const [path, css] of text) if (/\.css$/i.test(path)) for (const u of cssUrls(css)) cssRef(path, u, path, add, files);

  // Astro scoped styles
  if ([...text.values()].some((t) => /data-astro-cid-/.test(t))) {
    add({ rule: "static-output", severity: "warning", message: "Scoped Astro component styles (data-astro-cid-*) found.", fix: "Mark shared styles <style is:global>; scoped selectors break when the Worker rewrites markup." });
  }

  for (const [rule, n] of counts) {
    const shown = issues.filter((i) => i.rule === rule).length;
    if (n > shown) issues.push({ rule, severity: "warning", message: `${n - shown} more "${rule}" issue(s) not listed.`, fix: "Fix the listed ones and re-run the check." });
  }
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  return {
    pass: errors === 0,
    summary: errors === 0 ? `PASS: template meets the contract${warnings ? ` (${warnings} warning(s))` : ""}.` : `FAIL: ${errors} error(s), ${warnings} warning(s). Fix every error and re-run check_template.`,
    errors,
    warnings,
    issues,
    stats: { files: paths.length, html_pages: htmlPaths.length, bytes },
  };
}

type Add = (issue: Issue) => void;

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function attrText(els: Element[]): string {
  const parts: string[] = [];
  for (const el of els) for (const key of ["alt", "title", "aria-label", "placeholder", "content", "value"]) if (el.attribs[key]) parts.push(el.attribs[key]!);
  return parts.join(" ");
}

function piiTokens(values: (string | undefined)[]): string[] {
  const hits = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const spaced = value.replace(/([a-z])([A-Z])/g, "$1 $2");
    const tokens = spaced.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    for (const t of tokens) if (PII_TOKENS.has(t)) hits.add(t);
    const joined = tokens.join("");
    for (const t of ["firstname", "lastname", "fullname", "emailaddress", "phonenumber", "streetaddress", "dateofbirth"]) if (joined.includes(t)) hits.add(t);
  }
  return [...hits];
}

/** Resolve an internal href to a repo-relative path, "runtime" for brand-Worker paths, or null to ignore. */
function resolveInternal(href: string, page: string): string | null {
  const url = href.trim();
  if (!url || url.startsWith("#") || isExternalUrl(url) || /^(?:mailto|tel|sms|javascript|data|blob):/i.test(url)) return null;
  const clean = url.replace(/[?#].*$/, "");
  const out = clean.startsWith("/") ? [] : page.split("/").slice(0, -1);
  for (const seg of clean.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return "";
      out.pop();
    } else out.push(seg);
  }
  const resolved = out.join("/");
  if ((RESERVED_PATHS as readonly string[]).includes(out[0] ?? "")) return "runtime";
  return resolved;
}

function exists(files: FileMap, resolved: string): boolean {
  if (resolved === "") return files.has("index.html");
  return files.has(resolved) || files.has(`${resolved}/index.html`) || files.has(`${resolved}.html`);
}

function checkLink(page: string, href: string, kind: string, add: Add, files: FileMap): void {
  const resolved = resolveInternal(href, page);
  if (resolved === null || resolved === "runtime") return;
  if (!exists(files, resolved)) {
    add({ rule: "links-resolve", severity: "error", file: page, message: `Broken ${kind} reference: ${href}`, fix: "Point it at a file that exists in dist/ (root-relative paths, trailing-slash routes like /privacy/) or remove it." });
  }
}

function cssRef(file: string, url: string, base: string, add: Add, files: FileMap): void {
  if (/^data:/i.test(url) || url.startsWith("#")) return;
  if (isExternalUrl(url)) {
    add({ rule: "external-resources", severity: "error", file, message: `CSS loads an external resource: ${url}`, fix: "Self-host fonts and images in dist/ and reference them relatively." });
    return;
  }
  checkLink(base, url, "CSS url()", add, files);
}

function scanScript(path: string, code: string, add: Add): void {
  if (ANALYTICS.test(code)) add({ rule: "external-scripts", severity: "error", file: path, message: "Analytics or tracking code is bundled.", fix: "Remove it. Tracking runs only through the brand Worker's first-party proxies." });
  if (/\bimport\s*\(?\s*['"]https?:\/\//.test(code)) add({ rule: "external-scripts", severity: "error", file: path, message: "A script imports code from an external URL.", fix: "Bundle the dependency into dist/." });
  if (/googlebot|adsbot|mediapartners|\bgclid\b|navigator\.webdriver/i.test(code)) add({ rule: "cloaking", severity: "error", file: path, message: "Bot/gclid detection logic found.", fix: "Remove it. Nothing may change by bot detection or gclid." });
  else if (/navigator\.userAgent|userAgentData|document\.referrer/.test(code)) add({ rule: "cloaking", severity: "warning", file: path, message: "Reads the user agent or referrer.", fix: "Make sure it never changes what content is shown; remove it if unsure." });
}

function scanCss(path: string, css: string, add: Add): void {
  for (const m of css.matchAll(/@font-face[^}]*src:[^}]*url\(\s*['"]?(https?:)?\/\//gi)) {
    add({ rule: "external-resources", severity: "error", file: path, message: "Remote @font-face source.", fix: "Self-host the font files in dist/.", evidence: snippet(css, m.index ?? 0, 40) });
  }
}

function checkCta(form: Element, add: Add): void {
  const file = "index.html";
  const method = (form.attribs.method ?? "").toLowerCase();
  if (method !== "get") add({ rule: "cta-form", severity: "error", file, message: `CTA form method is "${form.attribs.method ?? "(missing)"}"; it must be "get".`, fix: 'Set method="get".' });
  if (form.attribs.action !== "/go") add({ rule: "cta-form", severity: "error", file, message: `CTA form action is "${form.attribs.action ?? "(missing)"}"; it must be "/go".`, fix: 'Set action="/go".' });
  const controls: Element[] = [];
  const collect = (el: Element) => {
    for (const c of el.children) if (c.type === "tag") {
      if (["input", "select", "textarea", "button"].includes(c.name)) controls.push(c);
      collect(c);
    }
  };
  collect(form);
  const isSubmit = (c: Element) => c.name === "button" || (c.name === "input" && ["submit", "button", "reset", "image"].includes((c.attribs.type ?? "").toLowerCase()));
  const named = controls.filter((c) => c.attribs.name && !isSubmit(c));
  for (const c of named) {
    const hidden = c.name === "input" && (c.attribs.type ?? "").toLowerCase() === "hidden";
    if (hidden) add({ rule: "cta-form", severity: "error", file, message: `Hidden input in the CTA form: name="${c.attribs.name}".`, fix: "Remove it. The brand Worker appends ad parameters itself." });
    else if (c.attribs.name !== "requested_amount" && c.attribs.name !== "zip") add({ rule: "cta-form", severity: "error", file, message: `Unexpected CTA field "${c.attribs.name}".`, fix: "The form has exactly two named fields: requested_amount and zip." });
  }
  for (const c of controls) {
    if (!c.attribs.name && c.name === "input" && (c.attribs.type ?? "").toLowerCase() === "hidden") add({ rule: "cta-form", severity: "error", file, message: "Unnamed hidden input in the CTA form.", fix: "Remove it." });
  }
  const amount = named.filter((c) => c.attribs.name === "requested_amount");
  const zip = named.filter((c) => c.attribs.name === "zip");
  if (amount.length !== 1) add({ rule: "cta-form", severity: "error", file, message: `Expected one "requested_amount" field, found ${amount.length}.`, fix: 'Add <select name="requested_amount" required> with the canonical bucket options.' });
  else {
    const select = amount[0]!;
    if (select.name !== "select") add({ rule: "cta-form", severity: "error", file, message: `requested_amount is an <${select.name}>; it must be a <select>.`, fix: "Use a <select> with the canonical buckets as option values." });
    else {
      const options = select.children.flatMap((c) => (c.type === "tag" && c.name === "option" ? [c] : c.type === "tag" && c.name === "optgroup" ? c.children.filter((g): g is Element => g.type === "tag" && g.name === "option") : []));
      if (options.length === 0) add({ rule: "cta-form", severity: "error", file, message: "requested_amount has no options.", fix: `Add options with values from: ${AMOUNT_BUCKETS.join(", ")}.` });
      for (const option of options) {
        const value = option.attribs.value;
        if (value === undefined) add({ rule: "cta-form", severity: "error", file, message: `An <option> has no value attribute ("${rawText(option).trim()}").`, fix: 'Give every option an explicit bare-number value, e.g. <option value="1000">$1,000</option>.' });
        else if (value === "" && "required" in select.attribs) continue;
        else if (!BUCKETS.has(value)) add({ rule: "cta-form", severity: "error", file, message: `Option value "${value}" is not a canonical bucket.`, fix: `Use only: ${AMOUNT_BUCKETS.join(", ")} (bare numbers; labels may be formatted).` });
      }
      if (!("required" in select.attribs)) add({ rule: "cta-form", severity: "warning", file, message: "requested_amount is not required.", fix: "Add the required attribute." });
    }
  }
  if (zip.length !== 1) add({ rule: "cta-form", severity: "error", file, message: `Expected one "zip" field, found ${zip.length}.`, fix: 'Add <input name="zip" inputmode="numeric" pattern="[0-9]{5}" minlength="5" maxlength="5" required>.' });
  else {
    const z = zip[0]!;
    const type = (z.attribs.type ?? "text").toLowerCase();
    if (z.name !== "input" || !["text", "number", "search"].includes(type)) add({ rule: "cta-form", severity: "error", file, message: "zip must be a plain text input.", fix: 'Use <input name="zip" inputmode="numeric" ...> (no type=tel/email).' });
    if (!/^\^?(\[0-9\]|\\d)\{5\}\$?$/.test(z.attribs.pattern ?? "")) add({ rule: "cta-form", severity: "error", file, message: "zip does not enforce exactly 5 digits.", fix: 'Add pattern="[0-9]{5}" (and minlength="5" maxlength="5").' });
    if (z.attribs.maxlength !== "5") add({ rule: "cta-form", severity: "warning", file, message: "zip has no maxlength=\"5\".", fix: 'Add minlength="5" maxlength="5".' });
    if (!("required" in z.attribs)) add({ rule: "cta-form", severity: "warning", file, message: "zip is not required.", fix: "Add the required attribute." });
  }
  const hasSubmit = controls.some((c) => (c.name === "button" && ["", "submit"].includes((c.attribs.type ?? "").toLowerCase())) || (c.name === "input" && (c.attribs.type ?? "").toLowerCase() === "submit"));
  if (!hasSubmit) add({ rule: "cta-form", severity: "error", file, message: "The CTA form has no submit button, so it cannot work without JavaScript.", fix: 'Add <button type="submit">Continue</button>.' });
}
