import { describe, expect, it } from "vitest";
import { brandHostnames, detachCustomDomain, getZone, listCustomDomains, publicApexDnsRecords, uploadAssetBucket } from "../src/cf-api";

describe("brandHostnames", () => {
  it("serves the apex and its www for a brand on its own zone", () => {
    expect(brandHostnames("withulaon.com", "withulaon.com")).toEqual(["withulaon.com", "www.withulaon.com"]);
  });

  it("serves only the bare domain for a brand on a subdomain of its zone", () => {
    expect(brandHostnames("demo05.aduplift.ai", "aduplift.ai")).toEqual(["demo05.aduplift.ai"]);
  });

  it("compares case-insensitively and tolerates a trailing dot", () => {
    expect(brandHostnames("Aduplift.AI.", "aduplift.ai")).toEqual(["aduplift.ai", "www.aduplift.ai"]);
    expect(brandHostnames("Demo05.Aduplift.AI", "ADUPLIFT.AI.")).toEqual(["demo05.aduplift.ai"]);
  });
});

describe("getZone", () => {
  const zoneResponse = (zones: Array<{ id: string; name?: string; status: string }>) => Response.json({ success: true, result: zones });

  function recordingFetcher(byName: (name: string) => Array<{ id: string; name?: string; status: string }>) {
    const names: string[] = [];
    const fetcher = async (input: string) => {
      const name = new URL(input).searchParams.get("name")!;
      names.push(name);
      return zoneResponse(byName(name));
    };
    return { fetcher, names };
  }

  it("returns the zone on the first try for an apex domain", async () => {
    const { fetcher, names } = recordingFetcher(() => [{ id: "zone-aduplift", name: "aduplift.ai", status: "active" }]);
    await expect(getZone("test-token", "aduplift.ai", fetcher)).resolves.toMatchObject({ id: "zone-aduplift", name: "aduplift.ai", status: "active" });
    expect(names).toEqual(["aduplift.ai"]);
  });

  it("resolves a subdomain brand domain to the parent zone and its name", async () => {
    const { fetcher, names } = recordingFetcher((name) => (name === "aduplift.ai" ? [{ id: "zone-aduplift", name: "aduplift.ai", status: "active" }] : []));
    await expect(getZone("test-token", "demo05.aduplift.ai", fetcher)).resolves.toMatchObject({ id: "zone-aduplift", name: "aduplift.ai" });
    expect(names).toEqual(["demo05.aduplift.ai", "aduplift.ai"]);
  });

  it("resolves a deeper subdomain one label at a time", async () => {
    const { fetcher, names } = recordingFetcher((name) => (name === "example.com" ? [{ id: "zone-example", name: "example.com", status: "active" }] : []));
    await expect(getZone("test-token", "a.b.example.com", fetcher)).resolves.toMatchObject({ id: "zone-example", name: "example.com" });
    expect(names).toEqual(["a.b.example.com", "b.example.com", "example.com"]);
  });

  it("throws listing every tried name when no zone matches at any level", async () => {
    const { fetcher, names } = recordingFetcher(() => []);
    await expect(getZone("test-token", "demo05.aduplift.ai", fetcher)).rejects.toThrow(
      "Zone not found for domain demo05.aduplift.ai (tried: demo05.aduplift.ai, aduplift.ai)",
    );
    expect(names).toEqual(["demo05.aduplift.ai", "aduplift.ai"]);
  });

  it("still throws when the matching zone is not active", async () => {
    const { fetcher } = recordingFetcher(() => [{ id: "zone-pending", status: "pending" }]);
    await expect(getZone("test-token", "aduplift.ai", fetcher)).rejects.toThrow(
      "Zone aduplift.ai is not active (status=pending)",
    );
  });

  it("never queries a bare TLD and URL-encodes the name parameter", async () => {
    const urls: string[] = [];
    const fetcher = async (input: string) => {
      urls.push(input);
      return zoneResponse([{ id: "zone-example", name: "site.example", status: "active" }]);
    };
    await expect(getZone("test-token", "site.example", fetcher)).resolves.toMatchObject({ id: "zone-example", name: "site.example" });
    expect(urls).toEqual(["https://api.cloudflare.com/client/v4/zones?name=site.example&per_page=1"]);
  });
});

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
    await expect(publicApexDnsRecords(["example.com"], async () => new Response(body)))
      .rejects.toThrow("Public DNS lookup A example.com failed: HTTP 200");
  });

  it.each(["", "<html>bad response</html>"])("keeps asset upload parse failures informative: %s", async (body) => {
    await expect(uploadAssetBucket("test-token", "account", [], async () => new Response(body, { status: 502 })))
      .rejects.toThrow("Asset upload failed: 502");
  });
});
