import { describe, expect, it } from "vitest";
import {
  BRAND_ASSET_MAX_BYTES, BrandAssetRequest, BrandAssetResponse, base64ToBytes, brandInitialSvg, bytesToBase64, checkBrandAssetBytes, svgSafetyIssue,
} from "../src/index.js";

const utf8 = (text: string) => new TextEncoder().encode(text);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const ICO = Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#123"/></svg>';

describe("checkBrandAssetBytes", () => {
  it("sniffs PNG, ICO and SVG from the bytes", () => {
    expect(checkBrandAssetBytes("logo", PNG)).toEqual({ ok: true, content_type: "image/png" });
    expect(checkBrandAssetBytes("favicon", ICO)).toEqual({ ok: true, content_type: "image/x-icon" });
    expect(checkBrandAssetBytes("logo", utf8(SVG))).toEqual({ ok: true, content_type: "image/svg+xml" });
    expect(checkBrandAssetBytes("logo", utf8(`<?xml version="1.0"?>\n<!-- made by hand -->\n${SVG}\n`)).ok).toBe(true);
  });

  it("refuses an empty file, an oversized file and unknown bytes", () => {
    expect(checkBrandAssetBytes("logo", new Uint8Array())).toMatchObject({ ok: false, code: "empty" });
    expect(checkBrandAssetBytes("favicon", new Uint8Array(BRAND_ASSET_MAX_BYTES.favicon + 1))).toMatchObject({ ok: false, code: "too_large" });
    expect(checkBrandAssetBytes("logo", new Uint8Array(BRAND_ASSET_MAX_BYTES.favicon + 1).fill(1)).ok).toBe(false);
    expect(checkBrandAssetBytes("logo", utf8("GIF89a"))).toMatchObject({ ok: false, code: "unsupported_type" });
    expect(checkBrandAssetBytes("logo", utf8("<html><svg></svg></html>"))).toMatchObject({ ok: false, code: "unsupported_type" });
    expect(checkBrandAssetBytes("logo", Uint8Array.from([0, 0, 2, 0, 1, 0]))).toMatchObject({ ok: false, code: "unsupported_type" });
    expect(checkBrandAssetBytes("logo", Uint8Array.from([0xff, 0xfe, 0xfd]))).toMatchObject({ ok: false, code: "unsupported_type" });
  });

  it("allows the logo size cap and refuses it for a favicon", () => {
    const big = new Uint8Array(BRAND_ASSET_MAX_BYTES.favicon + 10);
    big.set(PNG);
    expect(checkBrandAssetBytes("logo", big).ok).toBe(true);
    expect(checkBrandAssetBytes("favicon", big)).toMatchObject({ ok: false, code: "too_large" });
  });
});

describe("svgSafetyIssue", () => {
  it.each([
    ["script element", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ["event handler", '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>'],
    ["javascript url", '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:x()"><rect/></a></svg>'],
    ["external image", '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://x.test/a.png"/></svg>'],
    ["xlink reference", '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="//x.test/a.svg#a"/></svg>'],
    ["data uri", '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AAAA"/></svg>'],
    ["css url", '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://x.test/a)"/></svg>'],
    ["css import", '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "x.css";</style></svg>'],
    ["foreignObject", '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>'],
    ["doctype entity", '<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ["animate href", '<svg xmlns="http://www.w3.org/2000/svg"><a><animate attributeName="href" to="x"/></a></svg>'],
  ])("rejects %s", (_name, svg) => {
    expect(svgSafetyIssue(svg)).not.toBeNull();
    expect(checkBrandAssetBytes("logo", utf8(svg)).ok).toBe(false);
  });

  it("accepts fragment references, gradients and style blocks", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
      '<style>.a{fill:url(#g)}</style><use xlink:href="#a"/><rect class="a" style="fill: url( #g )" width="4" height="4"/><title>Brand mark</title></svg>';
    expect(svgSafetyIssue(svg)).toBeNull();
  });
});

describe("generated fallback and encoding", () => {
  it("draws the first letter, escapes it and depends only on the name", () => {
    const a = brandInitialSvg("Level Lending");
    expect(a).toContain(">L</text>");
    expect(brandInitialSvg("  level lending")).toContain(">L</text>");
    expect(brandInitialSvg("Level Lending")).toBe(a);
    expect(brandInitialSvg("Harbor Cash")).not.toBe(a);
    expect(brandInitialSvg("&Co")).toContain(">&amp;</text>");
    expect(brandInitialSvg("")).toContain(">?</text>");
    expect(checkBrandAssetBytes("logo", utf8(a))).toEqual({ ok: true, content_type: "image/svg+xml" });
  });

  it("round-trips base64 and validates the RPC shapes", () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
    expect(BrandAssetRequest.parse({ brand_id: "brand-a", kind: "favicon" })).toEqual({ brand_id: "brand-a", kind: "favicon" });
    expect(BrandAssetRequest.safeParse({ brand_id: "brand-a", kind: "banner" }).success).toBe(false);
    expect(BrandAssetResponse.safeParse({ content_type: "image/png", sha256: "a".repeat(64), body_base64: bytesToBase64(PNG) }).success).toBe(true);
    expect(BrandAssetResponse.safeParse({ content_type: "image/gif", sha256: "a".repeat(64), body_base64: bytesToBase64(PNG) }).success).toBe(false);
    expect(BrandAssetResponse.safeParse({ content_type: "image/png", sha256: "a".repeat(64), body_base64: bytesToBase64(PNG), secret: "x" }).success).toBe(false);
  });
});
