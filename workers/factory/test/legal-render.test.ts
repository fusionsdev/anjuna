import { describe, expect, it } from "vitest";
import { assertCleanBrandBytes, renderBrand, type FileMap, type LegalRenderData } from "../src/render";

const enc = new TextEncoder();
const dec = new TextDecoder();
const keys = ["brand_name", "contact.address", "contact.email", "contact.phone", "disclosures.apr_max",
  "disclosures.term_min_months", "disclosures.term_max_months", "disclosures.term_range",
  "disclosures.representative_example", "disclosures.unsupported_states"];
const html = '<h1>Legal information</h1>' + keys.map((key) => `<p><span data-legal="${key}">[Placeholder]</span></p>`).join("");
const full: LegalRenderData = { brand_name: "Harbor & Co.", profile: {
  contact: { address: "123 Main St & Suite 4", email: "help@harbor.example", phone: "+1 (555) 123-4567" },
  disclosures: { apr_max: 35.99, term_min_months: 3, term_max_months: 36,
    representative_example: "An example supplied & reviewed by the operator.", unsupported_states: ["NY", "AR", "VT", "WV"] },
} };
const site = (): FileMap => new Map([
  ["terms/index.html", enc.encode(html)], ["/disclosures/index.html", enc.encode(html)],
  ["index.html", enc.encode('<h1><span data-kw>Funding Options</span></h1>')],
  ["assets/site.css", enc.encode("body { color: black }")],
]);

describe("renderBrand legal fill", () => {
  it("fills both pages from contact/disclosures and keeps the input and other assets unchanged", async () => {
    const template = site();
    const { files } = await renderBrand(template, new Map(), "brand-test", "rev-1", full);
    for (const path of ["terms/index.html", "/disclosures/index.html"]) {
      const output = dec.decode(files.get(path)!);
      for (const value of ["Harbor &amp; Co.", "123 Main St &amp; Suite 4", "help@harbor.example", "+1 (555) 123-4567", "35.99%", "3 months", "36 months", "3–36 months", "supplied &amp; reviewed", "NY, AR, VT, WV"]) expect(output).toContain(value);
      expect(output).not.toContain("[Placeholder]");
      expect(output).not.toContain("Not provided");
    }
    expect(dec.decode(template.get("terms/index.html")!)).toBe(html);
    expect(files.get("index.html")).toEqual(template.get("index.html"));
    expect(files.get("assets/site.css")).toEqual(template.get("assets/site.css"));
    expect(() => assertCleanBrandBytes(files, "brand-test")).not.toThrow();
  });

  it("keeps the template text of slots the profile leaves empty, preserving a zero APR", async () => {
    const data = { profile: { contact: { email: "help@harbor.example" }, disclosures: { apr_max: 0, term_min_months: 6 } } };
    const { files } = await renderBrand(site(), new Map(), "brand-test", "rev-1", data);
    const output = dec.decode(files.get("terms/index.html")!);
    expect(output).toContain(">0%</span>");
    expect(output).toContain(">6 months</span>");
    expect(output).toContain(">help@harbor.example</span>");
    expect(output.match(/\[Placeholder\]/g)).toHaveLength(keys.length - 3);
    expect(output).not.toContain("Not provided");
    expect(output).not.toContain("35.99");
    expect(output).not.toContain("36 months");
    expect(output).not.toContain("NY, AR");
  });

  it.each([undefined, {}, { profile: {} }, { profile: { disclosures: {}, contact: {} } }])("keeps the template's own text byte for byte for an empty or absent profile: %j", async (data) => {
    const template = site();
    const { files } = await renderBrand(template, new Map(), "brand-test", "rev-1", data);
    for (const path of ["terms/index.html", "/disclosures/index.html"]) {
      expect(files.get(path)).toEqual(template.get(path));
      expect(dec.decode(files.get(path)!)).not.toContain("Not provided");
    }
  });

  it("keeps the template's own APR, term and state text when the draft has contact but no disclosures", async () => {
    const own = '<p>APR <span data-legal="disclosures.apr_max">up to 35.99% APR</span></p><p>Term <span data-legal="disclosures.term_range">3 to 36 months</span></p>'
      + '<p>Example <span data-legal="disclosures.representative_example">A $1,000 loan over 12 months.</span></p>'
      + '<p>States <span data-legal="disclosures.unsupported_states">NY, AR, VT, WV</span></p><p>Email <span data-legal="contact.email">old@template.example</span></p>';
    const template = new Map([["terms/index.html", enc.encode(own)]]);
    const { files } = await renderBrand(template, new Map(), "brand-test", "rev-1", { profile: { contact: { email: "help@harbor.example" } } });
    expect(dec.decode(files.get("terms/index.html")!)).toBe(own.replace("old@template.example", "help@harbor.example"));
  });

  it("escapes HTML and entity-looking strings as literal text", async () => {
    const { files } = await renderBrand(site(), new Map(), "brand-test", "rev-1", { brand_name: '<script>alert(1)</script> &lt;b&gt;' });
    const output = dec.decode(files.get("terms/index.html")!);
    expect(output).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp;lt;b&amp;gt;");
    expect(output).not.toContain("<script>");
  });

  it.each(["Anjuna", "Aurum", "brand-test", "brand_0123456789abcdef", "phc_0123456789abcdef", "https://public@errors.example/1"])("final clean-bytes guard still rejects injected identity: %s", async (brand_name) => {
    await expect(renderBrand(site(), new Map(), "brand-test", "rev-1", { brand_name })).rejects.toThrow(/forbidden identity/);
  });

  it("still rejects dirty source bytes before replacing slots", async () => {
    const template = site();
    template.set("terms/index.html", enc.encode('<span data-legal="brand_name">Aurum</span>'));
    await expect(renderBrand(template, new Map(), "brand-test", "rev-1", full)).rejects.toThrow(/forbidden identity/);
  });

  it("checks profile text for credentials and rejects forbidden legal wording", async () => {
    await expect(renderBrand(site(), new Map(), "brand-test", "rev-1", {
      profile: { disclosures: { representative_example: "https://public@errors.example/1" } },
    })).rejects.toThrow(/forbidden identity/);
    await expect(renderBrand(site(), new Map(), "brand-test", "rev-1", { brand_name: "Personal Loans" })).rejects.toThrow(/forbidden wording/);
  });

  it("recognizes case-insensitive HTML attributes and leaves non-legal pages untouched", async () => {
    const source = '<SPAN DATA-LEGAL="brand_name">old</SPAN>';
    const template = new Map([["terms.html", enc.encode(source)], ["privacy/index.html", enc.encode(source)]]);
    const { files } = await renderBrand(template, new Map(), "brand-test", "rev-1", full);
    expect(dec.decode(files.get("terms.html")!)).toContain("Harbor &amp; Co.");
    expect(files.get("privacy/index.html")).toEqual(template.get("privacy/index.html"));
  });

  it.each(['<span data-legal="unknown">old</span>', '<a data-legal="contact.email">old</a>'])("rejects invalid slot declarations: %s", async (source) => {
    await expect(renderBrand(new Map([["terms.html", enc.encode(source)]]), new Map(), "brand-test", "rev-1", full)).rejects.toThrow(/documented data-legal/);
  });

  it("preserves reviewed pages without slots and rejects invalid profile values", async () => {
    const template = new Map([["terms/index.html", enc.encode("<p>Reviewed terms</p>")]]);
    const { files } = await renderBrand(template, new Map(), "brand-test", "rev-1", full);
    expect(files).toEqual(template);
    await expect(renderBrand(site(), new Map(), "brand-test", "rev-1", { profile: { disclosures: { apr_max: -1 } } })).rejects.toThrow();
  });

  it("produces identical static bytes on repeated renders without visitor inputs", async () => {
    const first = await renderBrand(site(), new Map(), "brand-test", "rev-1", full);
    const second = await renderBrand(site(), new Map(), "brand-test", "rev-1", full);
    expect([...first.files]).toEqual([...second.files]);
  });
});
