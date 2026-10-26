import { TEMPLATE_RULE_POLICY } from "@anjuna/template-cert/policy";
import { describe, expect, it } from "vitest";
import doc from "../../../docs/template-contract.md?raw";
import { AMOUNT_BUCKETS, REQUIRED_PAGES, RESERVED_PATHS, contractForBuilders } from "../src/contract";
import { UPLOAD_BATCH_CHARS } from "../src/submit";

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
    expect(payload.submission_policy).toBe(TEMPLATE_RULE_POLICY);
    expect(payload.intro).toContain("do not prevent awaiting_approval");
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

  it("tells local agents to zip the site and submit it with curl", () => {
    const steps = contractForBuilders().local_agent_submit.join(" ");
    expect(steps).toContain("/submit-zip");
    expect(steps).toContain("ANJUNA_BUILDER_KEY");
    expect(steps).toContain("Compress-Archive");
    expect(steps).not.toMatch(/aduplift/i);
    expect(doc).toContain("## 10. Local agents (Open Design)");
  });

  it("serves the upload batch size in the steps and the doc", () => {
    const steps = contractForBuilders().how_to_submit.join(" ");
    expect(steps).toContain("begin_upload");
    expect(steps).toContain(`at most ${UPLOAD_BATCH_CHARS} characters`);
    expect(doc).toContain(`at most ${UPLOAD_BATCH_CHARS.toLocaleString("en-US")} characters`);
  });
});
