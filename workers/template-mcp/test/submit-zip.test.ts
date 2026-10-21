import { env } from "cloudflare:workers";
import { zipSync, strToU8 } from "fflate";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateSubmitResult } from "@anjuna/contracts";
import { LIMITS } from "../src/archive";
import { handleImportRequest } from "../src/import-service";
import { goodSite, toZip, withIndex } from "./fixtures";
import { resetDb, setupDb } from "./helpers";

vi.mock("../src/screenshots", () => ({ takeScreenshot: vi.fn() }));
import { takeScreenshot } from "../src/screenshots";

const browserEnv = { ...env, BROWSER: {} as Fetcher };
const post = (zip: Uint8Array, fields: Record<string, string> = {}) => {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(zip)]), "site.zip");
  for (const [key, value] of Object.entries({ template_id: "harbor", template_name: "Harbor", submitted_by: JSON.stringify({ key_id: null, label: "owner@example.test" }), created_by: "usr_1", ...fields })) form.set(key, value);
  return handleImportRequest(new Request("https://template-mcp/submit-zip", { method: "POST", body: form }), browserEnv);
};

beforeAll(setupDb);
beforeEach(async () => {
  await resetDb();
  vi.mocked(takeScreenshot).mockReset().mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
});

describe("POST /submit-zip", () => {
  it.each([false, true])("uses the shared certification pipeline and leaves approval to the owner (dist wrapper: %s)", async (wrapped) => {
    const files = wrapped ? new Map([...goodSite()].map(([path, bytes]) => [`dist/${path}`, bytes])) : goodSite();
    const response = await post(toZip(files));
    expect(response.status).toBe(200);
    expect(TemplateSubmitResult.parse(await response.json())).toMatchObject({ status: "awaiting_approval", template_version_id: "tv_harbor_v1" });
    expect(await env.FACTORY.prepare("SELECT status, submitted_by_key_id, submitted_by_label, created_by, sealed_at FROM template_versions").first())
      .toEqual({ status: "certified", submitted_by_key_id: null, submitted_by_label: "owner@example.test", created_by: "usr_1", sealed_at: null });
    expect(takeScreenshot).toHaveBeenCalledTimes(2);
  });

  it("unwraps dist and returns duplicate for identical content", async () => {
    const first = TemplateSubmitResult.parse(await (await post(toZip(goodSite()))).json());
    const wrapped = new Map([...goodSite()].map(([path, bytes]) => [`dist/${path}`, bytes]));
    const second = TemplateSubmitResult.parse(await (await post(toZip(wrapped))).json());
    expect(second).toMatchObject({ status: "duplicate", template_version_id: first.template_version_id, sha256: first.sha256 });
    expect(await env.FACTORY.prepare("SELECT COUNT(*) AS count FROM template_versions").first()).toEqual({ count: 1 });
  });

  it("returns the shared rejection result for a contract failure", async () => {
    const response = await post(toZip(withIndex(goodSite(), (html) => html.replace("<span data-kw>", "<span>"))));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "rejected", template_version_id: null, issues: expect.arrayContaining([expect.objectContaining({ rule: "keyword" })]) });
  });

  it("answers 422 for bad fields, source projects and invalid ZIP data", async () => {
    expect((await post(toZip(goodSite()), { template_id: "../bad" })).status).toBe(422);
    expect((await post(toZip(goodSite()), { submitted_by: "invalid JSON" })).status).toBe(422);
    expect((await post(strToU8("invalid archive"))).status).toBe(422);
    const source = await post(zipSync({ "package.json": strToU8("{}"), "src/main.tsx": strToU8("source") }));
    expect([source.status, await source.json()]).toEqual([422, { error: "needs_build", message: "Upload the built dist folder" }]);
  });

  it.each(["../evil.html", "/absolute.html", "C:/absolute.html", "dir\\evil.html"])("rejects unsafe path %s before storage", async (path) => {
    const response = await post(zipSync({ [path]: strToU8("x") }));
    expect(response.status).toBe(422);
    expect(await env.FACTORY.prepare("SELECT COUNT(*) AS count FROM template_versions").first()).toEqual({ count: 0 });
  });

  it("rejects symlinks even outside the selected dist folder", async () => {
    const response = await post(zipSync({ "dist/index.html": strToU8("<h1>Hi</h1>"), link: [strToU8("target"), { os: 3, attrs: (0o120777 << 16) >>> 0 }] }));
    expect([response.status, await response.json()]).toEqual([422, expect.objectContaining({ error: "symlink" })]);
  });

  it("rejects oversized archives, expanded files, total expansion and file counts", async () => {
    const oversized = new Request("https://template-mcp/submit-zip", {
      method: "POST", body: "x", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(LIMITS.maxArchiveBytes + 20_000) },
    });
    expect((await handleImportRequest(oversized, browserEnv)).status).toBe(422);
    expect((await post(zipSync({ "big.js": new Uint8Array(LIMITS.maxFileBytes + 1) }))).status).toBe(422);
    const many = Object.fromEntries(Array.from({ length: LIMITS.maxFiles + 1 }, (_, i) => [`${i}.txt`, strToU8("x")]));
    expect((await post(zipSync(many))).status).toBe(422);
    const expanded = zipSync(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`${i}.bin`, strToU8("x")])));
    const view = new DataView(expanded.buffer, expanded.byteOffset, expanded.byteLength);
    // Oversized declared expansion must be rejected before allocating the inflated bytes.
    for (let p = 0; p + 46 <= expanded.length; p++) {
      if (view.getUint32(p, true) === 0x02014b50) view.setUint32(p + 24, LIMITS.maxFileBytes, true);
    }
    const response = await post(expanded);
    expect([response.status, await response.json()]).toEqual([422, expect.objectContaining({ error: "too_large" })]);
  });
});
