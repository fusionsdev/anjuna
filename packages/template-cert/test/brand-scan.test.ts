import { describe, expect, it } from "vitest";
import { scanBrandFile } from "../src/brand-scan.js";

const utf8 = (text: string) => new TextEncoder().encode(text);
const OTHERS = { denyDomains: ["levellending.com"], denyIdentifiers: ["Level Lending", "brand_0123456789abcdef"] };
const svg = (inner: string) => utf8(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">${inner}</svg>`);

describe("scanBrandFile", () => {
  it("passes a file with no identifiers", () => {
    expect(scanBrandFile({ name: "logo", bytes: svg("<rect width='8' height='8'/>"), ...OTHERS })).toEqual([]);
  });

  it("refuses another brand's name or domain, in any case", () => {
    expect(scanBrandFile({ name: "logo", bytes: svg("<text>LEVEL LENDING</text>"), ...OTHERS })).toHaveLength(1);
    expect(scanBrandFile({ name: "logo", bytes: svg("<desc>made for levellending.com</desc>"), ...OTHERS }).length).toBeGreaterThan(0);
    expect(scanBrandFile({ name: "logo", bytes: svg("<desc>brand_0123456789abcdef</desc>"), ...OTHERS })).toHaveLength(1);
  });

  it("refuses the platform names, an analytics key and a DSN", () => {
    for (const inner of ["<desc>Anjuna</desc>", "<desc>aurum</desc>", "<desc>phc_abcdefghijklmnop</desc>", "<desc>https://key@o1.ingest.sentry.io/42</desc>"]) {
      expect(scanBrandFile({ name: "logo", bytes: svg(inner), ...OTHERS }).length, inner).toBeGreaterThan(0);
    }
  });

  it("finds an identifier in binary metadata and in the file name", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, ...utf8("tEXtComment\0Level Lending"), 1, 2]);
    expect(scanBrandFile({ name: "logo", bytes: png, ...OTHERS })).toHaveLength(1);
    expect(scanBrandFile({ name: "level-lending.png", bytes: Uint8Array.from([1, 2, 3]), denyDomains: [], denyIdentifiers: ["level-lending"] })).toHaveLength(1);
  });
});
