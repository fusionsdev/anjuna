import { describe, expect, it } from "vitest";
import { checkTemplate } from "../src/checker";
import { ctaForm, goodSite, otherSite, page, withFile, withIndex } from "./fixtures";
import { strToU8 } from "fflate";

const rules = (r: ReturnType<typeof checkTemplate>, severity = "error") => [...new Set(r.issues.filter((i) => i.severity === severity).map((i) => i.rule))];

describe("check_template rules", () => {
  it("passes a contract-compliant site", () => {
    const r = checkTemplate(goodSite());
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.summary).toMatch(/^PASS/);
    expect(r.stats.html_pages).toBe(5);
    expect(checkTemplate(otherSite()).pass).toBe(true);
  });

  it("unwraps a dist/ wrapper folder with a warning", () => {
    const wrapped = new Map([...goodSite()].map(([p, b]) => [`dist/${p}`, b] as const));
    const r = checkTemplate(wrapped);
    expect(r.pass).toBe(true);
    expect(rules(r, "warning")).toContain("static-output");
  });

  it("missing keyword slot", () => {
    const r = checkTemplate(withIndex(goodSite(), (h) => h.replace('<span data-kw>Funding Options</span>', "Funding Options")));
    expect(r.pass).toBe(false);
    const issue = r.issues.find((i) => i.rule === "keyword-slot")!;
    expect(issue.message).toMatch(/No keyword slot/);
    expect(issue.fix).toContain("<span data-kw>");
  });

  it("keyword slot outside the h1, nested, duplicated or referenced elsewhere", () => {
    expect(rules(checkTemplate(withIndex(goodSite(), (h) => h.replace('<h1><span data-kw>Funding Options</span> | Check', '<h1>Hello | Check').replace("<p>Answer", '<p><span data-kw>X</span>Answer'))))).toContain("keyword-slot");
    expect(checkTemplate(withIndex(goodSite(), (h) => h.replace("Funding Options</span>", "<b>Funding</b> Options</span>"))).issues.some((i) => /nested/.test(i.message))).toBe(true);
    expect(checkTemplate(withIndex(goodSite(), (h) => h.replace("<p>Answer", '<p><span data-kw>Two</span>Answer'))).issues.some((i) => /2 keyword slots/.test(i.message))).toBe(true);
    expect(checkTemplate(withIndex(goodSite(), (h) => h.replace("</body>", "<script>document.querySelector('[data-kw]')</script></body>"))).issues.some((i) => /more than once/.test(i.message))).toBe(true);
    expect(checkTemplate(withIndex(goodSite(), (h) => h.replace("<span data-kw>Funding Options", "<span data-kw>"))).issues.some((i) => /1-60/.test(i.message))).toBe(true);
  });

  it("CTA form: method, action, fields, buckets, hidden inputs, submit, extra forms", () => {
    const run = (form: string) => checkTemplate(withIndex(goodSite(), (h) => h.replace(/<form[\s\S]*?<\/form>/, form)));
    expect(run(ctaForm({ method: "post" })).issues.some((i) => /method/.test(i.message))).toBe(true);
    expect(run(ctaForm({ action: "https://x.example/post" })).issues.some((i) => /action/.test(i.message))).toBe(true);
    expect(run(ctaForm({ buckets: [350, 2500] })).issues.some((i) => /"2500" is not a canonical bucket/.test(i.message))).toBe(true);
    expect(run(ctaForm({ extra: '<input type="hidden" name="gclid" value="">' })).issues.some((i) => /Hidden input/.test(i.message))).toBe(true);
    expect(run(ctaForm({ extra: '<input name="amount_other">' })).issues.some((i) => /Unexpected CTA field/.test(i.message))).toBe(true);
    expect(run(ctaForm().replace('pattern="[0-9]{5}"', "")).issues.some((i) => /5 digits/.test(i.message))).toBe(true);
    expect(run(ctaForm().replace('<button type="submit">Continue</button>', "")).issues.some((i) => /submit button/.test(i.message))).toBe(true);
    expect(run(ctaForm().replace('name="zip"', 'name="postal"')).issues.some((i) => /"zip" field/.test(i.message))).toBe(true);
    expect(run(ctaForm().replace("<select", "<input").replace("</select>", "")).pass).toBe(false);
    const extraForm = checkTemplate(withIndex(goodSite(), (h) => h.replace("</main>", '<form action="/subscribe"><input name="q"></form></main>')));
    expect(extraForm.issues.some((i) => i.rule === "cta-form" && /extra <form>/.test(i.message))).toBe(true);
    expect(checkTemplate(withIndex(goodSite(), (h) => h.replace(" data-cta", ""))).issues.some((i) => /No CTA form/.test(i.message))).toBe(true);
  });

  it("required pages and legal footer links", () => {
    const files = goodSite();
    files.delete("terms/index.html");
    const r = checkTemplate(files);
    expect(r.issues.some((i) => i.rule === "required-pages" && /\/terms\//.test(i.message))).toBe(true);
    const noLinks = checkTemplate(withIndex(goodSite(), (h) => h.replace('<a href="/disclosures/">Disclosures</a>', "")));
    expect(noLinks.issues.some((i) => i.rule === "legal-footer-links" && i.file === "index.html" && /disclosures/.test(i.message))).toBe(true);
    expect(checkTemplate(new Map([["index.html", strToU8("<html></html>")]])).pass).toBe(false);
  });

  it("PII inputs", () => {
    for (const field of ['<input type="email" name="e">', '<input name="first_name">', '<input name="x" placeholder="Your phone">', '<input name="ssn">', '<textarea name="note"></textarea>', '<input name="x" autocomplete="email">', '<input type="password" name="p">']) {
      const r = checkTemplate(withIndex(goodSite(), (h) => h.replace("</main>", `<div>${field}</div></main>`)));
      expect(rules(r), field).toContain("pii-inputs");
    }
    expect(rules(checkTemplate(goodSite()))).not.toContain("pii-inputs");
  });

  it("banned wording and guarantee claims", () => {
    const personal = checkTemplate(withIndex(goodSite(), (h) => h.replace("Answer two", "Personal&nbsp;Loans for you. Answer two")));
    expect(personal.issues.some((i) => i.rule === "banned-wording")).toBe(true);
    expect(rules(checkTemplate(withIndex(goodSite(), (h) => h.replace("Answer two", "Personal<b> Loan</b> offers. Answer two"))))).toContain("banned-wording");
    expect(rules(checkTemplate(withFile(goodSite(), "assets/personal-loan-hero.png", new Uint8Array(10))))).toContain("banned-wording");
    expect(rules(checkTemplate(withFile(goodSite(), "assets/app.js", "const t='personal loans'")))).toContain("banned-wording");
    for (const claim of ["Guaranteed approval today", "No credit check needed", "Get instant approval", "100% approved"]) {
      expect(rules(checkTemplate(withIndex(goodSite(), (h) => h.replace("Answer two", `${claim}. Answer two`)))), claim).toContain("guarantee-claims");
    }
    expect(rules(checkTemplate(goodSite()))).not.toContain("guarantee-claims");
  });

  it("external scripts, analytics and resources", () => {
    const head = (html: string) => checkTemplate(withIndex(goodSite(), (h) => h.replace("</head>", `${html}</head>`)));
    expect(rules(head('<script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>'))).toContain("external-scripts");
    expect(rules(head('<script src="//cdn.example.com/x.js"></script>'))).toContain("external-scripts");
    expect(rules(head("<script>window.dataLayer=[];gtag('config','G-1')</script>"))).toContain("external-scripts");
    expect(rules(head('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">'))).toContain("external-resources");
    expect(rules(head('<link rel="preconnect" href="https://fonts.gstatic.com">'))).toContain("external-resources");
    expect(rules(head("<style>@import url('https://fonts.googleapis.com/x.css');</style>"))).toContain("external-resources");
    const body = (html: string) => checkTemplate(withIndex(goodSite(), (h) => h.replace("</main>", `${html}</main>`)));
    expect(rules(body('<img src="https://images.example.com/a.jpg" alt="">'))).toContain("external-resources");
    expect(rules(body('<iframe src="https://www.youtube.com/embed/x"></iframe>'))).toContain("external-resources");
    expect(rules(checkTemplate(withFile(goodSite(), "assets/site.css", "@font-face{font-family:A;src:url(https://cdn.example/a.woff2)}")))).toContain("external-resources");
    expect(rules(checkTemplate(withFile(goodSite(), "assets/app.js", "!function(){posthog.init('x')}()")))).toContain("external-scripts");
    expect(body('<a href="https://example.com/outbound">out</a>').pass).toBe(true);
  });

  it("cloaking", () => {
    expect(rules(checkTemplate(withFile(goodSite(), "assets/app.js", "if(/googlebot/i.test(x)){hide()}")))).toContain("cloaking");
    expect(rules(checkTemplate(withFile(goodSite(), "assets/app.js", "const g=new URLSearchParams(location.search).get('gclid')")))).toContain("cloaking");
    const warn = checkTemplate(withFile(goodSite(), "assets/app.js", "var u=navigator.userAgent"));
    expect(warn.pass).toBe(true);
    expect(rules(warn, "warning")).toContain("cloaking");
  });

  it("brand-clean: platform strings, keys, DSNs, other brands", () => {
    expect(rules(checkTemplate(withIndex(goodSite(), (h) => h.replace("<title>", "<!-- built by Anjuna --><title>"))))).toContain("brand-clean");
    expect(rules(checkTemplate(withFile(goodSite(), "assets/a.js.map", '{"sources":["/work/AURUM/src/x.ts"]}')))).toContain("brand-clean");
    expect(rules(checkTemplate(withFile(goodSite(), "assets/a.js", 'k="phc_abcdefghijklmnopqrstuvwxyz0123"')))).toContain("brand-clean");
    expect(rules(checkTemplate(withFile(goodSite(), "assets/a.js", 'd="https://0123456789abcdef0123@o1.ingest.sentry.io/1"')))).toContain("brand-clean");
    const brands = [{ name: "Lantern Finance", domain: "lanternfinance.com" }];
    expect(rules(checkTemplate(withIndex(goodSite(), (h) => h.replace("Answer two", "Lantern Finance says hi. Answer two")), { otherBrands: brands }))).toContain("brand-clean");
    expect(rules(checkTemplate(withIndex(goodSite(), (h) => h.replace('href="/"', 'href="https://lanternfinance.com/"')), { otherBrands: brands }))).toContain("brand-clean");
    expect(checkTemplate(goodSite(), { otherBrands: brands }).pass).toBe(true);
  });

  it("reserved paths, server files, cfg element", () => {
    expect(rules(checkTemplate(withFile(goodSite(), "go/index.html", "x")))).toContain("reserved-path");
    expect(rules(checkTemplate(withFile(goodSite(), "api/data.json", "{}")))).toContain("reserved-path");
    expect(rules(checkTemplate(withFile(goodSite(), "_worker.js", "export default {}")))).toContain("static-output");
    expect(rules(checkTemplate(withFile(goodSite(), "functions/x.js", "x")))).toContain("static-output");
    expect(rules(checkTemplate(withFile(goodSite(), "contact.php", "<?php")))).toContain("static-output");
    expect(rules(checkTemplate(withIndex(goodSite(), (h) => h.replace("</body>", '<script type="application/json" id="cfg">{}</script></body>'))))).toContain("cfg-element");
  });

  it("links resolve (and /go, /api, /_f are exempt)", () => {
    expect(checkTemplate(withIndex(goodSite(), (h) => h.replace("</main>", '<a href="/about/">About</a><a href="/go">go</a><a href="/api/x">api</a><img src="/img/missing.png"></main>'))).issues.filter((i) => i.rule === "links-resolve").map((i) => i.message)).toEqual([
      "Broken a reference: /about/",
      "Broken img reference: /img/missing.png",
    ]);
    expect(rules(checkTemplate(withFile(goodSite(), "assets/site.css", "body{background:url(/img/nope.png)}")))).toContain("links-resolve");
    const relative = goodSite();
    relative.set("privacy/index.html", strToU8(page('<a href="../terms/">t</a><a href="missing.html">m</a>')));
    expect(checkTemplate(relative).issues.filter((i) => i.rule === "links-resolve").map((i) => i.message)).toEqual(["Broken a reference: missing.html"]);
  });

  it("caps repeated issues per rule", () => {
    const many = Array.from({ length: 40 }, (_, i) => `<a href="/missing${i}/">x</a>`).join("");
    const r = checkTemplate(withIndex(goodSite(), (h) => h.replace("</main>", `${many}</main>`)));
    expect(r.issues.length).toBeLessThan(25);
    expect(r.issues.some((i) => /more "links-resolve"/.test(i.message))).toBe(true);
  });
});
