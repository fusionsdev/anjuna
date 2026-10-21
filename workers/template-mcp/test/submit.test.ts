import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateSubmitResult } from "@anjuna/contracts";
import { InputError, readZip } from "../src/archive";
import { computeFingerprint } from "../src/fingerprint";
import {
  UPLOAD_CALL_MAX_CHARS, UPLOAD_MAX_CHARS, UPLOAD_MAX_CHUNKS, UPLOAD_MAX_OPEN_PER_KEY, addUploadChunks, assembleZip, beginUpload, detectFramework, filesToMap, payloadStats, submitTemplate, takeUpload, type SubmitRequest,
} from "../src/submit";
import { goodSite, withFile, withIndex } from "./fixtures";
import { NOW, addBrand, addKey, addSealedTemplate, resetDb, setupDb } from "./helpers";

vi.mock("../src/screenshots", () => ({ takeScreenshot: vi.fn() }));
import { takeScreenshot } from "../src/screenshots";

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

const browserEnv = { ...env, BROWSER: {} as Fetcher };
const builder = { key_id: "bk_test", label: "Somchai (bolt.new)" };
const request = (files = goodSite(), over: Partial<SubmitRequest> = {}): SubmitRequest => ({
  template_id: "harbor", template_name: "Harbor", files, submitted_by: builder, created_by: "bk_test", ...over,
});
const versions = async () =>
  (await env.FACTORY.prepare("SELECT template_version_id, status, submitted_by_key_id, submitted_by_label, text_defaults_json FROM template_versions ORDER BY created_at").all<Record<string, unknown>>()).results;

describe("submitTemplate", () => {
  beforeAll(setupDb);
  beforeEach(async () => {
    await resetDb();
    vi.mocked(takeScreenshot).mockReset().mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
  });

  it("imports, certifies and records the submitter and text defaults", async () => {
    const result = TemplateSubmitResult.parse(await submitTemplate(browserEnv, request()));
    expect(result).toMatchObject({
      status: "awaiting_approval", template_version_id: "tv_harbor_v1", version: 1, issues: [],
      text_defaults: { brand_name: "Harbor", title: "Harbor | Funding", description: "Check your funding options in minutes." },
      dashboard_url: "https://app.test/#templates/tv_harbor_v1",
    });
    const [row] = await versions();
    expect(row).toMatchObject({ status: "certified", submitted_by_key_id: "bk_test", submitted_by_label: "Somchai (bolt.new)" });
    expect(JSON.parse(String(row!.text_defaults_json))).toEqual(result.text_defaults);
    const stored = await env.FACTORY.prepare("SELECT r2_key, sha256 FROM template_versions").first<{ r2_key: string; sha256: string }>();
    expect(stored!.sha256).toBe(result.sha256);
    expect(await env.ARTIFACTS.head(stored!.r2_key)).not.toBeNull();
  });

  it("returns the existing version for the same files in any order and creates nothing", async () => {
    const first = await submitTemplate(browserEnv, request());
    const again = await submitTemplate(browserEnv, request(new Map([...goodSite()].reverse())));
    expect(again).toMatchObject({ status: "duplicate", template_version_id: first.template_version_id, sha256: first.sha256 });
    expect(await versions()).toHaveLength(1);
  });

  it("re-certifies the same files when the stored version was rejected, without creating a version", async () => {
    const first = await submitTemplate(browserEnv, request());
    // A version rejected under the previous policy can be retried in place.
    await env.FACTORY.prepare("UPDATE template_versions SET status = 'rejected' WHERE template_version_id = ?1").bind(first.template_version_id).run();
    const again = await submitTemplate(browserEnv, request(goodSite(), { submitted_by: { key_id: "bk_other", label: "Second try" } }));
    expect(again).toMatchObject({ status: "awaiting_approval", template_version_id: "tv_harbor_v1", version: 1, sha256: first.sha256, issues: [] });
    const rows = await versions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "certified", submitted_by_key_id: "bk_other" });
  });

  it("rejects contract failures with rule, file, message and fix, and stores nothing", async () => {
    const before = (await env.ARTIFACTS.list()).objects.map((o) => o.key);
    const result = await submitTemplate(browserEnv, request(withIndex(goodSite(), (h) => h.replace("<span data-kw>", "<span>"))));
    expect(result).toMatchObject({ status: "rejected", template_version_id: null });
    const keyword = result.issues.filter((i) => i.rule === "keyword");
    expect(keyword.length).toBeGreaterThan(0);
    for (const issue of keyword) expect(issue).toEqual({ rule: "keyword", file: "index.html", message: expect.any(String), fix: expect.any(String) });
    expect(await versions()).toHaveLength(0);
    expect((await env.ARTIFACTS.list()).objects.map((o) => o.key)).toEqual(before);
  });

  it("accepts a similarity-only template with a persisted warning naming the brand", async () => {
    await addBrand("b_lantern", "Lantern Finance", "lanternfinance.com");
    await addSealedTemplate({ id: "lantern", name: "Lantern", fingerprint: await computeFingerprint(goodSite()), brandId: "b_lantern" });
    const result = await submitTemplate(browserEnv, request());
    expect(result.status).toBe("awaiting_approval");
    expect(result.similarity?.pass).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.warnings.some((i) => i.rule === "similarity" && /Lantern Finance/.test(`${i.message} ${i.fix}`))).toBe(true);
    const stored = await env.FACTORY.prepare("SELECT details_json FROM certifications WHERE template_version_id = ?1 AND check_name = 'identity_scan'").bind(result.template_version_id).first<{ details_json: string }>();
    expect(JSON.parse(stored!.details_json).warning_issues).toEqual(result.warnings.filter((i) => i.rule === "similarity"));
    const again = await submitTemplate(browserEnv, request());
    expect(again.status).toBe("duplicate");
    expect(again.warnings).toEqual(result.warnings);
    expect(await versions()).toHaveLength(2);
  });

  it("does not compare a new version with the same template's own sealed versions", async () => {
    const fingerprint = JSON.stringify(await computeFingerprint(goodSite()));
    await env.FACTORY.batch([
      env.FACTORY.prepare("INSERT INTO templates (template_id, name, framework, created_by, created_at) VALUES ('harbor', 'Harbor', 'react_spa', 'u', ?1)").bind(NOW),
      env.FACTORY.prepare("INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at) VALUES ('tv_harbor_v1', 'harbor', 1, ?1, 'k', 'sealed', 'u', ?2, 'u', ?2)").bind("f".repeat(64), NOW),
      env.FACTORY.prepare("INSERT INTO template_fingerprints (template_version_id, fingerprint_json, created_at) VALUES ('tv_harbor_v1', ?1, ?2)").bind(fingerprint, NOW),
    ]);
    const result = await submitTemplate(browserEnv, request(withIndex(goodSite(), (h) => h.replace("Answer two", "Answer two short"))));
    expect(result).toMatchObject({ status: "awaiting_approval", template_version_id: "tv_harbor_v2", version: 2 });
  });

  it.each([
    { name: "foreign brand domain", rule: "brand", extra: "<p>lanternfinance.com</p>" },
    { name: "foreign brand id", rule: "brand", extra: '<script>const brand = "b_lantern";</script>' },
    { name: "foreign brand name", rule: "brand", extra: "<p>Lantern Finance</p>" },
    { name: "anjuna bytes", rule: "brand", extra: "<!-- Anjuna -->" },
    { name: "aurum bytes", rule: "brand", extra: "<!-- AURUM -->" },
    { name: "PostHog key", rule: "brand", extra: '<script>const key = "phc_testKey123";</script>' },
    { name: "Sentry DSN", rule: "brand", extra: '<script>const dsn = "https://key@o1.ingest.sentry.io/42";</script>' },
    { name: "external script", rule: "external-script", extra: '<script src="https://cdn.example/x.js"></script>' },
  ])("rejects $name alone", async ({ rule, extra }) => {
    await addBrand("b_lantern", "Lantern Finance", "lanternfinance.com");
    const result = await submitTemplate(browserEnv, request(withIndex(goodSite(), (h) => h + extra)));
    expect(result.status).toBe("rejected");
    expect([...new Set(result.issues.map((i) => i.rule))]).toEqual([rule]);
    expect(await versions()).toHaveLength(0);
  });

  it.each(["privacy", "terms", "disclosures", "do-not-sell"])("rejects a missing %s page alone", async (slug) => {
    const files = goodSite();
    files.delete(slug + "/index.html");
    const result = await submitTemplate(browserEnv, request(files));
    expect(result.status).toBe("rejected");
    expect([...new Set(result.issues.map((i) => i.rule))]).toEqual(["structure"]);
    expect(await versions()).toHaveLength(0);
  });

  it.each(["action", "requested_amount", "zip"])("rejects a broken CTA %s alone", async (field) => {
    const files = withIndex(goodSite(), (h) => field === "action" ? h.replace('action="/go"', 'action="/wrong"') : h.replaceAll('name="' + field + '"', 'name="missing"'));
    const result = await submitTemplate(browserEnv, request(files));
    expect(result.status).toBe("rejected");
    expect([...new Set(result.issues.map((i) => i.rule))]).toEqual(["cta"]);
    expect(await versions()).toHaveLength(0);
  });

  it("persists lint advisories separately from import notices and returns them on duplicate", async () => {
    const files = withIndex(goodSite(), (h) => h.replace(/<title>.*?<\/title>/, "") + '<input type="email" name="email"><img src="https://cdn.example/x.png"><a href="/missing/">Missing</a><p>Guaranteed approval</p>');
    const notice = { rule: "host-badge", message: "Removed the host badge.", fix: "Nothing to do." };
    const first = await submitTemplate(browserEnv, request(files, { warnings: [notice] }));
    expect(first.status).toBe("awaiting_approval");
    expect(first.issues).toEqual([]);
    expect(first.warnings.map((i) => i.rule)).toEqual(expect.arrayContaining(["meta", "pii", "external", "links", "guarantees", "host-badge"]));
    const row = await env.FACTORY.prepare("SELECT details_json FROM certifications WHERE template_version_id = ?1 AND check_name = 'lint'").bind(first.template_version_id).first<{ details_json: string }>();
    const details = JSON.parse(row!.details_json);
    expect(details.import_warnings).toEqual([notice]);
    expect(details.warning_issues.map((i: { rule: string }) => i.rule)).not.toContain("host-badge");
    const again = await submitTemplate(browserEnv, request(files));
    expect(again.status).toBe("duplicate");
    expect(again.warnings).toEqual(first.warnings);
  });

  it("rejects a template name owned by another template id", async () => {
    await env.FACTORY.prepare("INSERT INTO templates (template_id, name, framework, created_by, created_at) VALUES ('lantern', 'Harbor', 'astro', 'u', ?1)").bind(NOW).run();
    const result = await submitTemplate(browserEnv, request());
    expect(result).toMatchObject({ status: "rejected", template_version_id: null });
    expect(result.issues).toEqual([expect.objectContaining({ rule: "template-name", fix: expect.stringContaining('"lantern"') })]);
  });

  it("rejects an archive over the limits with 'reduce image sizes'", async () => {
    const result = await submitTemplate(browserEnv, request(withFile(goodSite(), "img/hero.png", new Uint8Array(11 * 1024 * 1024))));
    expect(result.status).toBe("rejected");
    expect(result.issues[0]).toMatchObject({ rule: "archive-limits" });
    expect(result.issues[0]!.fix).toMatch(/reduce image sizes/i);
  });

  it("stores screenshot failures as warnings and awaits owner approval", async () => {
    vi.mocked(takeScreenshot).mockRejectedValue(new Error("Browser Rendering quota exceeded"));
    const result = await submitTemplate(browserEnv, request());
    expect(result).toMatchObject({ status: "awaiting_approval", template_version_id: "tv_harbor_v1", issues: [] });
    expect(result.warnings.map((i) => i.rule)).toEqual(["screenshot_desktop", "screenshot_mobile"]);
    expect(result.warnings[0]!.fix).toMatch(/platform problem/);
    expect((await versions())[0]).toMatchObject({ status: "certified" });
    expect((await submitTemplate(browserEnv, request())).warnings).toEqual(result.warnings);
  });
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof InputError ? e.code : "other";
  }
  return "none";
};

describe("filesToMap", () => {
  it("decodes utf8 and base64 files and normalizes ./ and leading / paths", () => {
    const files = filesToMap([
      { path: "./index.html", content: "<h1>Hi</h1>" },
      { path: "/assets/logo.png", content: btoa("\x89PNG"), encoding: "base64" },
    ]);
    expect([...files.keys()]).toEqual(["index.html", "assets/logo.png"]);
    expect(new TextDecoder().decode(files.get("index.html"))).toBe("<h1>Hi</h1>");
    expect([...files.get("assets/logo.png")!]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("rejects zip-slip, duplicates, bad base64 and oversized files", () => {
    expect(code(() => filesToMap([{ path: "../evil.html", content: "x" }]))).toBe("zip_slip");
    expect(code(() => filesToMap([{ path: "a.html", content: "x" }, { path: "./a.html", content: "y" }]))).toBe("duplicate_entry");
    expect(code(() => filesToMap([{ path: "a.png", content: "%%%", encoding: "base64" }]))).toBe("bad_base64");
    expect(code(() => filesToMap([{ path: "big.txt", content: "x".repeat(10 * 1024 * 1024 + 1) }]))).toBe("file_too_large");
  });

  it("reports the payload size and the largest file", () => {
    const files = filesToMap([{ path: "a.html", content: "abc" }, { path: "b.css", content: "abcdef" }]);
    expect(payloadStats(files)).toEqual({ files: 2, bytes: 9, largest_file: { path: "b.css", bytes: 6 } });
  });
});

describe("chunked upload", () => {
  beforeAll(setupDb);
  beforeEach(async () => {
    await resetDb();
    await addKey();
  });
  const all = () => [...goodSite()].map(([path, bytes]) => ({ path, content: new TextDecoder().decode(bytes), encoding: "utf8" as const }));

  it("joins split files and batches into the same archive as one submit_template call", async () => {
    const files = all();
    const index = files.find((f) => f.path === "index.html")!;
    const id = await beginUpload(env, "bk_test", "harbor", "Harbor");
    expect(id).toMatch(/^up_[0-9a-f]{32}$/);
    const half = Math.floor(index.content.length / 2);
    await addUploadChunks(env, "bk_test", id, [{ path: "index.html", content: index.content.slice(0, half), part: 0 }]);
    const stored = await addUploadChunks(env, "bk_test", id, [{ path: "index.html", content: index.content.slice(half), part: 1 }, ...files.filter((f) => f !== index)]);
    expect(stored).toEqual({ chunks_stored: files.length + 1, files: files.length });
    const upload = await takeUpload(env, "bk_test", id);
    expect(upload).toMatchObject({ template_id: "harbor", template_name: "Harbor" });
    expect(assembleZip(filesToMap(upload.files))).toEqual(assembleZip(filesToMap(files)));
    await expect(takeUpload(env, "bk_test", id)).rejects.toMatchObject({ code: "unknown_upload" });
  });

  it("refuses an oversized call, another key's upload and a missing part", async () => {
    const id = await beginUpload(env, "bk_test", "harbor", "Harbor");
    await expect(addUploadChunks(env, "bk_test", id, [{ path: "a.html", content: "x".repeat(UPLOAD_CALL_MAX_CHARS + 1) }])).rejects.toMatchObject({ code: "batch_too_large" });
    await addKey("anj_mcp_second-key-0123456789abcd", "other", "bk_other");
    await expect(addUploadChunks(env, "bk_other", id, [{ path: "a.html", content: "x" }])).rejects.toMatchObject({ code: "unknown_upload" });
    await addUploadChunks(env, "bk_test", id, [{ path: "a.html", content: "x", part: 1 }]);
    await expect(takeUpload(env, "bk_test", id)).rejects.toMatchObject({ code: "missing_part" });
  });

  it("prunes uploads older than six hours", async () => {
    const old = await beginUpload(env, "bk_test", "harbor", "Harbor", Date.parse("2026-10-17T00:00:00Z"));
    await addUploadChunks(env, "bk_test", old, [{ path: "a.html", content: "x" }]);
    await beginUpload(env, "bk_test", "harbor", "Harbor", Date.parse("2026-10-17T07:00:00Z"));
    await expect(takeUpload(env, "bk_test", old)).rejects.toMatchObject({ code: "unknown_upload" });
    expect((await env.FACTORY.prepare("SELECT count(*) AS n FROM template_upload_chunks").first<{ n: number }>())!.n).toBe(0);
  });

  const stuff = (id: string, parts: number, size: number) =>
    env.FACTORY.batch(Array.from({ length: parts }, (_, part) =>
      env.FACTORY.prepare("INSERT INTO template_upload_chunks (upload_id, path, part, encoding, content) VALUES (?1, 'big.bin', ?2, 'utf8', substr(hex(zeroblob(?3)), 1, ?3))").bind(id, part, size)));

  const rows = async (id: string) => {
    const uploads = await env.FACTORY.prepare("SELECT count(*) AS n FROM template_uploads WHERE upload_id = ?1").bind(id).first<{ n: number }>();
    const chunks = await env.FACTORY.prepare("SELECT count(*) AS n FROM template_upload_chunks WHERE upload_id = ?1").bind(id).first<{ n: number }>();
    return uploads!.n + chunks!.n;
  };

  it("caps the characters per upload at upload and at finish, and deletes the oversized upload", async () => {
    expect(UPLOAD_MAX_CHARS).toBe(20_000_000);
    const parts = UPLOAD_MAX_CHARS / 1_000_000;
    const atUpload = await beginUpload(env, "bk_test", "harbor", "Harbor");
    await stuff(atUpload, parts, 1_000_000); // exactly UPLOAD_MAX_CHARS stored; one more character is over
    await expect(addUploadChunks(env, "bk_test", atUpload, [{ path: "a.html", content: "x" }])).rejects.toMatchObject({ code: "upload_too_large" });
    expect(await rows(atUpload)).toBe(0);
    const atFinish = await beginUpload(env, "bk_test", "harbor", "Harbor");
    await stuff(atFinish, parts + 1, 1_000_000);
    await expect(takeUpload(env, "bk_test", atFinish)).rejects.toMatchObject({ code: "upload_too_large" });
    expect(await rows(atFinish)).toBe(0);
  });

  it("caps the chunk count per upload and deletes the oversized upload", async () => {
    const id = await beginUpload(env, "bk_test", "harbor", "Harbor");
    await stuff(id, UPLOAD_MAX_CHUNKS, 1);
    await expect(addUploadChunks(env, "bk_test", id, [{ path: "a.html", content: "x" }])).rejects.toMatchObject({ code: "upload_too_large" });
    expect(await rows(id)).toBe(0);
  });

  it("frees the open upload slot of an upload rejected as too large", async () => {
    const ids = [];
    for (let i = 0; i < UPLOAD_MAX_OPEN_PER_KEY; i++) ids.push(await beginUpload(env, "bk_test", "harbor", "Harbor"));
    await expect(beginUpload(env, "bk_test", "harbor", "Harbor")).rejects.toMatchObject({ code: "too_many_uploads" });
    await stuff(ids[0]!, UPLOAD_MAX_CHUNKS, 1);
    await expect(addUploadChunks(env, "bk_test", ids[0]!, [{ path: "a.html", content: "x" }])).rejects.toMatchObject({ code: "upload_too_large" });
    await expect(beginUpload(env, "bk_test", "harbor", "Harbor")).resolves.toMatch(/^up_/);
  });

  it("caps the open uploads per key", async () => {
    for (let i = 0; i < UPLOAD_MAX_OPEN_PER_KEY; i++) await beginUpload(env, "bk_test", "harbor", "Harbor");
    await expect(beginUpload(env, "bk_test", "harbor", "Harbor")).rejects.toMatchObject({ code: "too_many_uploads" });
  });
});
