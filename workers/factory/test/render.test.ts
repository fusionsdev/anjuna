import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
// The form release script is pure (no node imports) so the same code runs here; this test proves its
// ZIP is what the install Workflow reads, without a mirror that could drift.
import { formZipEntries, storeZip } from "../../../apps/lead-form/scripts/zip-store.mjs";
import { assertCleanBrandBytes, readZipFromR2, renderBrand, unzip, zip } from "../src/render";
import { apexDnsRecords, assetContentType, attachCustomDomain, createAssetsSession, deployScript, detachCustomDomain, listCustomDomains, publicApexDnsRecords, uploadAssetBucket, uploadScript } from "../src/cf-api";
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
  it("accepts analytics SDK vocabulary and the neutral Sentry placeholder", async () => {
    const form = makeForm();
    form.set("/_f/assets/index-abc123.js", makeFile('window.posthog={};const dsn="https://public@placeholder.invalid/0";console.log("Sentry");'));
    const site = makeSite();
    site.set("assets/site.css", makeFile(".brand-logo { color: red }"));
    await expect(renderBrand(site, form, "brand_0123456789abcdef", "rev-1")).resolves.toBeDefined();
  });
  it("renames /_f/assets/*.js and *.css chunks to opaque deterministic names", async () => {
    const { files, saltPrefix } = await renderBrand(makeSite(), makeForm(), "brand-1", "rev-1");
    expect(saltPrefix).toHaveLength(8);

    const paths = [...files.keys()];
    // Original chunk path should not exist
    expect(paths.find((p) => p === "/_f/assets/index-abc123.js")).toBeUndefined();
    // Salted path should exist, without exposing the source basename.
    const saltedJs = paths.find((p) => /^\/_f\/assets\/[0-9a-f]{8}_[0-9a-f]{16}\.js$/.test(p));
    expect(saltedJs).toBeDefined();
    const saltedCss = paths.find((p) => /^\/_f\/assets\/[0-9a-f]{8}_[0-9a-f]{16}\.css$/.test(p));
    expect(saltedCss).toBeDefined();
    expect([...files.entries()].flatMap(([path, bytes]) => [path, DEC.decode(bytes)])
      .join("\n")).not.toContain("index-abc123");
    expect([...files.entries()].flatMap(([path, bytes]) => [path, DEC.decode(bytes)])
      .join("\n")).not.toContain("style-xyz789");
  });

  it("rewrites references inside /_f/index.html to use salted chunk names", async () => {
    const { files, saltPrefix } = await renderBrand(makeSite(), makeForm(), "brand-1", "rev-1");
    const html = DEC.decode(files.get("/_f/index.html")!);
    expect(html).toMatch(new RegExp(`${saltPrefix}_[0-9a-f]{16}\\.js`));
    expect(html).not.toContain("index-abc123.js");
  });

  it("does not add a readable platform marker to salted JS chunks", async () => {
    const { files, saltPrefix } = await renderBrand(makeSite(), makeForm(), "brand-1", "rev-1");
    const saltedJs = [...files.keys()].find((p) => /^\/_f\/assets\/[0-9a-f]{8}_[0-9a-f]{16}\.js$/.test(p))!;
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
    const first = await renderBrand(makeSite(), makeForm(), "brand-x", "rev-x");
    const second = await renderBrand(makeSite(), makeForm(), "brand-x", "rev-x");
    const salt1 = first.saltPrefix;
    const salt2 = second.saltPrefix;
    expect(salt1).toBe(salt2);
    expect([...first.files.keys()]).toEqual([...second.files.keys()]);
    expect([...first.files].map(([path, bytes]) => [path, DEC.decode(bytes)])).toEqual(
      [...second.files].map(([path, bytes]) => [path, DEC.decode(bytes)]),
    );
  });

  it.each([
    ["platform marker in content", "/_f/index.html", "anjuna", "harbor-brand"],
    ["legacy marker in content", "/_f/index.html", "aurum", "harbor-brand"],
    ["generated cross-brand ID", "/_f/index.html", "brand_0123456789abcdef", "harbor-brand"],
    ["PostHog key in content", "/_f/index.html", "phc_0123456789abcdef", "harbor-brand"],
    ["Sentry DSN in content", "/_f/index.html", "https://public@sentry.example/1", "harbor-brand"],
    ["self-hosted DSN", "/_f/index.html", "https://public@errors.example/1", "harbor-brand"],
    ["forbidden identity in filename", "/_f/assets/aurum.js", "console.log('clean')", "harbor-brand"],
  ])("rejects real negative fixture: %s", async (_name, path, content, brandId) => {
    const form = new Map<string, Uint8Array>([
      ["/_f/index.html", makeFile("<html></html>")],
      [path, makeFile(content)],
    ]);
    await expect(renderBrand(makeSite(), form, brandId, "rev-1")).rejects.toThrow(/forbidden identity/);
  });

  it("scans every rendered path and content for forbidden identities", () => {
    expect(() => assertCleanBrandBytes(new Map([
      ["/assets/clean.js", makeFile("console.log('aurum')")],
    ]), "harbor-brand")).toThrow();
    expect(() => assertCleanBrandBytes(new Map([
      ["/assets/anjuna.css", makeFile(".clean { color: red }")],
    ]), "harbor-brand")).toThrow();
  });
});

describe("form ZIP built by apps/lead-form/scripts/form-zip.mjs", () => {
  // Dist-relative paths exactly as vite writes them with base "/_f/".
  const dist = new Map<string, Uint8Array>([
    ["index.html", makeFile('<html><script type="module" src="/_f/assets/index-abc123.js"></script><link rel="stylesheet" href="/_f/assets/style-xyz789.css"></html>')],
    ["assets/index-abc123.js", makeFile('console.log("form")')],
    ["assets/style-xyz789.css", makeFile(".form { color: red }")],
  ]);
  const key = "forms/form-abc1234";

  it("is read by readZipFromR2 under the /_f/ paths renderBrand expects", async () => {
    await env.ARTIFACTS.put(key, storeZip(formZipEntries(dist)));
    const form = await readZipFromR2(env.ARTIFACTS, key);
    expect([...form.keys()].sort()).toEqual(["/_f/assets/index-abc123.js", "/_f/assets/style-xyz789.css", "/_f/index.html"]);
    expect(DEC.decode(form.get("/_f/assets/index-abc123.js")!)).toBe('console.log("form")');
  });

  it("renders: chunks get opaque names, index.html points at them, the form is served at /_f/", async () => {
    await env.ARTIFACTS.put(key, storeZip(formZipEntries(dist)));
    const form = await readZipFromR2(env.ARTIFACTS, key);
    const { files, saltPrefix } = await renderBrand(makeSite(), form, "brand-1", "rev-1");
    const paths = [...files.keys()];
    const formPaths = paths.filter((p) => p.startsWith("/_f/"));
    expect(formPaths).toHaveLength(3);
    expect(formPaths).toContain("/_f/index.html");
    expect(formPaths.filter((p) => p.startsWith(`/_f/assets/${saltPrefix}_`) && p.endsWith(".js"))).toHaveLength(1);
    expect(formPaths.filter((p) => p.startsWith(`/_f/assets/${saltPrefix}_`) && p.endsWith(".css"))).toHaveLength(1);
    const html = DEC.decode(files.get("/_f/index.html")!);
    expect(html).not.toContain("index-abc123");
    expect(html).not.toContain("style-xyz789");
    for (const path of paths.filter((p) => p.startsWith("/_f/assets/"))) expect(html).toContain(path.split("/").pop()!);
  });

  it("reads back the same entries and bytes as the factory's own zip()", async () => {
    const entries = formZipEntries(dist);
    const viaScript = unzip(storeZip(entries));
    const viaFactory = unzip(zip(new Map(entries.map((entry) => [entry.path, entry.bytes]))));
    const text = (files: Map<string, Uint8Array>) => [...files].map(([path, bytes]) => [path, DEC.decode(bytes)]).sort(([a], [b]) => String(a).localeCompare(String(b)));
    expect(text(viaScript)).toEqual(text(viaFactory));
  });

  it("without the leading slash the chunks would not be renamed (why every entry starts with /_f/)", async () => {
    const flat = unzip(storeZip([{ path: "_f/assets/index-abc123.js", bytes: makeFile("x") }, { path: "_f/index.html", bytes: makeFile("<p></p>") }]));
    const { files } = await renderBrand(makeSite(), flat, "brand-1", "rev-1");
    expect(files.has("_f/assets/index-abc123.js")).toBe(true);
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

  it.each(["", "secret\n-token", "secret\r-token"])("rejects invalid CORE_TOKEN before authorization construction (%j)", (token) => {
    expect(() => new CoreLifecycleClient({ fetch: async () => { throw new Error("must not fetch"); } }, token)).toThrow(/CORE_TOKEN/);
  });
});

describe("brand upload bindings", () => {
  it("passes the assets routing config through to the upload metadata", async () => {
    let metadata: Record<string, unknown> | undefined;
    const fetcher = async (_input: string, init?: RequestInit) => {
      metadata = JSON.parse(await ((init?.body as FormData).get("metadata") as File).text());
      return Response.json({ success: true, result: { id: "script", etag: "etag" } });
    };
    await uploadScript("token", "account", "brand-a", "export default {}", {
      main_module: "worker.js", bindings: [], compatibility_date: "2026-08-01",
      assets: { jwt: "jwt", config: { html_handling: "none", run_worker_first: true } },
    }, fetcher);
    expect(metadata?.assets).toEqual({ jwt: "jwt", config: { html_handling: "none", run_worker_first: true } });
  });

  it("preserves the configured tenant CORE handler and emits CORE_TOKEN as secret_text", async () => {
    let metadata: Record<string, unknown> | undefined;
    const fetcher = async (_input: string, init?: RequestInit) => {
      const form = init?.body as FormData;
      metadata = JSON.parse(await (form.get("metadata") as File).text());
      return Response.json({ success: true, result: { id: "script", etag: "etag" } });
    };
    await uploadScript("token", "account", "brand-a", "export default {}", {
      main_module: "worker.js", bindings: [{ type: "service", name: "CORE", service: "tenant-core" }], compatibility_date: "2026-08-01",
      brand_id: "brand-a", core_token: "core-secret",
    }, fetcher);
    expect(metadata?.bindings).toEqual(expect.arrayContaining([
      { type: "service", name: "CORE", service: "tenant-core" },
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

describe("apex DNS preflight", () => {
  it("queries each hostname with a single exact name and keeps only blocking record types", async () => {
    const urls: string[] = [];
    const records: Record<string, Array<{ id: string; type: string; name: string }>> = {
      "brand.example": [{ id: "1", type: "A", name: "brand.example" }, { id: "2", type: "TXT", name: "brand.example" }, { id: "3", type: "MX", name: "brand.example" }],
      "www.brand.example": [{ id: "4", type: "CNAME", name: "www.brand.example" }, { id: "5", type: "AAAA", name: "www.brand.example" }],
    };
    const fetcher = async (input: string) => {
      urls.push(input);
      const name = new URL(input).searchParams.get("name")!;
      return Response.json({ success: true, result: records[name] ?? [] });
    };
    const found = await apexDnsRecords("token", "zone-1", ["brand.example", "www.brand.example"], fetcher);
    for (const url of urls) {
      const params = new URL(url).searchParams;
      expect(params.get("name")).not.toContain(",");
      expect(params.has("type")).toBe(false);
    }
    expect(urls.map((url) => new URL(url).searchParams.get("name"))).toEqual(["brand.example", "www.brand.example"]);
    expect(found.map((r) => `${r.type} ${r.name}`)).toEqual(["A brand.example", "CNAME www.brand.example", "AAAA www.brand.example"]);
  });

  it("never queries a www hostname for a subdomain brand", async () => {
    const names: string[] = [];
    const fetcher = async (input: string) => {
      names.push(new URL(input).searchParams.get("name")!);
      return Response.json({ success: true, result: [] });
    };
    expect(await apexDnsRecords("token", "zone-1", ["demo05.aduplift.ai"], fetcher)).toEqual([]);
    expect(names).toEqual(["demo05.aduplift.ai"]);
  });

  it("returns nothing for a zone whose apex and www carry only non-blocking records", async () => {
    const fetcher = async () => Response.json({ success: true, result: [{ id: "1", type: "TXT", name: "brand.example" }] });
    expect(await apexDnsRecords("token", "zone-1", ["brand.example", "www.brand.example"], fetcher)).toEqual([]);
  });
});

describe("apex DNS preflight fallback", () => {
  const doh = (answers: Record<string, Array<{ name: string; type: number }>>) => async (input: string) => {
    const url = new URL(input);
    if (url.hostname === "api.cloudflare.com") {
      return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null });
    }
    const key = `${url.searchParams.get("type")} ${url.searchParams.get("name")}`;
    return Response.json({ Status: 0, Answer: answers[key] ?? [] });
  };

  it("uses the public DNS view when the zone DNS API refuses the token (10000)", async () => {
    const fetcher = doh({ "CNAME www.brand.example": [{ name: "www.brand.example.", type: 5 }] });
    expect(await apexDnsRecords("token", "zone-1", ["brand.example", "www.brand.example"], fetcher)).toEqual([
      { id: "public-dns", type: "CNAME", name: "www.brand.example" },
    ]);
  });

  it("reports no conflicts for empty apex and www in the public view", async () => {
    expect(await apexDnsRecords("token", "zone-1", ["brand.example", "www.brand.example"], doh({}))).toEqual([]);
  });

  it("checks only the bare domain in the public view for a subdomain brand", async () => {
    const names: string[] = [];
    const fetcher = async (input: string) => {
      const url = new URL(input);
      if (url.hostname === "api.cloudflare.com") {
        return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null });
      }
      names.push(`${url.searchParams.get("type")} ${url.searchParams.get("name")}`);
      return Response.json({ Status: 0, Answer: [] });
    };
    expect(await apexDnsRecords("token", "zone-1", ["demo05.aduplift.ai"], fetcher)).toEqual([]);
    expect(names).toEqual(["A demo05.aduplift.ai", "AAAA demo05.aduplift.ai", "CNAME demo05.aduplift.ai"]);
  });

  it("does not fall back on other API errors", async () => {
    const fetcher = async () => Response.json({ success: false, errors: [{ code: 7003, message: "Could not route" }], result: null });
    await expect(apexDnsRecords("token", "zone-1", ["brand.example"], fetcher)).rejects.toThrow("7003");
  });

  it("fails closed when the public lookup itself fails", async () => {
    const fetcher = async () => new Response("down", { status: 502 });
    await expect(publicApexDnsRecords(["brand.example"], fetcher)).rejects.toThrow("HTTP 502");
  });
});

describe("static assets direct upload", () => {
  it("registers the manifest on the script's assets-upload-session endpoint with the API token", async () => {
    let call: { url: string; init?: RequestInit } | undefined;
    const fetcher = async (url: string, init?: RequestInit) => {
      call = { url, init };
      return Response.json({ success: true, result: { jwt: "upload-jwt", buckets: [["a".repeat(32)]] } });
    };
    const session = await createAssetsSession("api-token", "acct", "brand-x", { "/index.html": { hash: "a".repeat(32), size: 5 } }, fetcher);
    expect(call!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/brand-x/assets-upload-session");
    expect((call!.init!.headers as Record<string, string>).Authorization).toBe("Bearer api-token");
    expect(JSON.parse(call!.init!.body as string)).toEqual({ manifest: { "/index.html": { hash: "a".repeat(32), size: 5 } } });
    expect(session).toEqual({ jwt: "upload-jwt", buckets: [["a".repeat(32)]] });
  });

  it("uploads a bucket as base64 multipart with the upload JWT and returns the completion JWT", async () => {
    let call: { url: string; init?: RequestInit } | undefined;
    const fetcher = async (url: string, init?: RequestInit) => {
      call = { url, init };
      return Response.json({ success: true, result: { jwt: "completion-jwt" } }, { status: 201 });
    };
    const jwt = await uploadAssetBucket("upload-jwt", "acct", [{ hash: "b".repeat(32), base64: btoa("hello"), contentType: "text/html" }], fetcher);
    expect(call!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/workers/assets/upload?base64=true");
    expect((call!.init!.headers as Record<string, string>).Authorization).toBe("Bearer upload-jwt");
    const part = (call!.init!.body as FormData).get("b".repeat(32)) as File;
    expect([await part.text(), part.type]).toEqual([btoa("hello"), "text/html"]);
    expect(jwt).toBe("completion-jwt");
  });

  it("reports a non-JSON upload failure clearly instead of a JSON parse error", async () => {
    const fetcher = async () => new Response("Unauthorized", { status: 401 });
    await expect(uploadAssetBucket("bad", "acct", [], fetcher)).rejects.toThrow("Asset upload failed: 401 Unauthorized");
  });

  it("maps content types by extension", () => {
    expect(["/index.html", "/_f/assets/a.js", "/assets/x.woff2", "/data.bin"].map(assetContentType))
      .toEqual(["text/html", "application/javascript", "font/woff2", "application/null"]);
  });
});

describe("deploy and custom domains API", () => {
  const capture = () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.endsWith("/deployments") && init?.method === "GET") {
        return Response.json({ success: true, result: { deployments: [{ id: "d2", versions: [{ version_id: "v2", percentage: 100 }] }] } });
      }
      return Response.json({ success: true, result: { id: "x", hostname: "brand.example", service: "brand-x", versions: [] } });
    };
    return { calls, fetcher };
  };

  it("reads the deployment created by the script upload when no version is given", async () => {
    const { calls, fetcher } = capture();
    const deployment = await deployScript("t", "acct", "brand-x", undefined, fetcher);
    expect(calls).toEqual([{ url: "https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/brand-x/deployments", method: "GET", body: undefined }]);
    expect(deployment.versions[0]!.version_id).toBe("v2");
  });

  it("deploys an explicit version at 100% (rollback)", async () => {
    const { calls, fetcher } = capture();
    await deployScript("t", "acct", "brand-x", "v1", fetcher);
    expect(calls[0]).toMatchObject({ method: "POST", body: { strategy: "percentage", versions: [{ version_id: "v1", percentage: 100 }] } });
  });

  it("attaches, lists and detaches Custom Domains on the account-level Workers Domains API", async () => {
    const { calls, fetcher } = capture();
    await attachCustomDomain("t", "acct", "zone-1", "brand.example", "brand-x", fetcher);
    await listCustomDomains("t", "acct", "zone-1", "brand-x", fetcher);
    await detachCustomDomain("t", "acct", "dom-1", fetcher);
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://api.cloudflare.com/client/v4", "")}`)).toEqual([
      "PUT /accounts/acct/workers/domains",
      "GET /accounts/acct/workers/domains?zone_id=zone-1&service=brand-x",
      "DELETE /accounts/acct/workers/domains/dom-1",
    ]);
    expect(calls[0]!.body).toEqual({ hostname: "brand.example", service: "brand-x", zone_id: "zone-1", environment: "production" });
  });
});
