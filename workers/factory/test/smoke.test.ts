import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, describe, expect, it, vi } from "vitest";
import { smokeBrand } from "../src/smoke";

afterEach(() => vi.unstubAllGlobals());

describe("smoke propagation classification", () => {
  it.each([520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530])("retries edge HTTP %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("edge unavailable", { status, headers: { "cf-ray": "test-ray" } })));
    const error = await smokeBrand("brand.example").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetryableError);
    expect(String(error)).toContain(`apex returned ${status}`);
    expect(String(error)).toContain("cf-ray=test-ray");
  });

  it.each(["getaddrinfo ENOTFOUND brand.example", "DNS lookup failed", "DNS resolution failed", "Could not resolve host: brand.example"])("retries recognized DNS error: %s", async (message) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError(message); }));
    const error = await smokeBrand("brand.example").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetryableError);
    expect(String(error)).toContain("apex DNS resolution failed");
  });

  it("does not retry a request timeout as a DNS failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("Request timed out", "TimeoutError"); }));
    await expect(smokeBrand("brand.example")).rejects.toBeInstanceOf(NonRetryableError);
  });
});
