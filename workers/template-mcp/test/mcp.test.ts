import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { computeFingerprint } from "../src/fingerprint";
import { LIMITS } from "../src/archive";
import { BASE, KEY, addBrand, addKey, addSealedTemplate, callTool, connect, resetDb, setupDb } from "./helpers";
import { ctaForm, goodSite, otherSite, tarGz, toZip, withIndex, zipBase64 } from "./fixtures";

beforeAll(setupDb);
beforeEach(async () => {
  await resetDb();
  await addKey();
});
afterEach(() => vi.unstubAllGlobals());

const rpc = (headers: Record<string, string> = {}, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" }) =>
  SELF.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });

describe("authentication", () => {
  it("rejects a missing, malformed or unknown key with 401", async () => {
    for (const headers of [{} as Record<string, string>, { authorization: "Basic abc" }, { authorization: "Bearer short" }, { authorization: "Bearer anj_mcp_not-a-real-key-0000000" }]) {
      const res = await rpc(headers);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    }
  });

  it("rejects a revoked key", async () => {
    expect((await rpc({ authorization: `Bearer ${KEY}` })).status).not.toBe(401);
    await env.FACTORY.prepare("UPDATE builder_keys SET revoked_at = '2026-10-02T01:00:00.000Z' WHERE key_id = 'bk_test'").run();
    const res = await rpc({ authorization: `Bearer ${KEY}` });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_api_key" });
  });

  it("stores only the SHA-256 hash and records last use", async () => {
    await rpc({ authorization: `Bearer ${KEY}` });
    const row = await env.FACTORY.prepare("SELECT key_hash, last_used_at FROM builder_keys WHERE key_id = 'bk_test'").first<{ key_hash: string; last_used_at: string }>();
    expect(row!.key_hash).toBe(await sha256Hex(KEY));
    expect(row!.key_hash).not.toContain(KEY);
    expect(row!.last_used_at).toBeTruthy();
  });

  it("serves /health unauthenticated and 404s other paths", async () => {
    expect(await (await SELF.fetch(`${BASE}/health`)).json()).toEqual({ ok: true });
    expect((await SELF.fetch(`${BASE}/other`)).status).toBe(404);
  });
});

describe("rate limit", () => {
  it("returns 429 with Retry-After beyond the per-key limit, per key", async () => {
    const original = env.RATE_LIMIT_PER_MINUTE;
    const { authenticate } = await import("../src/auth");
    const limited = { ...env, RATE_LIMIT_PER_MINUTE: "3" } as typeof env;
    const request = () => new Request(`${BASE}/mcp`, { headers: { authorization: `Bearer ${KEY}` } });
    const now = Date.UTC(2026, 9, 2, 12, 0, 10);
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await authenticate(request(), limited, now));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false, false]);
    const blocked = results[3]!;
    if (blocked.ok) throw new Error("expected rejection");
    expect(blocked.response.status).toBe(429);
    expect(blocked.response.headers.get("retry-after")).toBe("50");
    // a new window resets the counter, and another key is unaffected
    expect((await authenticate(request(), limited, now + 60_000)).ok).toBe(true);
    await addKey("anj_mcp_second-key-0123456789abcd", "other", "bk_other");
    const other = new Request(`${BASE}/mcp`, { headers: { authorization: "Bearer anj_mcp_second-key-0123456789abcd" } });
    expect((await authenticate(other, limited, now)).ok).toBe(true);
    expect(env.RATE_LIMIT_PER_MINUTE).toBe(original);
  });
});

describe("tools over streamable HTTP", () => {
  it("lists exactly the four tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_github_repo", "check_template", "get_template_contract", "similarity_check"]);
    await client.close();
  });

  it("get_template_contract", async () => {
    const client = await connect();
    const { data } = await callTool(client, "get_template_contract");
    expect(data.title).toMatch(/contract/i);
    expect(data.amount_buckets).toContain(5000);
    expect(data.rules.map((r: { id: string }) => r.id)).toContain("keyword-slot");
    await client.close();
  });

  it("check_template: passes a good zip and fails a bad one with fixes", async () => {
    const client = await connect();
    const good = await callTool(client, "check_template", { zip_base64: zipBase64(goodSite()) });
    expect(good.data.pass).toBe(true);
    expect(good.data.errors).toBe(0);

    const bad = await callTool(client, "check_template", {
      zip_base64: zipBase64(withIndex(goodSite(), (h) => h.replace('<span data-kw>Funding Options</span>', "Funding").replace("</head>", '<script src="https://cdn.example.com/a.js"></script></head>'))),
    });
    expect(bad.data.pass).toBe(false);
    expect(bad.data.issues.map((i: { rule: string }) => i.rule)).toEqual(expect.arrayContaining(["keyword", "external"]));
    for (const issue of bad.data.issues) expect(issue.message.length).toBeGreaterThan(10);
    await client.close();
  });

  it("check_template: other brands' identifiers fail unless it is the brand's own", async () => {
    await addBrand("b_lantern", "Lantern Finance", "lanternfinance.com");
    const html = (h: string) => h.replace("Answer two", "See lanternfinance.com. Answer two");
    const client = await connect();
    const other = await callTool(client, "check_template", { zip_base64: zipBase64(withIndex(goodSite(), html)) });
    expect(other.data.issues.some((i: { rule: string }) => i.rule === "brand")).toBe(true);
    const own = await callTool(client, "check_template", { zip_base64: zipBase64(withIndex(goodSite(), html)), brand_id: "b_lantern" });
    expect(own.data.pass).toBe(true);
    await client.close();
  });

  it("check_template: input validation and limits are reported as tool errors", async () => {
    const client = await connect();
    const none = await callTool(client, "check_template", {});
    expect(none.isError).toBe(true);
    expect(none.data.error).toBe("bad_input");
    const both = await callTool(client, "check_template", { zip_base64: "AAAA", url: "https://example.com" });
    expect(both.data.error).toBe("bad_input");
    const slip = await callTool(client, "check_template", { zip_base64: zipBase64(new Map([["../evil.html", new Uint8Array(3)]])) });
    expect(slip.isError).toBe(true);
    expect(slip.data.error).toBe("zip_slip");
    const many = new Map<string, Uint8Array>();
    for (let i = 0; i < LIMITS.maxFiles + 1; i++) many.set(`f${i}.txt`, new Uint8Array(1));
    expect((await callTool(client, "check_template", { zip_base64: zipBase64(many) })).data.error).toBe("too_many_files");
    expect((await callTool(client, "check_template", { url: "http://example.com/site.zip" })).data.error).toBe("bad_url");
    expect((await callTool(client, "check_template", { url: "https://localhost/site.zip" })).data.error).toBe("bad_url");
    expect((await callTool(client, "check_template", { url: "https://10.0.0.1/site.zip" })).data.error).toBe("bad_url");
    await client.close();
  });

  it("check_template: URL of a zip", async () => {
    const zip = toZip(goodSite());
    vi.stubGlobal("fetch", async (url: string) => {
      expect(String(url)).toBe("https://builds.example.com/site.zip");
      return new Response(zip, { headers: { "content-type": "application/zip" } });
    });
    const client = await connect();
    const { data } = await callTool(client, "check_template", { url: "https://builds.example.com/site.zip" });
    expect(data.pass).toBe(true);
    expect(data.source).toBe("url:zip:builds.example.com");
    await client.close();
  });

  it("check_template: URL of a live static site is crawled (JS never executed)", async () => {
    const files = new Map(goodSite());
    const served = new Map<string, { body: Uint8Array; type: string }>();
    for (const [path, body] of files) {
      const route = path === "index.html" ? "/" : path.endsWith("/index.html") ? `/${path.slice(0, -11)}/` : `/${path}`;
      served.set(route, { body, type: path.endsWith(".css") ? "text/css" : "text/html" });
    }
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(String(input));
      seen.push(url.pathname);
      const hit = served.get(url.pathname);
      return hit ? new Response(hit.body, { headers: { "content-type": hit.type } }) : new Response("nope", { status: 404 });
    });
    const client = await connect();
    const { data } = await callTool(client, "check_template", { url: "https://harbor.example.com/" });
    expect(data.issues).toEqual([]);
    expect(data.pass).toBe(true);
    expect(data.source).toBe("url:site:harbor.example.com");
    expect(data.notes.join(" ")).toMatch(/JavaScript was not executed/);
    expect(seen).toEqual(expect.arrayContaining(["/", "/privacy/", "/assets/site.css"]));
    await client.close();
  });

  it("check_github_repo: uses committed dist, reports needs-build, and 404s", async () => {
    const siteFiles = goodSite();
    const tar = tarGz([
      { path: "o-r-abc/package.json", content: '{"dependencies":{"astro":"^5"}}' },
      ...[...siteFiles].map(([p, b]) => ({ path: `o-r-abc/dist/${p}`, content: b })),
      { path: "o-r-abc/src/pages/index.astro", content: "x" },
    ]);
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(String(url));
      return String(url).includes("/repos/o/r/") ? new Response(tar, { headers: { "content-type": "application/x-gzip" } }) : new Response("{}", { status: 404 });
    });
    const client = await connect();
    const ok = await callTool(client, "check_github_repo", { owner: "o", repo: "r", ref: "main" });
    expect(calls[0]).toBe("https://api.github.com/repos/o/r/tarball/main");
    expect(ok.data.pass).toBe(true);
    expect(ok.data.source).toBe("github:o/r@main:dist");

    const sourceOnly = tarGz([
      { path: "o-r-abc/package.json", content: '{"devDependencies":{"vite":"^6"}}' },
      { path: "o-r-abc/index.html", content: '<script type="module" src="/src/main.tsx"></script>' },
    ]);
    vi.stubGlobal("fetch", async () => new Response(sourceOnly));
    const needs = await callTool(client, "check_github_repo", { owner: "o", repo: "r" });
    expect(needs.data.pass).toBe(false);
    expect(needs.data.issues[0].fix).toContain("vite build");
    expect(needs.data.issues[0].fix).toContain("git add -f dist");

    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const missing = await callTool(client, "check_github_repo", { owner: "o", repo: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.data.error).toBe("repo_not_found");
    expect((await callTool(client, "check_github_repo", { owner: "o", repo: "r", ref: "a..b" })).data.error).toBe("bad_ref");
    await client.close();
  });

  it("check_github_repo: ignores symlinks and node_modules in the tarball", async () => {
    const tar = tarGz([
      { path: "o-r-abc/dist/index.html", content: "<html></html>" },
      { path: "o-r-abc/dist/evil", type: "2", linkname: "../../etc/passwd" },
      { path: "o-r-abc/node_modules/pkg/index.js", content: "x" },
    ]);
    vi.stubGlobal("fetch", async () => new Response(tar));
    const client = await connect();
    const { data } = await callTool(client, "check_github_repo", { owner: "o", repo: "r" });
    expect(data.stats.files).toBe(1);
    await client.close();
  });
});

describe("similarity_check", () => {
  it("passes when nothing is sealed yet", async () => {
    const client = await connect();
    const { data } = await callTool(client, "similarity_check", { zip_base64: zipBase64(goodSite()) });
    expect(data.pass).toBe(true);
    expect(data.compared).toBe(0);
    await client.close();
  });

  it("fails a near-copy of another brand and names it with what to change", async () => {
    await addBrand("b_harbor", "Harbor", "harbor.example");
    await addSealedTemplate({ id: "h", name: "harbor-v1", fingerprint: await computeFingerprint(goodSite()), brandId: "b_harbor" });
    const copy = goodSite({ title: "Reskin | Funding" }); // same layout and copy, new title
    const client = await connect();
    const { data } = await callTool(client, "similarity_check", { zip_base64: zipBase64(copy) });
    expect(data.pass).toBe(false);
    expect(data.summary).toMatch(/Harbor/);
    expect(data.closest[0].brands[0].name).toBe("Harbor");
    expect(data.closest[0].score).toBeGreaterThan(0.9);
    expect(data.fixes.length).toBeGreaterThan(0);
    expect(data.fixes.join(" ")).toMatch(/Rewrite the landing-page copy/);
    await client.close();
  });

  it("fails a light reskin (same structure and copy, different class names)", async () => {
    await addSealedTemplate({ id: "h", name: "harbor-v1", fingerprint: await computeFingerprint(goodSite()) });
    const reskin = goodSite({ classPrefix: "other" });
    const client = await connect();
    const { data } = await callTool(client, "similarity_check", { zip_base64: zipBase64(reskin) });
    expect(data.pass).toBe(false);
    await client.close();
  });

  it("passes a genuinely different design", async () => {
    await addBrand("b_harbor", "Harbor", "harbor.example");
    await addSealedTemplate({ id: "h", name: "harbor-v1", fingerprint: await computeFingerprint(goodSite()), brandId: "b_harbor" });
    const client = await connect();
    const { data } = await callTool(client, "similarity_check", { zip_base64: zipBase64(otherSite()) });
    expect(data.pass).toBe(true);
    expect(data.compared).toBe(1);
    expect(data.closest[0].score).toBeLessThan(0.5);
    await client.close();
  });

  it("fails on shared images even when everything else differs", async () => {
    const shared = Object.fromEntries([1, 2, 3].map((n) => [`img/p${n}.png`, new Uint8Array(500).fill(n)]));
    await addSealedTemplate({ id: "h", name: "harbor-v1", fingerprint: await computeFingerprint(goodSite({ images: shared })) });
    const candidate = otherSite();
    for (const [p, b] of Object.entries(shared)) candidate.set(p, b);
    const client = await connect();
    const { data } = await callTool(client, "similarity_check", { zip_base64: zipBase64(candidate) });
    expect(data.pass).toBe(false);
    expect(data.closest[0].shared_images).toBe(3);
    expect(data.fixes.join(" ")).toMatch(/images|assets/i);
    await client.close();
  });

  it("excludes the brand's own earlier template", async () => {
    await addBrand("b_harbor", "Harbor", "harbor.example");
    await addSealedTemplate({ id: "h", name: "harbor-v1", fingerprint: await computeFingerprint(goodSite()), brandId: "b_harbor" });
    const client = await connect();
    const own = await callTool(client, "similarity_check", { zip_base64: zipBase64(goodSite()), brand_id: "b_harbor" });
    expect(own.data.pass).toBe(true);
    expect(own.data.compared).toBe(0);
    await client.close();
  });

  it("ignores unsealed templates", async () => {
    await addSealedTemplate({ id: "h", name: "harbor-v1", fingerprint: await computeFingerprint(goodSite()) });
    await env.FACTORY.exec("DROP TRIGGER template_versions_sealed_immutable");
    await env.FACTORY.prepare("UPDATE template_versions SET status = 'certified', sealed_at = NULL, sealed_by = NULL").run();
    const client = await connect();
    const { data } = await callTool(client, "similarity_check", { zip_base64: zipBase64(goodSite()) });
    expect(data.compared).toBe(0);
    await client.close();
  });
});

void ctaForm;
