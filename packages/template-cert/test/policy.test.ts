import { describe, expect, it } from "vitest";
import { ruleDisposition, TEMPLATE_RULE_POLICY } from "../src/policy.js";
import { runChecks } from "../src/index.js";
import { check, makeSource, validFiles, validIndex } from "./helpers.js";

const index = (html: string) => ({ ...validFiles(), "index.html": html });

describe("submit rule policy", () => {
  it.each(["unknown", "toString", "__proto__", "constructor"])("blocks unknown id %s", (id) => {
    expect(ruleDisposition(id)).toBe("block");
  });

  it("is the severity source for every emitted lint issue", () => {
    const result = check(index(validIndex() + '<input name="email"><img src="https://cdn.example/x.png"><script src="https://cdn.example/x.js"></script><p>Guaranteed approval</p>'));
    for (const issue of result.checks.flatMap((c) => c.issues)) {
      expect(Object.hasOwn(TEMPLATE_RULE_POLICY, issue.checkId)).toBe(true);
      expect(issue.severity).toBe(ruleDisposition(issue.checkId) === "block" ? "error" : "warning");
    }
  });

  it.each([
    ["external-script", '<script src="https://fonts.googleapis.com/x.js"></script>'],
    ["brand", '<p>ANJUNA</p>'],
    ["brand", '<p>Aurum</p>'],
    ["brand", '<script>const key = "phc_testKey123";</script>'],
    ["brand", '<script>const dsn = "https://key@o1.ingest.sentry.io/42";</script>'],
    ["wording", '<p>Personal Loan</p>'],
  ])("blocks %s independently", (rule, extra) => {
    const result = check(index(validIndex() + extra));
    expect(result.ok).toBe(false);
    expect([...new Set(result.checks.flatMap((c) => c.issues).filter((i) => i.severity === "error").map((i) => i.checkId))]).toEqual([rule]);
  });

  it.each([
    ["pii", '<input type="email" name="email">'],
    ["pii", '<form action="/newsletter"><input name="email"></form>'],
    ["external", '<img src="https://cdn.example/x.png">'],
    ["external", '<link rel="stylesheet" href="https://cdn.example/x.css">'],
    ["external", '<iframe src="https://example.com/"></iframe>'],
    ["links", '<a href="/missing/">Missing</a>'],
    ["guarantees", '<p>Guaranteed approval</p>'],
  ])("warns for %s without rejecting", (rule, extra) => {
    const result = check(index(validIndex() + extra));
    expect(result.ok).toBe(true);
    expect(result.checks.flatMap((c) => c.issues).some((i) => i.checkId === rule && i.severity === "warning")).toBe(true);
  });

  it("keeps PII in a CTA advisory when the amount and ZIP still submit", () => {
    const result = check(index(validIndex().replace("</form>", '<input name="email" type="email"></form>')));
    expect(result.ok).toBe(true);
    expect(result.checks.flatMap((c) => c.issues).map((i) => i.checkId)).toEqual(expect.arrayContaining(["pii", "cta-advisory"]));
  });

  it("scans other-brand names and binary asset bytes", () => {
    const source = makeSource(validFiles());
    source.files.set("image.png", new TextEncoder().encode("\0Foreign Brand\0"));
    const result = runChecks(source, { denyIdentifiers: ["Foreign Brand"] });
    expect(result.ok).toBe(false);
    expect(result.checks.flatMap((c) => c.issues).some((i) => i.checkId === "brand" && i.location === "image.png")).toBe(true);
  });
});
