import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateThemeVarsResponse } from "@anjuna/contracts";
import { handleImportRequest } from "../src/import-service";
import { goodSite, serve, toZip } from "./fixtures";
import { NOW, resetDb, setupDb } from "./helpers";
import { DEMO14_CSS } from "./fixtures/demo14-css";

vi.mock("../src/screenshots", () => ({ takeScreenshot: vi.fn() }));
import { takeScreenshot } from "../src/screenshots";

const browserEnv = { ...env, BROWSER: {} as Fetcher };
const post = (body: unknown) => handleImportRequest(
  new Request("https://template-mcp/submit-url", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  browserEnv,
);

beforeAll(setupDb);
beforeEach(async () => {
  await resetDb();
  vi.mocked(takeScreenshot).mockReset().mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
});
afterEach(() => vi.unstubAllGlobals());

describe("TemplateImportService", () => {
  it("submits a published URL for a dashboard user and records them as submitter", async () => {
    serve(goodSite());
    const ok = await post({ url: "https://harbor.bolt.host/", template_id: "harbor", template_name: "Harbor", submitted_by: { key_id: null, label: "owner@example.test" }, created_by: "usr_1" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "awaiting_approval" });
    expect(await env.FACTORY.prepare("SELECT submitted_by_key_id, submitted_by_label, created_by FROM template_versions").first())
      .toEqual({ submitted_by_key_id: null, submitted_by_label: "owner@example.test", created_by: "usr_1" });
  });

  it("validates input and answers 404 for other paths", async () => {
    const insecure = await post({ url: "http://harbor.bolt.host/", template_id: "harbor", template_name: "Harbor", submitted_by: { key_id: null, label: "x" }, created_by: "u" });
    expect([insecure.status, ((await insecure.json()) as { error: string }).error]).toEqual([422, "bad_url"]);
    expect((await post({ template_id: "harbor" })).status).toBe(422);
    expect((await handleImportRequest(new Request("https://template-mcp/other"), browserEnv)).status).toBe(404);
  });
});

describe("POST /detect-theme-vars", () => {
  const detect = (body: unknown) => handleImportRequest(
    new Request("https://template-mcp/detect-theme-vars", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
    browserEnv,
  );
  const seed = async (css: string, r2Key = "templates/tv_detect.zip", putZip = true) => {
    const files = new Map([["index.html", new TextEncoder().encode("<!doctype html><html><body>x</body></html>")], ["assets/site.css", new TextEncoder().encode(css)]]);
    if (putZip) await env.ARTIFACTS.put(r2Key, toZip(files));
    await env.FACTORY.batch([
      env.FACTORY.prepare("INSERT INTO templates (template_id, name, framework, created_by, created_at) VALUES ('t_detect', 'Detect', 'astro', 'u', ?1)").bind(NOW),
      env.FACTORY.prepare("INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at) VALUES ('tv_detect', 't_detect', 1, ?1, ?2, 'sealed', 'u', ?3, 'u', ?3)").bind("d".repeat(64), r2Key, NOW),
    ]);
  };
  const versionRows = async () => (await env.FACTORY.prepare("SELECT * FROM template_versions").all()).results;

  it("detect-theme-vars returns the detector map for a stored zip", async () => {
    await seed(":root{--brand:#1f7a4d}.btn{background:var(--brand)}");
    const before = await versionRows();
    const response = await detect({ template_version_id: "tv_detect" });
    expect(response.status).toBe(200);
    expect(TemplateThemeVarsResponse.parse(await response.json())).toEqual({
      template_version_id: "tv_detect",
      theme_vars: { primary: ["--brand"], primary_dark: [], secondary: [] },
    });
    expect(await versionRows()).toEqual(before);
  });

  it("detect-theme-vars on demo14 CSS finds --color-royal", async () => {
    await seed(DEMO14_CSS);
    const body = TemplateThemeVarsResponse.parse(await (await detect({ template_version_id: "tv_detect" })).json());
    expect(body.theme_vars).toEqual({ primary: ["--color-royal"], primary_dark: ["--color-royal-dark"], secondary: [] });
  });

  it("detect-theme-vars answers 404 for an unknown version and 422 for a missing zip", async () => {
    const unknown = await detect({ template_version_id: "tv_nope" });
    expect([unknown.status, await unknown.json()]).toEqual([404, { error: "not_found" }]);
    await seed("", "templates/gone.zip", false);
    const missing = await detect({ template_version_id: "tv_detect" });
    expect([missing.status, await missing.json()]).toEqual([422, { error: "template_zip_missing" }]);
  });

  it("detect-theme-vars answers 422 with the code of an unreadable zip", async () => {
    await seed("");
    await env.ARTIFACTS.put("templates/tv_detect.zip", new Uint8Array([1, 2, 3, 4]));
    const response = await detect({ template_version_id: "tv_detect" });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: expect.any(String), message: expect.any(String) });
  });

  it("detect-theme-vars rejects a bad body with 422", async () => {
    for (const body of [{}, { template_version_id: "" }, { template_version_id: "x".repeat(129) }, { template_version_id: "tv_detect", extra: 1 }, "not json"]) {
      expect((await detect(body)).status).toBe(422);
    }
  });
});
