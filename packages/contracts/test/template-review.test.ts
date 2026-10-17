import { describe, expect, it } from "vitest";
import { TEMPLATE_VERSION_REVIEW_STATUS, TemplateId, TemplateSubmitResult, templateSlug } from "../src/index.js";

describe("template review contracts", () => {
  it("maps every factory status to what the dashboard shows", () => {
    expect(TEMPLATE_VERSION_REVIEW_STATUS).toEqual({
      draft: "checking", certifying: "checking", rejected: "rejected", certified: "awaiting_approval", sealed: "approved",
    });
  });

  it("turns any template name into a valid template id", () => {
    expect(templateSlug("Harbor Funding!")).toBe("harbor-funding");
    expect(templateSlug("Café Ñandú")).toBe("cafe-nandu");
    for (const name of ["แบรนด์", "x", "  "]) expect(TemplateId.safeParse(templateSlug(name)).success, name).toBe(true);
  });

  it("validates the submit result shape", () => {
    const result = {
      status: "rejected", template_version_id: null, version: null, sha256: null, dashboard_url: null,
      issues: [{ rule: "keyword", file: "index.html", message: "No data-kw.", fix: "Add one." }],
      warnings: [], text_defaults: null, similarity: null, next_step: "Fix every issue.",
    };
    expect(TemplateSubmitResult.parse(result)).toEqual(result);
    expect(TemplateSubmitResult.safeParse({ ...result, status: "received" }).success).toBe(false);
  });
});
