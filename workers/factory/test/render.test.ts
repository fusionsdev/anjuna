import { describe, expect, it } from "vitest";
import { renderBrand, unzip, zip } from "../src/render";
import { uploadScript } from "../src/cf-api";
import { CoreLifecycleClient } from "../src/core-lifecycle-client";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

function makeFile(content: string): Uint8Array {
  return ENC.encode(content);
}

function makeSite(): Map<string, Uint8Array> {
  return new Map([
    ["index.html", makeFile('<html><head><link rel="stylesheet" href="/assets/site.css"></head><body><h1>Harbor</h1></body></html>')],
    ["assets/site.css", makeFile("body { margin: 0 }")],
    ["privacy/index.html", makeFile("<html><body>Privacy</body></html>")],
  ]);
}

function makeForm(chunkName = "index-abc123.js"): Map<string, Uint8Array> {
  return new Map([
    ["/_f/index.html", makeFile(`<html><script src="/assets/${chunkName}"></script></html>`)],
    [`/_f/assets/${chunkName}`, makeFile(`// form chunk\nconsole.log("form")`)],
    ["/_f/assets/style-xyz789.css", makeFile(".form { color: red }")],
  ]);
}

describe("renderBrand", () => {
  it("renames /_f/assets/*.js and *.css chunks with salt prefix", async () => {
    const { files, saltPrefix } = await renderBrand(makeSite(), makeForm(), "brand-1", "rev-1");
    expect(saltPrefix).toHaveLength(8);

    const paths = [...files.keys()];
    // Original chunk path should not exist
    expect(paths.find((p) => p === "/_f/assets/index-abc123.js")).toBeUndefined();
    // Salted path should exist
    const saltedJs = paths.find((p) => /^\/_f\/assets\/[0-9a-f]{8}_index-abc123\.js$/.test(p));
    expect(saltedJs).toBeDefined();
    const saltedCss = paths.find((p) => /^\/_f\/assets\/[0-9a-f]{8}_style-xyz789\.css$/.test(p));
    expect(saltedCss).toBeDefined();
  });

  it("rewrites references inside /_f/index.html to use salted chunk names", async () => {
    const { files, saltPrefix } = await renderBrand(makeSite(), makeForm(), "brand-1", "rev-1");
    const html = DEC.decode(files.get("/_f/index.html")!);
    expect(html).toContain(`${saltPrefix}_index-abc123.js`);
    expect(html).not.toContain("index-abc123.js\" ");
  });

  it("does not add a readable platform marker to salted JS chunks", async () => {
    const { files, saltPrefix } = await renderBrand(makeSite(), makeForm(), "brand-1", "rev-1");
    const saltedJs = [...files.keys()].find((p) => p.includes("_index-abc123.js"))!;
    const content = DEC.decode(files.get(saltedJs)!);
    expect(content).not.toContain("anjuna");
    expect(content).toContain("console.log");
  });

  it("keeps every rendered HTML, JS, and CSS byte free of platform and identity markers", async () => {
    const template = new Map([
      ["index.html", makeFile("<h1>Harbor</h1>")],
      ["assets/site.css", makeFile(".harbor { color: red }")],
    ]);
    const form = new Map([
      ["/_f/index.html", makeFile('<script src="/assets/index-abc123.js"></script>')],
      ["/_f/assets/index-abc123.js", makeFile("console.log('form')")],
      ["/_f/assets/style-xyz789.css", makeFile(".form { color: red }")],
    ]);
    const { files } = await renderBrand(template, form, "harbor-brand", "rev-1");
    for (const [path, bytes] of files) {
      if (/\.(html?|js|css)$/i.test(path)) {
        const content = DEC.decode(bytes).toLowerCase();
        expect(content, path).not.toMatch(/anjuna|aurum|harbor-brand|posthog|sentry|dsn|api[_-]?key/);
      }
    }
  });

  it("preserves template files unchanged", async () => {
    const { files } = await renderBrand(makeSite(), makeForm(), "brand-1", "rev-1");
    const css = DEC.decode(files.get("assets/site.css")!);
    expect(css).toBe("body { margin: 0 }");
  });

  it("produces different salts for different brands", async () => {
    const { saltPrefix: salt1 } = await renderBrand(makeSite(), makeForm(), "brand-1", "rev-1");
    const { saltPrefix: salt2 } = await renderBrand(makeSite(), makeForm(), "brand-2", "rev-1");
    expect(salt1).not.toBe(salt2);
  });

  it("produces different salts for different revisions of the same brand", async () => {
    const { saltPrefix: salt1 } = await renderBrand(makeSite(), makeForm(), "brand-1", "rev-1");
    const { saltPrefix: salt2 } = await renderBrand(makeSite(), makeForm(), "brand-1", "rev-2");
    expect(salt1).not.toBe(salt2);
  });

  it("is deterministic for the same brand + revision", async () => {
    const { saltPrefix: salt1 } = await renderBrand(makeSite(), makeForm(), "brand-x", "rev-x");
    const { saltPrefix: salt2 } = await renderBrand(makeSite(), makeForm(), "brand-x", "rev-x");
    expect(salt1).toBe(salt2);
  });
});

describe("factory lifecycle client", () => {
  it("forwards bearer auth and validates bounded lifecycle responses", async () => {
    const calls: Request[] = [];
    const binding = { fetch: async (request: Request) => {
      calls.push(request);
      return Response.json({ state: "applied", brand_id: "brand-a", account: "account-a", applied_revision_id: "rev-1", last_lifecycle_install_id: "install-1", paused: false, bundle_form_version: "form@abc1234", credential_account_match: true });
    } };
    const client = new CoreLifecycleClient(binding, "secret-token");
    await expect(client.runtimeState({ brand_id: "brand-a", account: "account-a" })).resolves.toMatchObject({ state: "applied" });
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer secret-token");
    expect(calls[0]!.url).toContain("/runtime-state");
  });

  it("does not expose upstream response bodies in bounded errors", async () => {
    const binding = { fetch: async () => new Response("private token and applicant data", { status: 503 }) };
    const client = new CoreLifecycleClient(binding, "secret-token");
    await expect(client.runtimeState({ brand_id: "brand-a", account: "account-a" })).rejects.toThrow("Core lifecycle request failed");
    await expect(client.runtimeState({ brand_id: "brand-a", account: "account-a" })).rejects.not.toThrow("private token");
  });
});

describe("brand upload bindings", () => {
  it("pins CORE to the default core handler and emits CORE_TOKEN as secret_text", async () => {
    let metadata: Record<string, unknown> | undefined;
    const fetcher = async (_input: string, init?: RequestInit) => {
      const form = init?.body as FormData;
      metadata = JSON.parse(await (form.get("metadata") as File).text());
      return Response.json({ success: true, result: { id: "script", etag: "etag" } });
    };
    await uploadScript("token", "account", "brand-a", "export default {}", {
      main_module: "worker.js", bindings: [], compatibility_date: "2026-08-01",
      brand_id: "brand-a", core_token: "core-secret",
    }, fetcher);
    expect(metadata?.bindings).toEqual(expect.arrayContaining([
      { type: "service", name: "CORE", service: "anjuna-core" },
      { type: "secret_text", name: "CORE_TOKEN", text: "core-secret" },
    ]));
    expect(JSON.stringify(metadata?.bindings)).not.toContain("LeadsRpc");
  });
});

describe("zip round-trip", () => {
  it("unzip(zip(files)) === files", () => {
    const original = makeSite();
    const roundtripped = unzip(zip(original));
    for (const [path, bytes] of original) {
      expect(roundtripped.get(path)).toBeDefined();
      expect(DEC.decode(roundtripped.get(path)!)).toBe(DEC.decode(bytes));
    }
  });
});
