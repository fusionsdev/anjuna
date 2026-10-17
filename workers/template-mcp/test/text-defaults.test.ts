import { describe, expect, it } from "vitest";
import { extractTextDefaults } from "../src/text-defaults";

const enc = new TextEncoder();
const site = (index: string) => new Map([["index.html", enc.encode(index)]]);
const withSlot = (head: string) => `<!doctype html><html><head>${head}</head><body><header><a href="/" data-brand>Harbor Funding</a></header></body></html>`;
const noSlot = (head: string) => `<!doctype html><html><head>${head}</head><body><h1>Hi</h1></body></html>`;

describe("extractTextDefaults", () => {
  it("takes the brand name from the first data-brand element and title and description from index.html", () => {
    const head = '<title>Harbor | Fast Options</title><meta name="description" content="Compare  options\n today."><meta property="og:site_name" content="OG Name">';
    expect(extractTextDefaults(site(withSlot(head)))).toEqual({ brand_name: "Harbor Funding", title: "Harbor | Fast Options", description: "Compare options today." });
  });

  it("falls back to og:site_name, then to the part of <title> before ' | '", () => {
    expect(extractTextDefaults(site(noSlot('<title>Harbor | Fast</title><meta property="og:site_name" content="Harbor Co">'))).brand_name).toBe("Harbor Co");
    expect(extractTextDefaults(site(noSlot("<title>Lantern | Cash Options</title>"))).brand_name).toBe("Lantern");
    expect(extractTextDefaults(site(noSlot("<title>Lantern Cash Options</title>"))).brand_name).toBeNull();
  });

  it("cuts to the limits, drops banned wording and returns nulls without index.html", () => {
    const long = extractTextDefaults(site(withSlot(`<title>${"T".repeat(90)}</title><meta name="description" content="${"d".repeat(200)}">`)));
    expect(long.title).toBe("T".repeat(70));
    expect(long.description).toBe("d".repeat(160));
    expect(extractTextDefaults(site(withSlot("<title>Personal Loans | Harbor</title>"))).title).toBeNull();
    expect(extractTextDefaults(new Map())).toEqual({ brand_name: null, title: null, description: null });
  });

  it("decodes entities", () => {
    expect(extractTextDefaults(site(withSlot("<title>Harbor &amp; Co | Funding</title>"))).title).toBe("Harbor & Co | Funding");
  });

  it("reads only head > title, ignoring an svg title in the body", () => {
    const html = "<!doctype html><html><head><title>Real | Title</title></head><body><svg><title>Icon</title></svg></body></html>";
    expect(extractTextDefaults(site(html)).title).toBe("Real | Title");
    const bodyOnly = "<!doctype html><html><head></head><body><svg><title>Icon</title></svg></body></html>";
    expect(extractTextDefaults(site(bodyOnly)).title).toBeNull();
  });
});
