import { describe, expect, it } from "vitest";
import { blockingDnsRecords, brandHostnames, detachCustomDomain, getZone, listCustomDomains, publicApexDnsRecords, uploadAssetBucket } from "../src/cf-api";

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

describe("blockingDnsRecords", () => {
  type Domain = { id: string; hostname: string; service?: string };
  type Dns = { id: string; type: string; name: string };

  /** Routes the zone DNS API, the account Workers Domains API and public DNS (DoH) like Cloudflare does. */
  function api(options: { dns?: Dns[]; domains?: Domain[]; dnsAuthFails?: boolean; domainsFail?: boolean; doh?: Array<{ name: string; type: number }> }) {
    const urls: string[] = [];
    const fetcher = async (input: string) => {
      urls.push(input);
      const url = new URL(input);
      if (url.hostname === "cloudflare-dns.com") {
        const name = url.searchParams.get("name")!;
        const code = { A: 1, AAAA: 28, CNAME: 5 }[url.searchParams.get("type")!];
        const answers = (options.doh ?? []).filter((a) => a.name === name && a.type === code).map((a) => ({ name: `${a.name}.`, type: a.type }));
        return Response.json({ Status: 0, ...(answers.length ? { Answer: answers } : {}) });
      }
      if (url.pathname.endsWith("/dns_records")) {
        if (options.dnsAuthFails) return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });
        const name = url.searchParams.get("name");
        return Response.json({ success: true, result: (options.dns ?? []).filter((r) => r.name === name) });
      }
      if (url.pathname.endsWith("/workers/domains")) {
        if (options.domainsFail) return Response.json({ success: false, errors: [{ code: 10001, message: "boom" }] }, { status: 500 });
        // Cloudflare applies the service filter itself.
        const service = url.searchParams.get("service");
        return Response.json({ success: true, result: (options.domains ?? []).filter((d) => !service || d.service === service) });
      }
      throw new Error(`unexpected request ${input}`);
    };
    return { fetcher, domainCalls: () => urls.filter((u) => u.includes("/workers/domains")) };
  }
  const run = (hostnames: string[], a: ReturnType<typeof api>) => blockingDnsRecords("t", "acct", "zone-1", "brand-x", hostnames, a.fetcher);
  const own = (hostname: string): Domain => ({ id: `dom-${hostname}`, hostname, service: "brand-x" });
  const aaaa = (name: string): Dns => ({ id: `dns-${name}`, type: "AAAA", name });
  /** The domains list answers with `entries` whatever the filter says; everything else is `api`. */
  const withDomains = (a: ReturnType<typeof api>, entries: Domain[]) => async (input: string) =>
    new URL(input).pathname.endsWith("/workers/domains") ? Response.json({ success: true, result: entries }) : a.fetcher(input);

  it("returns nothing and never lists Custom Domains when the zone has no record", async () => {
    const a = api({});
    await expect(run(["brand.example.com"], a)).resolves.toEqual([]);
    expect(a.domainCalls()).toEqual([]);
  });

  it("accepts the record of a hostname attached to the brand script", async () => {
    const a = api({ dns: [aaaa("brand.example.com")], domains: [own("brand.example.com")] });
    await expect(run(["brand.example.com"], a)).resolves.toEqual([]);
    expect(a.domainCalls()).toEqual(["https://api.cloudflare.com/client/v4/accounts/acct/workers/domains?zone_id=zone-1&service=brand-x"]);
  });

  it("blocks a record on a hostname that has no Custom Domain", async () => {
    const a = api({ dns: [{ id: "r1", type: "A", name: "brand.example.com" }] });
    await expect(run(["brand.example.com"], a)).resolves.toEqual([{ id: "r1", type: "A", name: "brand.example.com" }]);
  });

  it("blocks a record on a hostname attached to a different script", async () => {
    const a = api({ dns: [aaaa("brand.example.com")], domains: [{ id: "d1", hostname: "brand.example.com", service: "brand-y" }] });
    await expect(run(["brand.example.com"], a)).resolves.toEqual([aaaa("brand.example.com")]);
  });

  it("blocks when the list returns another script's entry despite the service filter", async () => {
    const a = api({ dns: [aaaa("brand.example.com")] });
    const leaky = withDomains(a, [{ id: "d1", hostname: "brand.example.com", service: "brand-y" }]);
    await expect(blockingDnsRecords("t", "acct", "zone-1", "brand-x", ["brand.example.com"], leaky)).resolves.toEqual([aaaa("brand.example.com")]);
  });

  it("judges each hostname on its own: own apex passes, foreign www blocks", async () => {
    const a = api({ dns: [aaaa("brand.com"), { id: "r2", type: "CNAME", name: "www.brand.com" }], domains: [own("brand.com")] });
    await expect(run(["brand.com", "www.brand.com"], a)).resolves.toEqual([{ id: "r2", type: "CNAME", name: "www.brand.com" }]);
  });

  it("matches the attached hostname case-insensitively and ignores a trailing dot", async () => {
    const a = api({ dns: [aaaa("brand.example.com")], domains: [{ id: "d1", hostname: "Brand.Example.com.", service: "brand-x" }] });
    await expect(run(["brand.example.com"], a)).resolves.toEqual([]);
  });

  it("keeps an entry the filtered list returns without a service field", async () => {
    const a = api({ dns: [aaaa("brand.example.com")] });
    const bare = withDomains(a, [{ id: "d1", hostname: "brand.example.com" }]);
    await expect(blockingDnsRecords("t", "acct", "zone-1", "brand-x", ["brand.example.com"], bare)).resolves.toEqual([]);
  });

  it("fails closed when the Custom Domains list cannot be read", async () => {
    const a = api({ dns: [aaaa("brand.example.com")], domainsFail: true });
    await expect(run(["brand.example.com"], a)).rejects.toThrow("CF API GET /accounts/acct/workers/domains");
  });

  describe("public DNS fallback (zone DNS API answers 10000)", () => {
    it("accepts the public record of a hostname attached to the brand script", async () => {
      const a = api({ dnsAuthFails: true, doh: [{ name: "brand.example.com", type: 28 }], domains: [own("brand.example.com")] });
      await expect(run(["brand.example.com"], a)).resolves.toEqual([]);
      expect(a.domainCalls()).toHaveLength(1);
    });

    it("blocks the public record of a hostname with no Custom Domain of this brand", async () => {
      const a = api({ dnsAuthFails: true, doh: [{ name: "brand.example.com", type: 1 }] });
      await expect(run(["brand.example.com"], a)).resolves.toEqual([{ id: "public-dns", type: "A", name: "brand.example.com" }]);
    });

    it("blocks a public record on a hostname attached to a different script", async () => {
      const a = api({ dnsAuthFails: true, doh: [{ name: "brand.example.com", type: 28 }], domains: [{ id: "d1", hostname: "brand.example.com", service: "brand-y" }] });
      await expect(run(["brand.example.com"], a)).resolves.toEqual([{ id: "public-dns", type: "AAAA", name: "brand.example.com" }]);
    });
  });
});
