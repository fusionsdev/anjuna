import { describe, expect, it } from "vitest";
import { detachCustomDomain, listCustomDomains, publicApexDnsRecords, uploadAssetBucket } from "../src/cf-api";

describe("Cloudflare response handling", () => {
  it.each([200, 204])("accepts an empty successful DELETE (%s)", async (status) => {
    await expect(detachCustomDomain("test-token", "account", "domain", async () =>
      new Response(null, { status }))).resolves.toBeUndefined();
  });

  it("keeps supporting JSON DELETE responses", async () => {
    await expect(detachCustomDomain("test-token", "account", "domain", async () =>
      Response.json({ success: true, result: null }))).resolves.toBeUndefined();
  });

  it.each([
    [502, "<html>Bad gateway</html>", "Bad gateway"],
    [403, "", "empty response"],
    [200, "not JSON", "not JSON"],
    [200, "null", "invalid JSON envelope"],
  ])("reports DELETE status and body instead of a JSON parse error (%s, %s)", async (status, body, detail) => {
    await expect(detachCustomDomain("test-token", "account", "domain", async () =>
      new Response(body, { status }))).rejects.toThrow(
        new RegExp(`CF API DELETE /accounts/account/workers/domains/domain failed:.*HTTP ${status}.*${detail}`),
      );
  });

  it("does not accept an empty response when a JSON result is required", async () => {
    await expect(listCustomDomains("test-token", "account", "zone", "script", async () =>
      new Response(null, { status: 204 }))).rejects.toThrow("HTTP 204: empty response");
  });

  it("preserves Cloudflare error codes for DNS auth fallback", async () => {
    await expect(detachCustomDomain("test-token", "account", "domain", async () =>
      Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 })))
      .rejects.toThrow("failed: 10000: Authentication error (HTTP 403)");
  });

  it("rejects an HTTP error even if the envelope says success", async () => {
    await expect(detachCustomDomain("test-token", "account", "domain", async () =>
      Response.json({ success: true, result: null }, { status: 500 }))).rejects.toThrow("HTTP 500");
  });

  it.each(["", "<html>bad response</html>"])("reports invalid public DNS responses: %s", async (body) => {
    await expect(publicApexDnsRecords("example.com", async () => new Response(body)))
      .rejects.toThrow("Public DNS lookup A example.com failed: HTTP 200");
  });

  it.each(["", "<html>bad response</html>"])("keeps asset upload parse failures informative: %s", async (body) => {
    await expect(uploadAssetBucket("test-token", "account", [], async () => new Response(body, { status: 502 })))
      .rejects.toThrow("Asset upload failed: 502");
  });
});
