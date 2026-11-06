/**
 * Renders the Magic Pattern content bundle into a static site that follows
 * docs/template-contract.md. Run: bun build.ts [outDir] [preset]
 * Output is plain HTML plus assets/site.css, with no scripts.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SITE, type BrandPreset } from "./content/siteConfig";
import {
  NOT_A_LENDER, AFFILIATE_DISCLOSURE, NO_GUARANTEE, APR_DISCLOSURE, STATE_DISCLOSURE,
  PRIVACY_DISCLOSURE, FOOTER_DISCLOSURE, HERO_COPY, TRUST_COPY, IMPORTANT_DISCLOSURES_PAGE,
} from "./content/disclosures";
import { FAQ_ITEMS } from "./content/faq";
import { RATES_AND_TERMS_PAGE } from "./content/ratesTerms";

const here = import.meta.dir;
const outDir = resolve(process.argv[2] ?? join(here, "site"));
const preset = (process.argv[3] ?? SITE.brandPreset) as BrandPreset;

const THEMES: Record<BrandPreset, Record<string, string>> = {
  "navy-green": { primary: "#0f2c4c", accent: "#1f8a5b", surface: "#ffffff", alt: "#f4f6f9", border: "#dde3ed", text: "#0f2c4c", text2: "#3d5068", muted: "#5b6f86" },
  "trust-blue": { primary: "#1a3a8f", accent: "#2563eb", surface: "#ffffff", alt: "#f0f4fb", border: "#d0daf5", text: "#1a3a8f", text2: "#3b5a9a", muted: "#566fa3" },
  "forest-amber": { primary: "#1a4731", accent: "#b45309", surface: "#fdfaf5", alt: "#f5efe3", border: "#ddd5c4", text: "#1a4731", text2: "#3a5c45", muted: "#5d6e55" },
  "plum-violet": { primary: "#4a1560", accent: "#7c3aed", surface: "#ffffff", alt: "#f5f0fc", border: "#e0d5f5", text: "#4a1560", text2: "#6b3d82", muted: "#7d5a94" },
  "slate-teal": { primary: "#334155", accent: "#0f766e", surface: "#ffffff", alt: "#f8fafc", border: "#e2e8f0", text: "#1e293b", text2: "#475569", muted: "#64748b" },
};

const AMOUNTS = [350, 500, 750, 1000, 1500, 1750, 2000, 3000, 3250, 4500, 5000];
const money = (n: number) => "$" + n.toLocaleString("en-US");

/** Escape bare ampersands that are not already entities. */
const esc = (s: string) => s.replace(/&(?![a-z]+;|#\d+;)/gi, "&amp;");
/** Body text: content may carry anchors; wrap the brand name in a data-brand span. */
const body = (s: string) =>
  esc(s).replace(/Brand Name/g, `<span data-brand>${SITE.name}</span>`).replace(/\r?\n/g, "<br>");
const plain = (s: string) => esc(s).replace(/</g, "&lt;");

const NAV = [
  ["How It Works", "/#how-it-works"],
  ["Rates &amp; Terms", "/rates-and-terms/"],
  ["FAQ", "/faq/"],
];

const header = () => `<header class="site-header">
  <div class="container bar">
    <a class="brand-link" href="/"><img src="/assets/logo.svg" alt="" width="28" height="28"><span data-brand>${SITE.name}</span></a>
    <nav aria-label="Main">
      ${NAV.map(([l, h]) => `<a href="${h}">${l}</a>`).join("\n      ")}
      <a class="btn" href="/#cta-form">Get Started</a>
    </nav>
  </div>
</header>`;

const footer = () => `<footer class="site-footer">
  <div class="container">
    <div class="foot-grid">
      <div>
        <p class="foot-brand"><a href="/" data-brand>${SITE.name}</a></p>
        <p class="small">${plain(NOT_A_LENDER.SHORT)}</p>
        <p class="small"><a href="tel:${SITE.phone.replace(/[^0-9+]/g, "")}" data-contact="phone">${SITE.phone}</a></p>
        <p class="small"><a href="mailto:${SITE.email}" data-contact="email">${SITE.email}</a></p>
      </div>
      <div>
        <h2>Legal</h2>
        <ul>
          <li><a href="/disclosures/">Important Disclosures</a></li>
          <li><a href="/privacy/">Privacy Policy</a></li>
          <li><a href="/terms/">Terms of Use</a></li>
          <li><a href="/do-not-sell/">Do Not Sell or Share My Personal Information</a></li>
        </ul>
      </div>
      <div>
        <h2>Resources</h2>
        <ul>
          <li><a href="/rates-and-terms/">Rates &amp; Terms</a></li>
          <li><a href="/faq/">FAQ</a></li>
          <li><a href="/#how-it-works">How It Works</a></li>
        </ul>
      </div>
    </div>
    <div class="disclosure">
      <p><strong>Important Disclosures</strong></p>
      <p>${body(FOOTER_DISCLOSURE.FULL)}</p>
      <p>${body(AFFILIATE_DISCLOSURE.FULL)}</p>
    </div>
    <p class="small copy">&copy; ${new Date().getFullYear()} <span data-brand>${SITE.name}</span>. All rights reserved.</p>
  </div>
</footer>`;

function page(opts: { title: string; description?: string; main: string }) {
  const desc = opts.description
    ? `\n  <meta name="description" content="${plain(opts.description).replace(/"/g, "&quot;")}">`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${plain(opts.title)}</title>${desc}
  <link rel="stylesheet" href="/assets/site.css">
</head>
<body>
${header()}
<main>
${opts.main}
</main>
${footer()}
</body>
</html>
`;
}

const legal = (h1: string, inner: string, updated = true) => `<section class="legal">
  <div class="container narrow">
    <h1>${h1}</h1>
${updated ? `    <p class="small">Effective ${new Date().getFullYear()}-01-01</p>\n` : ""}${inner}
  </div>
</section>`;

const ctaForm = () => `<form class="cta" id="cta-form" method="get" action="/go" data-cta>
  <h2>Check Available Options</h2>
  <p class="small">See if you may qualify. No obligation required.</p>
  <p class="note">${body(NO_GUARANTEE.HERO_INLINE)}</p>
  <label for="requested_amount">How much would you like to request?</label>
  <select id="requested_amount" name="requested_amount" required>
    ${AMOUNTS.map((a) => `<option value="${a}"${a === 3000 ? " selected" : ""}>${money(a)}</option>`).join("\n    ")}
  </select>
  <label for="zip">ZIP code</label>
  <input id="zip" name="zip" inputmode="numeric" pattern="[0-9]{5}" minlength="5" maxlength="5" autocomplete="postal-code" placeholder="Enter ZIP code" required>
  <button class="btn" type="submit">Continue</button>
  <p class="small center">Secure and encrypted. No obligation. Checking will not affect your credit.</p>
</form>`;

const faqList = (items: readonly (typeof FAQ_ITEMS)[number][]) =>
  items.map((f) => `<details><summary>${body(f.question)}</summary><p>${body(f.answer)}</p></details>`).join("\n    ");

// ── Landing page ────────────────────────────────────────────────────────────
const home = page({
  title: SITE.seo.defaultTitle,
  description: SITE.seo.defaultDescription,
  main: `<section class="hero">
  <div class="container hero-grid">
    <div>
      <p class="eyebrow">${plain(NOT_A_LENDER.SHORT)}</p>
      <h1><span data-kw>Funding Options</span> | Check Your Options in Minutes</h1>
      <p class="lead">${plain(HERO_COPY.SUBHEADLINES[0])} ${plain(HERO_COPY.SUBHEADLINES[2])}</p>
      <ul class="ticks">
        ${HERO_COPY.BULLETS.slice(0, 4).map((b) => `<li>${plain(b)}</li>`).join("\n        ")}
      </ul>
      <p class="small">${body(APR_DISCLOSURE.WITHOUT_RANGE)}</p>
    </div>
    <div>
${ctaForm()}
    </div>
  </div>
</section>

<section class="trust" aria-label="Our process">
  <div class="container trust-grid">
    ${TRUST_COPY.POINTS.slice(0, 4).map((p) => `<p>${plain(p.text)}</p>`).join("\n    ")}
  </div>
</section>

<section class="section" id="how-it-works">
  <div class="container">
    <h2 class="center">How It Works</h2>
    <p class="center sub">Three simple steps. No obligation to accept any offer.</p>
    <div class="steps">
      <div><span class="num">1</span><h3>Submit Your Request</h3><p>Enter your requested amount and ZIP code. The secure request takes just a few minutes.</p></div>
      <div><span class="num">2</span><h3>Review Offers</h3><p>Participating lenders may contact you with an offer. You decide whether it is right for you.</p></div>
      <div><span class="num">3</span><h3>Get Funded</h3><p>If you accept, the lender handles the rest. Funding timing depends on the lender and your state.</p></div>
    </div>
  </div>
</section>

<section class="section alt">
  <div class="container">
    <h2 class="center">What to Know Before You Request</h2>
    <div class="cards">
      <div class="card"><h3>We are not a lender</h3><p>${body(NOT_A_LENDER.FULL)}</p></div>
      <div class="card"><h3>Rates and terms</h3><p>${body(APR_DISCLOSURE.WITHOUT_RANGE)} <a href="/rates-and-terms/">Read rates and terms</a>.</p></div>
      <div class="card"><h3>State availability</h3><p>${body(STATE_DISCLOSURE.FULL)}</p></div>
    </div>
  </div>
</section>

<section class="section">
  <div class="container narrow">
    <h2 class="center">Common Questions</h2>
    ${faqList(FAQ_ITEMS.slice(0, 5))}
    <p class="center"><a href="/faq/">See all questions</a></p>
  </div>
</section>

<section class="section alt">
  <div class="container narrow center">
    <h2>Ready to get started?</h2>
    <p class="sub">${plain(SITE.tagline)}</p>
    <p><a class="btn" href="#cta-form">Check Available Options</a></p>
    <p class="small">${body(NO_GUARANTEE.HERO_INLINE)}</p>
  </div>
</section>`,
});

// ── Inner pages ─────────────────────────────────────────────────────────────
const sec = (h: string, t: string) => `    <section><h2>${h}</h2><p>${t}</p></section>`;
const mail = `<a href="mailto:${SITE.email}" data-contact="email">${SITE.email}</a>`;

const privacy = page({
  title: `Privacy Policy | ${SITE.name}`,
  main: legal("Privacy Policy", [
    sec("Overview", body(PRIVACY_DISCLOSURE.SHORT)),
    sec("California Residents: CCPA Notice", body(PRIVACY_DISCLOSURE.CCPA_NOTICE)),
    sec("Financial Privacy: GLBA Notice", body(PRIVACY_DISCLOSURE.GLBA_NOTICE)),
    sec("Information We Collect", "When you submit a loan request, we collect the information you provide, including name, contact information, address, financial details, and employment information. We also automatically collect certain technical information such as IP address, browser type, and pages visited."),
    sec("How We Use Your Information", "Your information may be shared with participating lenders, lending partners, affiliate networks, and marketing partners for the purpose of presenting you with loan offers. We may also use your information to operate and improve our service, comply with legal obligations, and prevent fraud."),
    sec("Contact Us", `If you have questions about this Privacy Policy, contact us at ${mail}.`),
  ].join("\n")),
});

const terms = page({
  title: `Terms of Use | ${SITE.name}`,
  main: legal("Terms of Use", [
    sec("About This Website", `<span data-brand>${SITE.name}</span> is an online lead generation and comparison service. ${body(NOT_A_LENDER.FULL)}`),
    sec("No Guarantee", body(IMPORTANT_DISCLOSURES_PAGE.SECTIONS[2].body)),
    sec("Your Request", "By submitting a request you confirm that the information you provide is accurate and that you are at least 18 years old. Your information may be shared with participating lenders and lending partners as described in the Privacy Policy."),
    sec("Third-Party Lenders", "Offers, rates, fees and repayment terms come from independent lenders. You are responsible for reviewing a lender's terms before accepting any offer. We are not a party to any agreement between you and a lender."),
    sec("Changes", "We may update these terms from time to time. The version on this page applies when you use the website."),
    sec("Contact", `Questions about these terms: ${mail}.`),
  ].join("\n")),
});

const doNotSell = page({
  title: `Do Not Sell or Share My Personal Information | ${SITE.name}`,
  main: legal("Do Not Sell or Share My Personal Information", [
    `    <p>${body(PRIVACY_DISCLOSURE.CCPA_NOTICE)}</p>`,
    sec("How to Make a Request", `To opt out of the sale or sharing of your personal information, email us at ${mail} with the subject "Do Not Sell or Share". Include the ZIP code and requested amount you used so we can find your request. We respond within 45 days as required by the CCPA.`),
    sec("Related Pages", `<a href="/privacy/">Privacy Policy</a> and <a href="/disclosures/">Important Disclosures</a>.`),
  ].join("\n")),
});

const disclosures = page({
  title: `${IMPORTANT_DISCLOSURES_PAGE.TITLE} | ${SITE.name}`,
  main: legal(IMPORTANT_DISCLOSURES_PAGE.TITLE,
    IMPORTANT_DISCLOSURES_PAGE.SECTIONS.map((s) => sec(plain(s.heading), body(s.body))).join("\n")),
});

const catLabels: Record<string, string> = {
  general: "General", process: "Process", rates: "Rates &amp; Fees", credit: "Credit", safety: "Safety", privacy: "Privacy &amp; Data",
};
const faq = page({
  title: `Frequently Asked Questions | ${SITE.name}`,
  description: "Answers to common questions about requesting a loan through a lead generation service.",
  main: `<section class="legal">
  <div class="container narrow">
    <h1>Frequently Asked Questions</h1>
    <p class="sub">Answers to common questions about our loan request service.</p>
${[...new Set(FAQ_ITEMS.map((f) => f.category))].map((c) => `    <h2>${catLabels[c] ?? c}</h2>
    ${faqList(FAQ_ITEMS.filter((f) => f.category === c))}`).join("\n")}
  </div>
</section>`,
});

const rates = page({
  title: `Rates and Terms | ${SITE.name}`,
  description: "What to expect from loan amounts, rates, fees and repayment terms offered by participating lenders.",
  main: legal(plain(RATES_AND_TERMS_PAGE.title),
    `    <p class="sub">${body(RATES_AND_TERMS_PAGE.subtitle)}</p>\n` +
    RATES_AND_TERMS_PAGE.sections.map((s) => sec(plain(s.heading), body(s.body))).join("\n"), false),
});

// ── CSS ─────────────────────────────────────────────────────────────────────
const t = THEMES[preset];
const css = `:root{--primary:${t.primary};--accent:${t.accent};--surface:${t.surface};--alt:${t.alt};--border:${t.border};--text:${t.text};--text2:${t.text2};--muted:${t.muted}}
*,*::before,*::after{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--surface);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent)}
.container{max-width:1100px;margin:0 auto;padding:0 16px}
.narrow{max-width:720px}
.center{text-align:center}
.small{font-size:13px;color:var(--muted)}
.sub{color:var(--text2)}
h1{font-size:clamp(28px,5vw,46px);line-height:1.15;margin:.2em 0 .4em;color:var(--primary)}
h2{font-size:clamp(22px,3vw,30px);color:var(--primary);margin:1.2em 0 .5em}
h3{font-size:17px;color:var(--primary);margin:.4em 0}
.site-header{position:sticky;top:0;z-index:20;background:var(--surface);border-bottom:1px solid var(--border)}
.bar{display:flex;align-items:center;justify-content:space-between;min-height:64px;gap:12px;flex-wrap:wrap}
.brand-link{display:flex;align-items:center;gap:8px;font-weight:700;font-size:20px;color:var(--primary);text-decoration:none}
.site-header nav{display:flex;align-items:center;gap:20px;font-size:14px;flex-wrap:wrap}
.site-header nav a:not(.btn){color:var(--text2);text-decoration:none}
.btn,button.btn{display:inline-block;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:12px 22px;font:600 15px/1.2 inherit;text-decoration:none;cursor:pointer}
.btn:hover{filter:brightness(1.08)}
.hero{background:var(--alt);padding:40px 0 56px}
.hero-grid{display:grid;gap:32px;grid-template-columns:1fr;align-items:center}
@media(min-width:800px){.hero-grid{grid-template-columns:1fr 1fr;gap:48px}}
.eyebrow{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin:0}
.lead{font-size:18px;color:var(--text2)}
.ticks{list-style:none;padding:0;margin:16px 0}
.ticks li{padding-left:24px;position:relative;color:var(--text2);font-size:15px;margin:6px 0}
.ticks li::before{content:"\\2713";position:absolute;left:0;color:var(--accent);font-weight:700}
.cta{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:24px;box-shadow:0 4px 32px rgba(0,0,0,.08)}
.cta h2{margin-top:0}
.cta label{display:block;font-size:14px;font-weight:600;color:var(--text2);margin:14px 0 6px}
.cta select,.cta input{width:100%;padding:12px 14px;font-size:16px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text)}
.cta select:focus,.cta input:focus{outline:2px solid var(--accent);outline-offset:1px}
.cta .btn{width:100%;margin-top:18px;font-size:17px;padding:14px}
.note{background:var(--alt);border-radius:6px;padding:8px 12px;font-size:12px;color:var(--muted)}
.trust{border-block:1px solid var(--border);padding:20px 0}
.trust-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;text-align:center}
@media(min-width:800px){.trust-grid{grid-template-columns:repeat(4,1fr)}}
.trust p{margin:0;font-size:14px;font-weight:600;color:var(--primary)}
.section{padding:56px 0}
.alt{background:var(--alt)}
.steps,.cards{display:grid;gap:24px;grid-template-columns:1fr;margin-top:28px}
@media(min-width:800px){.steps,.cards{grid-template-columns:repeat(3,1fr)}}
.steps>div{text-align:center}
.num{display:inline-flex;width:44px;height:44px;border-radius:50%;background:var(--accent);color:#fff;font-weight:700;align-items:center;justify-content:center}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;font-size:14px;color:var(--text2)}
details{border-bottom:1px solid var(--border);padding:14px 0}
summary{cursor:pointer;font-weight:600;font-size:15px}
details p{color:var(--text2);font-size:15px}
.legal{padding:40px 0 64px}
.legal section{margin:24px 0}
.legal h2{font-size:20px;margin:0 0 8px}
.legal p{color:var(--text2);font-size:15px}
.site-footer{border-top:1px solid var(--border);padding:40px 0 24px;background:var(--surface)}
.foot-grid{display:grid;gap:24px;grid-template-columns:1fr}
@media(min-width:800px){.foot-grid{grid-template-columns:1.2fr 1fr 1fr}}
.foot-brand{font-weight:700;font-size:18px;margin:0 0 6px}
.foot-brand a{color:var(--primary);text-decoration:none}
.site-footer h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 10px}
.site-footer ul{list-style:none;margin:0;padding:0}
.site-footer li{margin:6px 0;font-size:14px}
.site-footer li a{color:var(--text2)}
.disclosure{margin-top:28px;padding:16px;background:var(--alt);border:1px solid var(--border);border-radius:8px;font-size:12px;line-height:1.6;color:var(--muted)}
.disclosure p{margin:0 0 8px}
.copy{margin-top:20px}
`;

const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="${t.primary}"/><path d="M9 21l5-10 4 7 2-4 3 7" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`;

// ── Write ───────────────────────────────────────────────────────────────────
rmSync(outDir, { recursive: true, force: true });
const files: Record<string, string> = {
  "index.html": home,
  "privacy/index.html": privacy,
  "terms/index.html": terms,
  "do-not-sell/index.html": doNotSell,
  "disclosures/index.html": disclosures,
  "faq/index.html": faq,
  "rates-and-terms/index.html": rates,
  "assets/site.css": css,
  "assets/logo.svg": logo,
};
for (const [p, c] of Object.entries(files)) {
  const f = join(outDir, p);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, c);
}
console.log(`wrote ${Object.keys(files).length} files to ${outDir} (preset ${preset})`);
