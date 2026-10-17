import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleImportRequest } from "../src/import-service";
import { goodSite, serve } from "./fixtures";
import { resetDb, setupDb } from "./helpers";

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
