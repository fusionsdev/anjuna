import { describe, expect, it } from "vitest";
import { isExternalUrl, TEMPLATE_RULES, TemplateManifest } from "../src/index.js";
import { fixture } from "./helpers.js";

describe("template contract (TP-2)", () => {
  it("valid manifest parses", () => {
    expect(TemplateManifest.safeParse(fixture("template/template.valid.json")).success).toBe(true);
  });

  it("missing legal pages are rejected", () => {
    const r = TemplateManifest.safeParse(fixture("template/template.invalid.missing-legal.json"));
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join("."));
      expect(paths).toEqual(expect.arrayContaining(["legal_pages.do_not_sell", "legal_pages.disclosures"]));
    }
  });

  it("CTA must post amount + ZIP to /go", () => {
    const ok = fixture<Record<string, any>>("template/template.valid.json");
    expect(TemplateManifest.safeParse({ ...ok, cta: { ...ok.cta, action: "/apply" } }).success).toBe(false);
    expect(TemplateManifest.safeParse({ ...ok, cta: { ...ok.cta, fields: ["zip", "requested_amount"] } }).success).toBe(false);
  });

  it("keyword default must be clean and platform-neutral", () => {
    const ok = fixture<Record<string, any>>("template/template.valid.json");
    expect(TemplateManifest.safeParse({ ...ok, keyword_slot: { default: "funding options" } }).success).toBe(false);
    expect(TemplateManifest.safeParse({ ...ok, name: "aurum-starter" }).success).toBe(false);
  });

  it("only static frameworks are allowed (TP-1)", () => {
    const ok = fixture<Record<string, any>>("template/template.valid.json");
    expect(TemplateManifest.safeParse({ ...ok, framework: "next-ssr" }).success).toBe(false);
  });

  it("markup rules", () => {
    expect(TEMPLATE_RULES.forbiddenWording.test("Get a Personal Loan today")).toBe(true);
    expect(TEMPLATE_RULES.forbiddenWording.test("personal  loans")).toBe(true);
    expect(TEMPLATE_RULES.forbiddenWording.test("Funding Options")).toBe(false);
    expect(TEMPLATE_RULES.ctaFields).toEqual(["requested_amount", "zip"]);
    expect(isExternalUrl("https://cdn.example/x.js")).toBe(true);
    expect(isExternalUrl("//cdn.example/x.js")).toBe(true);
    expect(isExternalUrl("/_astro/x.js")).toBe(false);
  });
});
