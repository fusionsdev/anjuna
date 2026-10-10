import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, describe, expect, it, vi } from "vitest";
import { smokeBrand } from "../src/smoke";

afterEach(() => vi.unstubAllGlobals());

describe("smoke propagation classification", () => {
  it.each([520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530])("retries edge HTTP %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("edge unavailable", { status, headers: { "cf-ray": "test-ray" } })));
    const error = await smokeBrand(["brand.example", "www.brand.example"]).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetryableError);
    expect(String(error)).toContain(`apex returned ${status}`);
    expect(String(error)).toContain("cf-ray=test-ray");
  });

  it.each(["getaddrinfo ENOTFOUND brand.example", "DNS lookup failed", "DNS resolution failed", "Could not resolve host: brand.example"])("retries recognized DNS error: %s", async (message) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError(message); }));
    const error = await smokeBrand(["brand.example", "www.brand.example"]).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetryableError);
    expect(String(error)).toContain("apex DNS resolution failed");
  });

  it("does not retry a request timeout as a DNS failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("Request timed out", "TimeoutError"); }));
    await expect(smokeBrand(["brand.example", "www.brand.example"])).rejects.toBeInstanceOf(NonRetryableError);
  });
});

describe("smoke hostnames", () => {
  const apexOk = () => new Response('<h1><span data-kw>Quick Loan</span></h1><form data-cta action="/go"></form>', { status: 200 });

  it("smokes only the bare domain of a subdomain brand and reports no www status", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | Request | URL) => {
      urls.push(String(input));
      return apexOk();
    }));
    await expect(smokeBrand(["demo05.aduplift.ai"])).resolves.toEqual({ apex_status: 200 });
    expect(urls).toEqual(["https://demo05.aduplift.ai/"]);
  });

  it("smokes the apex and the www redirect for an apex brand", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | Request | URL) => {
      const url = String(input);
      urls.push(url);
      return url.startsWith("https://www.")
        ? new Response(null, { status: 301, headers: { Location: "https://withulaon.com/" } })
        : apexOk();
    }));
    await expect(smokeBrand(["withulaon.com", "www.withulaon.com"])).resolves.toEqual({ apex_status: 200, www_status: 301 });
    expect(urls).toEqual(["https://withulaon.com/", "https://www.withulaon.com/"]);
  });
});

describe("smoke for a paused brand", () => {
  const pausePage = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Temporarily unavailable</title><h1>Temporarily unavailable</h1><p>Please try again later.</p></html>';
  const pausedApex = () => new Response(pausePage, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "retry-after": "300" } });
  const landing = () => new Response('<h1><span data-kw>Quick Loan</span></h1><form data-cta action="/go"></form>', { status: 200 });
  const wwwRedirect = () => new Response(null, { status: 301, headers: { Location: "https://brand.example/" } });
  const stub = (apex: () => Response, www: () => Response = wwwRedirect) =>
    vi.stubGlobal("fetch", vi.fn(async (input: string | Request | URL) => (String(input).startsWith("https://www.") ? www() : apex())));

  it("passes when the apex answers 503 with the pause page and www redirects to the apex", async () => {
    stub(pausedApex);
    await expect(smokeBrand(["brand.example", "www.brand.example"], { paused: true })).resolves.toEqual({ apex_status: 503, www_status: 301 });
  });

  it("passes for a paused subdomain brand with a single hostname", async () => {
    stub(pausedApex);
    await expect(smokeBrand(["demo05.aduplift.ai"], { paused: true })).resolves.toEqual({ apex_status: 503 });
  });

  it("fails without retry when a paused brand serves the live landing page", async () => {
    stub(landing);
    const error = await smokeBrand(["brand.example", "www.brand.example"], { paused: true }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(String(error)).toContain("apex returned 200 (expected 503");
  });

  it.each(["anjuna", "Anjuna", "AURUM", "aurum"])("fails without retry when the pause page contains %s", async (word) => {
    stub(() => new Response(`${pausePage}<!-- ${word} -->`, { status: 503 }));
    const error = await smokeBrand(["brand.example", "www.brand.example"], { paused: true }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(String(error)).toContain("forbidden brand string");
  });

  it("fails without retry when the 503 is not the pause page", async () => {
    stub(() => new Response("upstream error", { status: 503 }));
    await expect(smokeBrand(["brand.example", "www.brand.example"], { paused: true })).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("still requires the www 301 to the apex", async () => {
    stub(pausedApex, () => new Response(pausePage, { status: 503 }));
    const wrongStatus = await smokeBrand(["brand.example", "www.brand.example"], { paused: true }).catch((err: unknown) => err);
    expect(wrongStatus).toBeInstanceOf(NonRetryableError);
    expect(String(wrongStatus)).toContain("www returned 503 (expected 301");
    stub(pausedApex, () => new Response(null, { status: 301, headers: { Location: "https://elsewhere.example/" } }));
    await expect(smokeBrand(["brand.example", "www.brand.example"], { paused: true })).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("keeps retrying edge 525 for a paused brand", async () => {
    stub(() => new Response("edge unavailable", { status: 525 }));
    const error = await smokeBrand(["brand.example", "www.brand.example"], { paused: true }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetryableError);
  });

  it("keeps failing a live brand that answers 503, with or without the option", async () => {
    stub(pausedApex);
    const live = await smokeBrand(["brand.example", "www.brand.example"]).catch((err: unknown) => err);
    expect(live).toBeInstanceOf(NonRetryableError);
    expect(String(live)).toContain("apex returned 503 (expected 200");
    await expect(smokeBrand(["brand.example", "www.brand.example"], { paused: false })).rejects.toBeInstanceOf(NonRetryableError);
  });
});
