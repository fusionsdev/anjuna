import { describe, expect, it } from "vitest";
import { readZip } from "../src/archive";
import { assembleZip, detectFramework } from "../src/submit";

const enc = (text: string) => new TextEncoder().encode(text);

describe("assembleZip", () => {
  it("is byte-identical for the same files in any order and round-trips through readZip", () => {
    const a = new Map([["index.html", enc("<h1>a</h1>")], ["assets/site.css", enc("b{}")]]);
    const b = new Map([["assets/site.css", enc("b{}")], ["index.html", enc("<h1>a</h1>")]]);
    const zipA = assembleZip(a);
    expect(assembleZip(b)).toEqual(zipA);
    expect(new TextDecoder().decode(readZip(zipA).get("index.html"))).toBe("<h1>a</h1>");
  });

  it("detects the framework from the build layout", () => {
    expect(detectFramework(new Map([["_astro/a.css", enc("")]]))).toBe("astro");
    expect(detectFramework(new Map([["_next/static/a.js", enc("")]]))).toBe("next_export");
    expect(detectFramework(new Map([["assets/index.js", enc("")]]))).toBe("react_spa");
  });
});
