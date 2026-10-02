import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { certifyTemplateVersion, importTemplateVersion, sealTemplateVersion } from "../src/certifier";
import { goodSite, toZip, withFile, withIndex } from "./fixtures";
import { setupDb, resetDb } from "./helpers";

beforeAll(setupDb);
beforeEach(resetDb);

const enc = (s: string) => new TextEncoder().encode(s);

const goodZip = () => toZip(goodSite());

/** Drop the data-kw attribute from H1 so KeywordSlot check fails. */
const noKeywordSlot = () =>
  toZip(withIndex(goodSite(), (html) => html.replace(/<span data-kw>/g, "<span>")));

/** Add an external script tag. */
const withExternalScript = () =>
  toZip(withIndex(goodSite(), (html) => html.replace("</head>", '<script src="https://evil.example/track.js"></script></head>')));

async function seedTemplateVersion(zip = goodZip(), id = "t1"): Promise<string> {
  const result = await importTemplateVersion(env.FACTORY, env.ARTIFACTS, zip, {
    template_id: id,
    template_name: `Template ${id}`,
    framework: "astro",
    created_by: "test-user",
  });
  return result.template_version_id;
}

describe("importTemplateVersion", () => {
  it("creates template and template_version rows", async () => {
    const tvId = await seedTemplateVersion(goodZip(), "harbor");
    const tv = await env.FACTORY.prepare("SELECT * FROM template_versions WHERE template_version_id = ?").bind(tvId).first<Record<string, unknown>>();
    expect(tv).toBeTruthy();
    expect(tv!.status).toBe("draft");
    expect(tv!.template_id).toBe("harbor");
    expect(typeof tv!.sha256).toBe("string");
    expect((tv!.sha256 as string).length).toBe(64);
  });

  it("increments version on second import for same template_id", async () => {
    await seedTemplateVersion(goodZip(), "multi");
    // Slightly different ZIP so SHA-256 differs (UNIQUE constraint on sha256).
    const v2Zip = toZip(withIndex(goodSite(), (html) => html.replace("</title>", " v2</title>")));
    const tvId2 = await seedTemplateVersion(v2Zip, "multi");
    const tv = await env.FACTORY.prepare("SELECT version FROM template_versions WHERE template_version_id = ?").bind(tvId2).first<{ version: number }>();
    expect(tv?.version).toBe(2);
  });

  it("stores ZIP in R2 at templates/{template_id}/{sha256}.zip", async () => {
    const tvId = await seedTemplateVersion(goodZip(), "r2test");
    const tv = await env.FACTORY.prepare("SELECT r2_key FROM template_versions WHERE template_version_id = ?").bind(tvId).first<{ r2_key: string }>();
    const obj = await env.ARTIFACTS.get(tv!.r2_key);
    expect(obj).not.toBeNull();
  });

  it("rejects a ZIP exceeding 30 MB", async () => {
    const bigZip = new Uint8Array(31 * 1024 * 1024);
    await expect(
      importTemplateVersion(env.FACTORY, env.ARTIFACTS, bigZip, { template_id: "big", template_name: "Big", framework: "astro", created_by: "u" }),
    ).rejects.toThrow();
  });
});

describe("certifyTemplateVersion — T5 starters", () => {
  it("good template (goodSite) passes lint and identity scan → certified", async () => {
    const tvId = await seedTemplateVersion(goodZip());
    const result = await certifyTemplateVersion(env, tvId);
    const lintCheck = result.checks.find((c) => c.check_name === "lint");
    const idCheck = result.checks.find((c) => c.check_name === "identity_scan");
    expect(lintCheck?.result).toBe("pass");
    expect(idCheck?.result).toBe("pass");
    expect(result.status).toBe("certified");
    expect(result.repair_messages).toHaveLength(0);
  });

  it("writes certification rows to D1", async () => {
    const tvId = await seedTemplateVersion(goodZip());
    await certifyTemplateVersion(env, tvId);
    const rows = await env.FACTORY.prepare("SELECT check_name, result FROM certifications WHERE template_version_id = ?").bind(tvId).all<{ check_name: string; result: string }>();
    expect(rows.results.length).toBeGreaterThanOrEqual(2);
  });

  it("stores fingerprint in template_fingerprints", async () => {
    const tvId = await seedTemplateVersion(goodZip());
    await certifyTemplateVersion(env, tvId);
    const fp = await env.FACTORY.prepare("SELECT fingerprint_json FROM template_fingerprints WHERE template_version_id = ?").bind(tvId).first<{ fingerprint_json: string }>();
    expect(fp).toBeTruthy();
    const parsed = JSON.parse(fp!.fingerprint_json);
    expect(parsed).toHaveProperty("v", 1);
  });
});

describe("certifyTemplateVersion — rejection", () => {
  it("template with external script → rejected with repair message", async () => {
    const tvId = await seedTemplateVersion(withExternalScript());
    const result = await certifyTemplateVersion(env, tvId);
    const lintCheck = result.checks.find((c) => c.check_name === "lint");
    expect(lintCheck?.result).toBe("fail");
    expect(result.status).toBe("rejected");
    expect(result.repair_messages.length).toBeGreaterThan(0);
    expect(result.repair_messages.some((m) => m.includes("external") || m.includes("script"))).toBe(true);
  });

  it("template with missing KeywordSlot → rejected with repair message", async () => {
    const tvId = await seedTemplateVersion(noKeywordSlot());
    const result = await certifyTemplateVersion(env, tvId);
    const lintCheck = result.checks.find((c) => c.check_name === "lint");
    expect(lintCheck?.result).toBe("fail");
    expect(result.status).toBe("rejected");
    expect(result.repair_messages.some((m) => /keyword|kw|h1/i.test(m))).toBe(true);
  });

  it("sets status to rejected in D1 on failure", async () => {
    const tvId = await seedTemplateVersion(withExternalScript());
    await certifyTemplateVersion(env, tvId);
    const tv = await env.FACTORY.prepare("SELECT status FROM template_versions WHERE template_version_id = ?").bind(tvId).first<{ status: string }>();
    expect(tv?.status).toBe("rejected");
  });
});

describe("sealTemplateVersion", () => {
  it("seals a certified version", async () => {
    const tvId = await seedTemplateVersion(goodZip(), "seal1");
    await certifyTemplateVersion(env, tvId);
    const result = await sealTemplateVersion(env.FACTORY, "test-owner-secret", env.OWNER_SECRET, tvId, "owner-user");
    expect(result.sealed_by).toBe("owner-user");
    const tv = await env.FACTORY.prepare("SELECT status, sealed_by, sealed_at FROM template_versions WHERE template_version_id = ?").bind(tvId).first<{ status: string; sealed_by: string; sealed_at: string }>();
    expect(tv?.status).toBe("sealed");
    expect(tv?.sealed_by).toBe("owner-user");
    expect(tv?.sealed_at).toBeTruthy();
  });

  it("rejects wrong owner secret", async () => {
    const tvId = await seedTemplateVersion(goodZip(), "seal2");
    await certifyTemplateVersion(env, tvId);
    await expect(
      sealTemplateVersion(env.FACTORY, "wrong-secret", env.OWNER_SECRET, tvId, "owner-user"),
    ).rejects.toThrow("Invalid owner secret");
  });

  it("rejects sealing a draft (not yet certified)", async () => {
    const tvId = await seedTemplateVersion(goodZip(), "seal3");
    await expect(
      sealTemplateVersion(env.FACTORY, "test-owner-secret", env.OWNER_SECRET, tvId, "owner-user"),
    ).rejects.toThrow("certified");
  });

  it("rejects sealing a rejected version", async () => {
    const tvId = await seedTemplateVersion(withExternalScript(), "seal4");
    await certifyTemplateVersion(env, tvId);
    await expect(
      sealTemplateVersion(env.FACTORY, "test-owner-secret", env.OWNER_SECRET, tvId, "owner-user"),
    ).rejects.toThrow("certified");
  });
});
