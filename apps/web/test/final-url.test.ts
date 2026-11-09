import { describe, expect, it } from "vitest";
import { finalUrl } from "../src/client/final-url";

// T13 A1/A3: Google substitutes {keyword} and {campaignid}; core reads utm_campaign to map a campaign to its brand.
describe("finalUrl", () => {
  it("carries utm_campaign={campaignid} after the keyword, braces literal", () => {
    expect(finalUrl(["a.com"])).toBe("https://a.com/?keyword={keyword}&utm_campaign={campaignid}");
  });
  it("never percent-encodes the braces", () => {
    expect(finalUrl(["a.com"])).not.toMatch(/%7B|%7D/i);
  });
  it("answers null with no hostname", () => {
    expect(finalUrl([])).toBeNull();
  });
});
