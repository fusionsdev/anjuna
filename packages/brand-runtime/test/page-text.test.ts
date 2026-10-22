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
    expect(index).toContain("<h1><span data-kw>Loan Options</span> Options in Minutes</h1>");
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
    expect(index).toContain("<h1><span data-kw>Loan Options</span> from <span data-brand>Wizard Demo</span></h1>");
    expect(index).toContain("<p><span data-brand>Wizard Demo</span> connects you with lenders in minutes.</p>");
    expect(index).toContain('href="tel:+18337103200"');
    const untouched = await render({ brand_name: "Wizard Demo", template_brand: null });
    expect(untouched["index.html"]).toBe(WILLOW_INDEX);
    expect(untouched["terms/index.html"]).toBe(WILLOW_TERMS);
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
    // The runtime keyword still reaches the copy H1 slot.
    expect(html).toContain("<h1><span data-kw>Fast Cash Loans</span> Options in Minutes</h1>");
    // Attributes, meta content and JSON-LD keep the name from install time until the next install.
    expect(html).toContain('alt="Wizard Demo logo"');
    expect(html).not.toContain("Willow Lake");
  });
});
