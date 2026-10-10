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
