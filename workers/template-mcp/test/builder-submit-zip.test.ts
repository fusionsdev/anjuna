import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { zipSync, strToU8 } from "fflate";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateSubmitResult } from "@anjuna/contracts";
import worker from "../src/index";
import { goodSite, toZip } from "./fixtures";
import { KEY, addKey, resetDb, setupDb } from "./helpers";

vi.mock("../src/screenshots", () => ({ takeScreenshot: vi.fn() }));
import { takeScreenshot } from "../src/screenshots";

const browserEnv = { ...env, BROWSER: {} as Fetcher };
const SUBMIT_URL = "https://mcp.example.test/submit-zip";

async function send(request: Request, testEnv: typeof browserEnv = browserEnv): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const post = (zip: Uint8Array, fields: Record<string, string> = {}, headers: Record<string, string> = { authorization: `Bearer ${KEY}` }, testEnv = browserEnv) => {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(zip)]), "site.zip");
  for (const [key, value] of Object.entries({ template_id: "harbor", template_name: "Harbor", ...fields })) form.set(key, value);
  return send(new Request(SUBMIT_URL, { method: "POST", body: form, headers }), testEnv);
};

const versionCount = async () => (await env.FACTORY.prepare("SELECT COUNT(*) AS count FROM template_versions").first<{ count: number }>())!.count;

beforeAll(setupDb);
beforeEach(async () => {
  await resetDb();
  await addKey();
  vi.mocked(takeScreenshot).mockReset().mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
});

describe("public POST /submit-zip with a builder key", () => {
  it("answers 401 without a key or with an unknown key and stores nothing", async () => {
    for (const [headers, error] of [
      [{}, "missing_or_malformed_api_key"],
      [{ authorization: "Bearer anj_mcp_not-a-real-key-0000000" }, "invalid_api_key"],
    ] as const) {
      const response = await post(toZip(goodSite()), {}, headers);
      expect([response.status, await response.json()]).toEqual([401, { error }]);
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
    }
    expect(await versionCount()).toBe(0);
    expect(takeScreenshot).not.toHaveBeenCalled();
  });

  it("answers 401 for a revoked key", async () => {
    await env.FACTORY.prepare("UPDATE builder_keys SET revoked_at = '2026-10-02T01:00:00.000Z' WHERE key_id = 'bk_test'").run();
    const response = await post(toZip(goodSite()));
    expect([response.status, await response.json()]).toEqual([401, { error: "invalid_api_key" }]);
    expect(await versionCount()).toBe(0);
  });

  it("answers 429 once the key passes its per-minute limit and stores nothing more", async () => {
    // A fixed clock keeps both requests in one rate-limit window.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T00:00:10.000Z"));
    try {
      const limited = { ...browserEnv, RATE_LIMIT_PER_MINUTE: "1" };
      expect((await post(toZip(goodSite()), {}, undefined, limited)).status).toBe(200);
      const response = await post(toZip(goodSite()), { template_id: "harbor-two" }, undefined, limited);
      expect([response.status, await response.json()]).toEqual([429, { error: "rate_limited" }]);
      expect(response.headers.get("retry-after")).toBe("50");
      expect(await versionCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers 405 for GET", async () => {
    const response = await send(new Request(SUBMIT_URL, { headers: { authorization: `Bearer ${KEY}` } }));
    expect([response.status, await response.json()]).toEqual([405, { error: "method_not_allowed" }]);
  });

  it("submits the ZIP as the builder key and leaves approval to the owner", async () => {
    const response = await post(toZip(goodSite()), { submitted_by: JSON.stringify({ key_id: null, label: "spoofed" }), created_by: "usr_spoofed" });
    expect(response.status).toBe(200);
    expect(TemplateSubmitResult.parse(await response.json())).toMatchObject({ status: "awaiting_approval", template_version_id: "tv_harbor_v1" });
    expect(await env.FACTORY.prepare("SELECT status, submitted_by_key_id, submitted_by_label, created_by FROM template_versions").first())
      .toEqual({ status: "certified", submitted_by_key_id: "bk_test", submitted_by_label: "test builder", created_by: "bk_test" });
  });

  it("accepts the key from X-API-Key", async () => {
    expect((await post(toZip(goodSite()), {}, { "x-api-key": KEY })).status).toBe(200);
  });

  it("answers 422 for a bad template_id", async () => {
    const response = await post(toZip(goodSite()), { template_id: "../bad" });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid", issues: [expect.objectContaining({ path: "template_id" })] });
  });

  it("answers 422 for a body that is not multipart", async () => {
    const response = await send(new Request(SUBMIT_URL, {
      method: "POST", body: JSON.stringify({ template_id: "harbor" }), headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    }));
    expect([response.status, await response.json()]).toEqual([422, { error: "invalid", message: "Expected multipart/form-data" }]);
  });

  it("answers 422 needs_build for a source project ZIP", async () => {
    const response = await post(zipSync({ "package.json": strToU8("{}"), "src/main.tsx": strToU8("source") }));
    expect([response.status, await response.json()]).toEqual([422, { error: "needs_build", message: "Upload the built dist folder" }]);
    expect(await versionCount()).toBe(0);
  });
});
