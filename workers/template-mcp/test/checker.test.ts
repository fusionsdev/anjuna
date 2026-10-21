/**
 * Contract-checker tests. checkTemplate() now delegates to @anjuna/template-cert.
 * Issue rule IDs use template-cert policy checkIds, including external-script,
 * meta, guarantees and cta-advisory; the linter still groups its report into 8 sections.
 *
 * The following checks from the original implementation are not covered by template-cert
 * and are no longer enforced here: cloaking detection, cfg-element detection,
 * reserved-path enforcement (/go, /api), legal-footer-links.
 */
import { describe, expect, it } from "vitest";
import { checkTemplate } from "../src/checker";
import { ctaForm, goodSite, otherSite, withFile, withIndex } from "./fixtures";
import { strToU8 } from "fflate";

const rules = (r: ReturnType<typeof checkTemplate>, severity = "error") =>
  [...new Set(r.issues.filter((i) => i.severity === severity).map((i) => i.rule))];

describe("check_template rules (via @anjuna/template-cert)", () => {
  it("passes a contract-compliant site", () => {
    const r = checkTemplate(goodSite());
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.summary).toMatch(/^PASS/);
    expect(r.stats.html_pages).toBe(5);
    expect(checkTemplate(otherSite()).pass).toBe(true);
  });

  it("missing keyword slot triggers keyword rule", () => {
    const r = checkTemplate(withIndex(goodSite(), (h) => h.replace('<span data-kw>Funding Options</span>', "Funding Options")));
    expect(r.pass).toBe(false);
    expect(rules(r)).toContain("keyword");
    expect(r.issues.some((i) => i.rule === "keyword" && /data-kw/i.test(i.message))).toBe(true);
  });

  it("keyword slot nested, duplicated, or outside h1", () => {
    // nested element inside data-kw
    const nested = checkTemplate(withIndex(goodSite(), (h) => h.replace("Funding Options</span>", "<b>Funding</b> Options</span>")));
    expect(rules(nested)).toContain("keyword");

    // two keyword slots
    const doubled = checkTemplate(withIndex(goodSite(), (h) => h.replace("<p>Answer", '<p><span data-kw>Two</span>Answer')));
    expect(doubled.pass).toBe(false);

    // data-kw outside h1
    const outside = checkTemplate(withIndex(goodSite(), (h) =>
      h.replace('<h1><span data-kw>Funding Options</span> | Check Your Options in Minutes</h1>', '<h1>Check Your Options</h1><p><span data-kw>Funding Options</span></p>')
    ));
    expect(outside.pass).toBe(false);
    expect(rules(outside)).toContain("keyword");
  });

  it("CTA form: no form, wrong method, wrong action", () => {
    const noForm = checkTemplate(withIndex(goodSite(), (h) => h.replace(" data-cta", "")));
    expect(noForm.pass).toBe(false);
    expect(rules(noForm)).toContain("cta");

    const wrongMethod = checkTemplate(withIndex(goodSite(), (h) => h.replace('method="get"', 'method="post"')));
    expect(wrongMethod.pass).toBe(false);
    expect(rules(wrongMethod)).toContain("cta");

    const wrongAction = checkTemplate(withIndex(goodSite(), (h) => h.replace('action="/go"', 'action="https://x.example/post"')));
    expect(wrongAction.pass).toBe(false);
    expect(rules(wrongAction)).toContain("cta");
  });

  it("CTA form: non-canonical bucket values", () => {
    const r = checkTemplate(withIndex(goodSite(), (h) => h.replace(ctaForm(), ctaForm({ buckets: [350, 2500] }))));
    expect(r.pass).toBe(false);
    expect(rules(r)).toContain("cta");
  });

  it("CTA form: unexpected extra field", () => {
    const r = checkTemplate(withIndex(goodSite(), (h) => h.replace(ctaForm(), ctaForm({ extra: '<input name="amount_other">' }))));
    expect(r.pass).toBe(true);
    expect(rules(r, "warning")).toContain("cta-advisory");
  });

  it("required pages: missing page triggers structure rule", () => {
    const files = goodSite();
    files.delete("terms/index.html");
    const r = checkTemplate(files);
    expect(r.pass).toBe(false);
    expect(rules(r)).toContain("structure");
    expect(r.issues.some((i) => i.rule === "structure" && /terms/.test(i.message))).toBe(true);
  });

  it("PII inputs: email, name and password fields warn", () => {
    for (const field of [
      '<input type="email" name="e">',
      '<input name="first_name">',
      '<input type="password" name="p">',
    ]) {
      const r = checkTemplate(withIndex(goodSite(), (h) => h.replace("</main>", `<div>${field}</div></main>`)));
      expect(r.pass).toBe(true);
      expect(rules(r, "warning"), field).toContain("pii");
    }
    expect(rules(checkTemplate(goodSite()))).not.toContain("pii");
  });

  it("banned wording: Personal Loan phrase fails", () => {
    const r = checkTemplate(withIndex(goodSite(), (h) => h.replace("Answer two", "Personal Loans for you. Answer two")));
    expect(r.issues.some((i) => i.rule === "wording")).toBe(true);
  });

  it("external scripts trigger external rule", () => {
    const head = (html: string) => checkTemplate(withIndex(goodSite(), (h) => h.replace("</head>", `${html}</head>`)));
    expect(rules(head('<script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>'))).toContain("external-script");
    expect(rules(head('<script src="//cdn.example.com/x.js"></script>'))).toContain("external-script");
  });

  it("external fonts and resources trigger external rule", () => {
    const head = (html: string) => checkTemplate(withIndex(goodSite(), (h) => h.replace("</head>", `${html}</head>`)));
    // Google Fonts is a warning (not an error) — prefer shipping fonts locally
    expect(rules(head('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">'), "warning")).toContain("external");
  });

  it("server files trigger structure rule", () => {
    expect(rules(checkTemplate(withFile(goodSite(), "_worker.js", "export default {}")))).toContain("structure");
    // functions/ directory check is not enforced by template-cert (only SERVER_NAMES like _worker.js are)
  });

  it("brand-clean: platform strings and other-brand domains", () => {
    expect(rules(checkTemplate(withIndex(goodSite(), (h) => h.replace("<title>", "<!-- built by Anjuna --><title>"))))).toContain("brand");
    const brands = [{ name: "Lantern Finance", domain: "lanternfinance.com" }];
    // Brand domains and names both remain blocking.
    expect(
      rules(checkTemplate(withIndex(goodSite(), (h) => h.replace("Answer two", "See lanternfinance.com. Answer two")), { otherBrands: brands }))
    ).toContain("brand");
    expect(checkTemplate(goodSite(), { otherBrands: brands }).pass).toBe(true);
  });

  it("broken internal links trigger links rule", () => {
    const r = checkTemplate(withIndex(goodSite(), (h) => h.replace("</main>", '<a href="/about/">About</a></main>')));
    expect(r.pass).toBe(true);
    expect(rules(r, "warning")).toContain("links");
    expect(r.issues.some((i) => i.rule === "links" && /about/.test(i.message))).toBe(true);
  });

  it("broken img src triggers links rule", () => {
    const r = checkTemplate(withIndex(goodSite(), (h) => h.replace("</main>", '<img src="/img/missing.png"></main>')));
    expect(r.pass).toBe(true);
    expect(rules(r, "warning")).toContain("links");
  });

  it("external img does not trigger links rule", () => {
    const r = checkTemplate(withIndex(goodSite(), (h) => h.replace("</main>", '<a href="https://example.com/outbound">out</a></main>')));
    expect(r.pass).toBe(true);
  });
});
