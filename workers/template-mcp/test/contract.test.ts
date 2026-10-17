import { describe, expect, it } from "vitest";
import doc from "../../../docs/template-contract.md?raw";
import { AMOUNT_BUCKETS, REQUIRED_PAGES, RESERVED_PATHS, contractForBuilders } from "../src/contract";

describe("contract constants match docs/template-contract.md", () => {
  it("amount buckets", () => {
    const line = doc.split("\n").find((l) => l.includes("canonical buckets"))!;
    const bold = /\*\*(\d[\d, ]+\d)\*\*/.exec(line)![1]!;
    const listed = bold.split(",").map((n) => Number(n.trim()));
    expect(listed).toEqual([...AMOUNT_BUCKETS]);
  });

  it("required legal pages and reserved paths", () => {
    for (const page of REQUIRED_PAGES) expect(doc).toContain(`\`${page.route}\``);
    for (const path of RESERVED_PATHS) expect(doc).toContain(`/${path}`);
  });

  it("banned wording and claims are documented", () => {
    expect(doc).toMatch(/Personal Loan/);
    for (const phrase of ["guaranteed approval", "no credit check", "instant approval"]) expect(doc).toContain(phrase);
  });

  it("get_template_contract payload carries every rule and the workflow", () => {
    const payload = contractForBuilders();
    expect(payload.rules.length).toBeGreaterThanOrEqual(15);
    expect(payload.cta_form_example).toContain('action="/go"');
    expect(payload.workflow.join(" ")).toContain("similarity_check");
  });

  it("page text rules are documented and served", () => {
    expect(doc).toContain("data-brand");
    expect(doc).toContain('<meta name="description"');
    expect(contractForBuilders().rules.map((r) => r.id)).toEqual(expect.arrayContaining(["page-text", "brand-slot"]));
  });

  it("tells the builder to publish and submit the URL", () => {
    const steps = contractForBuilders().how_to_submit.join(" ");
    expect(steps).toContain("probe_url");
    expect(steps).toContain("submit_template_url");
    expect(doc).toContain("## 9. How to submit (bolt.new)");
  });
});
