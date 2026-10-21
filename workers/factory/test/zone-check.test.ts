import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import factory from "../src/index";
import type { Env } from "../src/env";
import { parseZoneCheckRequest, zoneCheck } from "../src/zone-check";

type Zone = { id: string; name: string; status: string; name_servers?: string[] };
type Dns = { id: string; type: string; name: string };

/** The Cloudflare zone and DNS read APIs. Any other method or path fails the test: the pre-check is read-only. */
function api(options: { zones?: Zone[]; dns?: Dns[]; domains?: Array<{ id: string; hostname: string; service?: string }> }) {
  const calls: Array<{ method: string; url: string }> = [];
  const fetcher = async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: input });
    const url = new URL(input);
    if (method !== "GET") throw new Error(`zone check must not ${method} ${input}`);
    if (url.pathname === "/client/v4/zones") {
      const name = url.searchParams.get("name");
      return Response.json({ success: true, result: (options.zones ?? []).filter((zone) => zone.name === name) });
    }
    if (url.pathname.endsWith("/dns_records")) {
      return Response.json({ success: true, result: (options.dns ?? []).filter((record) => record.name === url.searchParams.get("name")) });
    }
    if (url.pathname.endsWith("/workers/domains")) {
      const service = url.searchParams.get("service");
      return Response.json({ success: true, result: (options.domains ?? []).filter((domain) => !service || domain.service === service) });
    }
    throw new Error(`unexpected request ${input}`);
  };
  return { fetcher, calls };
}

const ACTIVE: Zone = { id: "zone-1", name: "maple.test", status: "active", name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"] };

describe("zoneCheck", () => {
  it("reports an active zone with no conflicts", async () => {
    const a = api({ zones: [ACTIVE] });
    await expect(zoneCheck("t", "acct", "maple.test", undefined, a.fetcher)).resolves.toEqual({
      zone_active: true, zone_name: "maple.test", nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"], conflicting_records: [],
    });
    expect(a.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("reports a pending zone as inactive with its name servers and skips the DNS read", async () => {
    const a = api({ zones: [{ ...ACTIVE, status: "pending" }], dns: [{ id: "d1", type: "A", name: "maple.test" }] });
    await expect(zoneCheck("t", "acct", "maple.test", undefined, a.fetcher)).resolves.toEqual({
      zone_active: false, zone_name: "maple.test", nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"], conflicting_records: [],
    });
    expect(a.calls.some((call) => call.url.includes("/dns_records"))).toBe(false);
  });

  it("reports no zone when the account has none at any level", async () => {
    const a = api({});
    await expect(zoneCheck("t", "acct", "app.maple.test", undefined, a.fetcher)).resolves.toEqual({
      zone_active: false, zone_name: null, nameservers: [], conflicting_records: [],
    });
    expect(a.calls.map((call) => new URL(call.url).searchParams.get("name"))).toEqual(["app.maple.test", "maple.test"]);
  });

  it("lists A, AAAA and CNAME records on the apex and www as conflicts, without ids", async () => {
    const a = api({ zones: [ACTIVE], dns: [
      { id: "d1", type: "A", name: "maple.test" }, { id: "d2", type: "CNAME", name: "www.maple.test" },
      { id: "d3", type: "MX", name: "maple.test" }, { id: "d4", type: "A", name: "mail.maple.test" },
    ] });
    await expect(zoneCheck("t", "acct", "maple.test", undefined, a.fetcher)).resolves.toMatchObject({
      zone_active: true, conflicting_records: [{ type: "A", name: "maple.test" }, { type: "CNAME", name: "www.maple.test" }],
    });
  });

  it("checks only the bare hostname for a subdomain of the zone", async () => {
    const a = api({ zones: [ACTIVE], dns: [{ id: "d1", type: "A", name: "www.app.maple.test" }, { id: "d2", type: "A", name: "app.maple.test" }] });
    const result = await zoneCheck("t", "acct", "app.maple.test", undefined, a.fetcher);
    expect(result.conflicting_records).toEqual([{ type: "A", name: "app.maple.test" }]);
  });

  it("does not count a record on a hostname attached to the brand's own Worker", async () => {
    const a = api({ zones: [ACTIVE], dns: [{ id: "d1", type: "A", name: "maple.test" }, { id: "d2", type: "A", name: "www.maple.test" }],
      domains: [{ id: "x1", hostname: "maple.test", service: "brand-brand_1" }] });
    const result = await zoneCheck("t", "acct", "maple.test", "brand_1", a.fetcher);
    expect(result.conflicting_records).toEqual([{ type: "A", name: "www.maple.test" }]);
  });
});

describe("parseZoneCheckRequest", () => {
  it.each([
    [{ domain: "maple.test" }, { domain: "maple.test" }],
    [{ domain: "maple.test", brand_id: "brand_1" }, { domain: "maple.test", brand_id: "brand_1" }],
  ])("accepts %j", (input, expected) => expect(parseZoneCheckRequest(input)).toEqual(expected));
  it.each([null, "maple.test", {}, { domain: "Maple.Test" }, { domain: "localhost" }, { domain: "a b.test" }, { domain: "maple.test", brand_id: "a/b" }, { domain: "maple.test", brand_id: 7 }])(
    "refuses %j", (input) => expect(parseZoneCheckRequest(input)).toBeNull(),
  );
});

describe("POST /zone-check", () => {
  const post = (body: unknown, method = "POST") => factory.fetch(
    new Request("https://factory/zone-check", { method, headers: { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined }),
    env as unknown as Env,
  );

  it("answers 400 for a body that is not a lowercase domain", async () => {
    expect((await post({ domain: "UPPER.test" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it("is POST only", async () => {
    expect((await post(null, "GET")).status).toBe(405);
  });

  it("answers 502 when Cloudflare cannot be reached, without leaking the token", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
    try {
      const response = await post({ domain: "maple.test" });
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).toContain("cloudflare_error");
      expect(text).not.toContain("test-token");
    } finally {
      globalThis.fetch = real;
    }
  });
});
