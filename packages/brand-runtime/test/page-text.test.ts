import { describe, expect, it } from "vitest";
import settingsFixture from "../../contracts/fixtures/rpc/brandSettings.response.json";
import { createBrandWorker } from "../src/index.js";
import { PageCopyError, renderPageText, templateBrandName, type PageTextData } from "../src/page-text";
import { MockCoreClient, WILLOW_LAKE_INDEX as WILLOW_INDEX, WILLOW_LAKE_TERMS as WILLOW_TERMS, WIZARD_DEMO_PAGE_TEXT as WIZARD_DEMO } from "../src/testing";

const render = async (data: PageTextData, pages: Record<string, string> = { "index.html": WILLOW_INDEX, "terms/index.html": WILLOW_TERMS }) =>
  Object.fromEntries(await renderPageText(new Map(Object.entries(pages)), data));

describe("renderPageText", () => {
  it("applies the wizard copy, contact and brand name to the Willow Lake pattern", async () => {
    const { "index.html": index, "terms/index.html": terms } = await render(WIZARD_DEMO);
    // The H1 slot is baked with the brand name, not keyword_default ("Loan Options").
    expect(index).toContain("<h1><span data-kw>Wizard Demo</span> Options in Minutes</h1>");
    expect(index).not.toContain("<span data-kw>Loan Options</span> Options in Minutes");
    expect(index).toContain("<p>Answer two questions to see your options.</p>");
    expect(index).toContain('<button type="submit">Check My Options</button>');
    expect(index).toContain('<a class="call" href="tel:+15550100199"><svg aria-hidden="true"><title>Phone</title></svg>+1 (555) 010-0199</a>');
    expect(index).toContain("<h3>What is <span data-brand>Wizard Demo</span>?</h3>");
    expect(index).toContain("Call +1 (555) 010-0199 or write to care@wizard-demo.example.");
    expect(index).toContain('<a href="mailto:care@wizard-demo.example">care@wizard-demo.example</a> &copy; <span data-brand>Wizard Demo</span>');
    expect(index).toContain('alt="Wizard Demo logo"');
    expect(index).toContain('<meta property="og:site_name" content="Wizard Demo">');
    expect(index).toContain('<meta name="description" content="Wizard Demo helps you compare options.">');
    expect(terms).toContain("These terms apply to <span data-brand>Wizard Demo</span>.");
    expect(terms).toContain('<a href="tel:+15550100199">+1 (555) 010-0199</a>');
    for (const page of [index, terms]) {
      expect(page).not.toContain("710-3200");
      expect(page).not.toContain("willowlake.example");
    }
    // <title> and the index og:title stay with the brand Worker (live brand name); JSON-LD gets the name as JSON text.
    expect(index).toContain(`{"name":"Wizard Demo"}`);
    const outsideRuntime = index!.replace(/<title>.*?<\/title>/, "").replace(/<meta property="og:title"[^>]*>/, "");
    expect(outsideRuntime).not.toContain("Willow Lake");
    // Unslotted disclosure text stays as the template wrote it.
    expect(index).toContain("Term range: 91 days–72 months");
  });

  it("keeps template text for empty copy fields and leaves pages byte-identical when nothing applies", async () => {
    const { "index.html": index } = await render({ ...WIZARD_DEMO, profile: { copy: { cta: "Check My Options" } } });
    // No copy.h1: the H1 text stays the template's, and its [data-kw] slot shows the brand name.
    expect(index).toContain("<h1><span data-kw>Wizard Demo</span> from <span data-brand>Wizard Demo</span></h1>");
    expect(index).toContain("<p><span data-brand>Wizard Demo</span> connects you with lenders in minutes.</p>");
    expect(index).toContain('href="tel:+18337103200"');
    const untouched = await render({ brand_name: "", template_brand: null });
    expect(untouched["index.html"]).toBe(WILLOW_INDEX);
    expect(untouched["terms/index.html"]).toBe(WILLOW_TERMS);
  });

  it("writes the brand name into the [data-kw] slot when copy.h1 is empty, as text, on the index page only", async () => {
    const page = '<h1><span data-kw class="kw">Quick Loan</span></h1>';
    const data = { brand_name: " Maple Cash ", keyword_default: "Quick Loan" };
    expect((await render(data, { "index.html": page }))["index.html"]).toBe('<h1><span data-kw class="kw">Maple Cash</span></h1>');
    expect((await render({ ...data, profile: { copy: { cta: "Check My Options" } } }, { "index.html": page }))["index.html"]).toBe('<h1><span data-kw class="kw">Maple Cash</span></h1>');
    expect((await render({ ...data, brand_name: "Smith & Sons <Co>" }, { "index.html": page }))["index.html"]).toBe('<h1><span data-kw class="kw">Smith &amp; Sons &lt;Co&gt;</span></h1>');
    // An empty brand name leaves the template text; other pages are not touched.
    expect((await render({ ...data, brand_name: "  " }, { "index.html": page }))["index.html"]).toBe(page);
    expect((await render(data, { "about/index.html": page }))["about/index.html"]).toBe(page);
  });

  it("fills explicit data-contact slots", async () => {
    const page = `<p><a data-contact="phone" href="tel:0">x</a> <span data-contact="email">x</span> <span data-contact="address">x</span></p>`;
    const { "contact.html": out } = await render(WIZARD_DEMO, { "contact.html": page });
    expect(out).toBe('<p><a data-contact="phone" href="tel:+15550100199">+1 (555) 010-0199</a> <span data-contact="email">care@wizard-demo.example</span> <span data-contact="address">1 Demo Way, Austin, TX</span></p>');
  });

  it("escapes the brand name and matches the template brand written with entities", async () => {
    const { "index.html": out } = await render({ brand_name: "Smith & Sons <Co>", template_brand: "Harbor & Co" }, { "index.html": "<p>About Harbor &amp; Co and Harbor Coast.</p>" });
    expect(out).toBe("<p>About <span data-brand>Smith &amp; Sons &lt;Co&gt;</span> and Harbor Coast.</p>");
  });

  it("refuses copy that breaks the copy rules, as the install does", async () => {
    await expect(render({ ...WIZARD_DEMO, profile: { copy: { h1: "No keyword slot here" } } })).rejects.toBeInstanceOf(PageCopyError);
    await expect(render({ ...WIZARD_DEMO, profile: { copy: { cta: "Get Personal Loans" } } })).rejects.toThrow(/personal loan/);
  });

  it("bakes the brand name into the H1 slot, escaped, and a brand that is no clean keyword still renders", async () => {
    const copy = { copy: { h1: "{{keyword}} | Compare Options" } };
    const { "index.html": index } = await render({ ...WIZARD_DEMO, brand_name: " Smith & Sons, LLC ", profile: copy });
    expect(index).toContain("<h1><span data-kw>Smith &amp; Sons, LLC</span> | Compare Options</h1>");
    expect(index).not.toContain("Loan Options</span> | Compare");
  });

  it("falls back to keyword_default in the H1 slot when the brand name is empty", async () => {
    const { "index.html": index } = await render({ ...WIZARD_DEMO, brand_name: "  ", profile: { copy: { h1: "{{keyword}} | Compare Options" } } });
    expect(index).toContain("<h1><span data-kw>Loan Options</span> | Compare Options</h1>");
  });

  it("counts the brand name, not keyword_default, toward the 140 character H1 limit", async () => {
    const brand = "B".repeat(60);
    const room = 140 - brand.length;
    const fits = { copy: { h1: `${"a".repeat(room - 1)} {{keyword}}` } };
    await expect(render({ ...WIZARD_DEMO, brand_name: brand, profile: fits })).resolves.toBeDefined();
    await expect(render({ ...WIZARD_DEMO, brand_name: brand, profile: { copy: { h1: `${"a".repeat(room)} {{keyword}}` } } })).rejects.toThrow(/140/);
    // A short brand name leaves room that a long keyword_default would have used up.
    await expect(render({ ...WIZARD_DEMO, brand_name: "Wizard Demo", keyword_default: `K${"k".repeat(59)}`, profile: { copy: { h1: `${"a".repeat(100)} {{keyword}}` } } })).resolves.toBeDefined();
  });

  it("still requires keyword_default to be a clean keyword when the H1 is filled", async () => {
    await expect(render({ ...WIZARD_DEMO, keyword_default: "not clean!", profile: { copy: { h1: "{{keyword}} | Compare Options" } } })).rejects.toBeInstanceOf(PageCopyError);
  });

  describe("phone text in tel: links", () => {
    // The template's tel: href is a placeholder; the visible number differs from it.
    const link = (inner: string) => `<a href="tel:+15550100199" class="hover:text-white transition-colors">${inner}</a>`;
    const phone = async (page: string) => (await render(WIZARD_DEMO, { "p.html": page }))["p.html"];

    it("replaces plain link text with the brand phone as typed", async () => {
      expect(await phone(`<footer>${link("(833) 710-3200")}</footer>`))
        .toBe(`<footer>${link("+1 (555) 010-0199")}</footer>`);
    });

    it("replaces link text after an inline svg and keeps the svg", async () => {
      const svg = '<svg class="w-4 h-4" viewBox="0 0 24 24"><path d="M3 5h18"></path></svg>';
      expect(await phone(`<header>${link(` ${svg} (833) 710-3200 `)}</header>`))
        .toBe(`<header>${link(` ${svg} +1 (555) 010-0199 `)}</header>`);
    });

    it("replaces the template phone elsewhere on the page, and only that number", async () => {
      const page = `<p>Call 555.010.0199 today.</p>${link("833-710-3200")}<p>Rate table: $1,205.40 at 36.5%. ZIP 78701 and 78701-1234.</p><p>Ref 800 555 0147</p>`;
      expect(await phone(page)).toBe(
        `<p>Call +1 (555) 010-0199 today.</p>${link("+1 (555) 010-0199")}<p>Rate table: $1,205.40 at 36.5%. ZIP 78701 and 78701-1234.</p><p>Ref 800 555 0147</p>`,
      );
    });

    it("keeps non-phone text in a tel: link and text outside it", async () => {
      expect(await phone(`${link("Call us")}<span>(833) 710-3200</span>`)).toBe(`${link("Call us")}<span>(833) 710-3200</span>`);
    });
  });

  it("resolves the template brand from text defaults, else the template display name", () => {
    expect(templateBrandName(JSON.stringify({ brand_name: "Willow Lake Lending", title: null, description: null }), "Willow v2")).toBe("Willow Lake Lending");
    expect(templateBrandName(JSON.stringify({ brand_name: null, title: null, description: null }), "Willow Lake Lending")).toBe("Willow Lake Lending");
    expect(templateBrandName("not json", " ")).toBeNull();
  });
});

describe("rendered page text served by the brand Worker", () => {
  it("fills the brand name spans with a brand name edited after install", async () => {
    const rendered = await renderPageText(new Map([["index.html", WILLOW_INDEX]]), WIZARD_DEMO);
    const core = new MockCoreClient();
    core.settings = { ...structuredClone(settingsFixture), flow_gate_mode: "param", brand_name: "Quick Funds", site_title: null, site_description: null };
    const worker = createBrandWorker({
      brand_id: "brand-a", hostname: "brand-a.example", brand: "Wizard Demo", formRoute: "/request", amount_buckets: [500, 750, 1000, 1750, 5000],
      keyword_default: "Loan Options", text_defaults: { brand_name: "Willow Lake Lending", title: null, description: null }, core,
      assets: { fetch: async () => new Response(rendered.get("index.html")!, { headers: { "content-type": "text/html" } }) },
    });
    const html = await (await worker.fetch(new Request("https://brand-a.example/"))).text();
    expect(html).toContain("<h3>What is <span data-brand>Quick Funds</span>?</h3>");
    expect(html).toContain("<title>Quick Funds | Loan Options</title>");
    // The H1 slot holds the live brand name, with or without an ad keyword.
    expect(html).toContain("<h1><span data-kw>Quick Funds</span> Options in Minutes</h1>");
    const withKeyword = await (await worker.fetch(new Request("https://brand-a.example/?keyword=scratchpay"))).text();
    expect(withKeyword).toContain("<h1><span data-kw>Quick Funds</span> Options in Minutes</h1>");
    // Only the CTA form's hidden input carries the ad keyword.
    expect(withKeyword.replace(/<input type="hidden"[^>]*>/g, "")).not.toMatch(/scratchpay/i);
    // Attributes, meta content and JSON-LD keep the name from install time until the next install.
    expect(html).toContain('alt="Wizard Demo logo"');
    expect(html).not.toContain("Willow Lake");
  });
});
