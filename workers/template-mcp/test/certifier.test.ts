import { LIMITS } from "../src/archive";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { certifyTemplateVersion, importTemplateVersion, sealTemplateVersion } from "../src/certifier";
import { goodSite, toZip, withFile, withIndex } from "./fixtures";
import { setupDb, resetDb, addBrand } from "./helpers";

beforeAll(setupDb);
vi.mock("../src/screenshots", () => ({ takeScreenshot: vi.fn() }));
import { takeScreenshot } from "../src/screenshots";
const browserEnv = { ...env, BROWSER: {} as Fetcher };
beforeEach(async () => {
  await resetDb();
  vi.mocked(takeScreenshot).mockReset().mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
});

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

// Exercise both entry points: certification must also reject archives stored by
// older importers, so replace a draft's object directly rather than re-import it.
const unsafeArchives = [
  { name: "11 MiB expanded file", code: "file_too_large", zip: () =>
    toZip(withFile(goodSite(), "large.txt", new Uint8Array(11 * 1024 * 1024))) },
  { name: "total expansion over 100 MiB", code: "too_large", zip: () => {
    const files = goodSite();
    const chunk = new Uint8Array(LIMITS.maxFileBytes);
    for (let i = 0; i < 11; i++) files.set(`chunk-${i}.txt`, chunk);
    return toZip(files);
  } },
  { name: "more than 2000 files", code: "too_many_files", zip: () => {
    const files = goodSite();
    for (let i = 0; i < LIMITS.maxFiles; i++) files.set(`file-${i}.txt`, new Uint8Array());
    return toZip(files);
  } },
  ...["../escape.html", "nested/../../escape.html", "/absolute.html", "C:/absolute.html"].map((path) => ({
    name: path, code: path.includes("..") ? "zip_slip" : "unsafe_path",
    zip: () => toZip(withFile(goodSite(), path, "unsafe")),
  })),
];

describe("pipeline archive validation", () => {
  it.each(unsafeArchives)("import rejects $name before writing", async ({ zip, code }) => {
    const before = (await env.ARTIFACTS.list()).objects.map((obj) => obj.key);
    const auditBefore = (await env.FACTORY.prepare("SELECT * FROM audit_log").all()).results;
    await expect(seedTemplateVersion(zip())).rejects.toMatchObject({ code });
    expect((await env.FACTORY.prepare("SELECT * FROM templates").all()).results).toHaveLength(0);
    expect((await env.FACTORY.prepare("SELECT * FROM template_versions").all()).results).toHaveLength(0);
    expect((await env.FACTORY.prepare("SELECT * FROM audit_log").all()).results).toEqual(auditBefore);
    expect((await env.ARTIFACTS.list()).objects.map((obj) => obj.key)).toEqual(before);
  });

  it.each(unsafeArchives)("certify rejects stored $name before rendering", async ({ zip, code }) => {
    const id = await seedTemplateVersion();
    const row = await env.FACTORY.prepare("SELECT r2_key FROM template_versions WHERE template_version_id = ?")
      .bind(id).first<{ r2_key: string }>();
    await env.ARTIFACTS.put(row!.r2_key, zip());
    await expect(certifyTemplateVersion(browserEnv, id)).rejects.toMatchObject({ code });
    expect(takeScreenshot).not.toHaveBeenCalled();
    expect((await env.FACTORY.prepare("SELECT * FROM certifications").all()).results).toHaveLength(0);
    expect((await env.FACTORY.prepare("SELECT status FROM template_versions WHERE template_version_id = ?")
      .bind(id).first())?.status).toBe("draft");
  });
});

describe("certifyTemplateVersion — T5 starters", () => {
  it("good template (goodSite) passes lint and identity scan → certified", async () => {
    const tvId = await seedTemplateVersion(goodZip());
    const result = await certifyTemplateVersion(browserEnv, tvId);
    const lintCheck = result.checks.find((c) => c.check_name === "lint");
    const idCheck = result.checks.find((c) => c.check_name === "identity_scan");
    expect(lintCheck?.result).toBe("pass");
    expect(idCheck?.result).toBe("pass");
    expect(result.status).toBe("certified");
    expect(result.repair_messages).toHaveLength(0);
  });

  it("writes certification rows to D1", async () => {
    const tvId = await seedTemplateVersion(goodZip());
    await certifyTemplateVersion(browserEnv, tvId);
    const rows = await env.FACTORY.prepare("SELECT check_name, result FROM certifications WHERE template_version_id = ?").bind(tvId).all<{ check_name: string; result: string }>();
    expect(rows.results).toHaveLength(4);
  });

  it("stores fingerprint in template_fingerprints", async () => {
    const tvId = await seedTemplateVersion(goodZip());
    await certifyTemplateVersion(browserEnv, tvId);
    const fp = await env.FACTORY.prepare("SELECT fingerprint_json FROM template_fingerprints WHERE template_version_id = ?").bind(tvId).first<{ fingerprint_json: string }>();
    expect(fp).toBeTruthy();
    const parsed = JSON.parse(fp!.fingerprint_json);
    expect(parsed).toHaveProperty("v", 1);
  });
});

describe("certifyTemplateVersion — rejection", () => {
  it("template with external script → rejected with repair message", async () => {
    const tvId = await seedTemplateVersion(withExternalScript());
    const result = await certifyTemplateVersion(browserEnv, tvId);
    const lintCheck = result.checks.find((c) => c.check_name === "lint");
    expect(lintCheck?.result).toBe("fail");
    expect(result.status).toBe("rejected");
    expect(result.repair_messages.length).toBeGreaterThan(0);
    expect(result.repair_messages.some((m) => m.includes("external") || m.includes("script"))).toBe(true);
  });

  it("template with missing KeywordSlot → rejected with repair message", async () => {
    const tvId = await seedTemplateVersion(noKeywordSlot());
    const result = await certifyTemplateVersion(browserEnv, tvId);
    const lintCheck = result.checks.find((c) => c.check_name === "lint");
    expect(lintCheck?.result).toBe("fail");
    expect(result.status).toBe("rejected");
    expect(result.repair_messages.some((m) => /keyword|kw|h1/i.test(m))).toBe(true);
  });

  it("sets status to rejected in D1 on failure", async () => {
    const tvId = await seedTemplateVersion(withExternalScript());
    await certifyTemplateVersion(browserEnv, tvId);
    const tv = await env.FACTORY.prepare("SELECT status FROM template_versions WHERE template_version_id = ?").bind(tvId).first<{ status: string }>();
    expect(tv?.status).toBe("rejected");
  });
});

describe("sealTemplateVersion", () => {
  it("seals a certified version", async () => {
    const tvId = await seedTemplateVersion(goodZip(), "seal1");
    await certifyTemplateVersion(browserEnv, tvId);
    const result = await sealTemplateVersion(env.FACTORY, env.ARTIFACTS, "test-owner-secret", env.OWNER_SECRET, tvId, "owner-user");
    expect(result.sealed_by).toBe("owner-user");
    const tv = await env.FACTORY.prepare("SELECT status, sealed_by, sealed_at FROM template_versions WHERE template_version_id = ?").bind(tvId).first<{ status: string; sealed_by: string; sealed_at: string }>();
    expect(tv?.status).toBe("sealed");
    expect(tv?.sealed_by).toBe("owner-user");
    expect(tv?.sealed_at).toBeTruthy();
  });

  it("rejects wrong owner secret", async () => {
    const tvId = await seedTemplateVersion(goodZip(), "seal2");
    await certifyTemplateVersion(browserEnv, tvId);
    await expect(
      sealTemplateVersion(env.FACTORY, env.ARTIFACTS, "wrong-secret", env.OWNER_SECRET, tvId, "owner-user"),
    ).rejects.toThrow("Invalid owner secret");
  });

  it("rejects sealing a draft (not yet certified)", async () => {
    const tvId = await seedTemplateVersion(goodZip(), "seal3");
    await expect(
      sealTemplateVersion(env.FACTORY, env.ARTIFACTS, "test-owner-secret", env.OWNER_SECRET, tvId, "owner-user"),
    ).rejects.toThrow("certified");
  });

  it("rejects sealing a rejected version", async () => {
    const tvId = await seedTemplateVersion(withExternalScript(), "seal4");
    await certifyTemplateVersion(browserEnv, tvId);
    await expect(
      sealTemplateVersion(env.FACTORY, env.ARTIFACTS, "test-owner-secret", env.OWNER_SECRET, tvId, "owner-user"),
    ).rejects.toThrow("certified");
  });
});


describe("certification evidence and audit regressions", () => {
  const seal = (id: string) => sealTemplateVersion(env.FACTORY, env.ARTIFACTS, "test-owner-secret", env.OWNER_SECRET, id, "owner-user");

  it("rejects another registered brand domain with repair text", async () => {
    await addBrand("competitor", "Competitor", "competitor.example");
    const id = await seedTemplateVersion(toZip(goodSite({ extraBody: "<p>competitor.example</p>" })));
    const result = await certifyTemplateVersion(browserEnv, id);
    expect(result.status).toBe("rejected");
    expect(result.repair_messages.join(" ")).toContain("competitor.example");
    await expect(seal(id)).rejects.toThrow("certified");
  });

  it("excludes the specified brand's own domain", async () => {
    await addBrand("own", "Own", "own.example");
    const id = await seedTemplateVersion(toZip(goodSite({ extraBody: "<p>own.example</p>" })));
    expect((await certifyTemplateVersion(browserEnv, id, "own")).status).toBe("certified");
  });

  it("rejects without BROWSER and reports both missing screenshots", async () => {
    const id = await seedTemplateVersion();
    const result = await certifyTemplateVersion(env, id);
    expect(result.status).toBe("rejected");
    expect(result.checks.filter((c) => c.result === "fail").map((c) => c.check_name)).toEqual(["screenshot_desktop", "screenshot_mobile"]);
    expect(result.repair_messages.join(" ")).toContain("Bind BROWSER");
    expect(takeScreenshot).not.toHaveBeenCalled();
    await expect(seal(id)).rejects.toThrow("certified");
  });

  it("persists both viewport artifacts before certification", async () => {
    const id = await seedTemplateVersion();
    const result = await certifyTemplateVersion(browserEnv, id);
    expect(vi.mocked(takeScreenshot).mock.calls.map((c) => c.slice(2))).toEqual([[1280, 800], [390, 844]]);
    for (const check of result.checks.filter((c) => c.check_name.startsWith("screenshot"))) {
      expect(check.result).toBe("pass");
      expect((await env.ARTIFACTS.head(check.artifact_r2_key!))?.size).toBeGreaterThan(0);
    }
  });

  it("rejects a failed mobile capture even after an earlier successful run", async () => {
    const id = await seedTemplateVersion();
    await certifyTemplateVersion(browserEnv, id);
    vi.mocked(takeScreenshot).mockResolvedValueOnce(new Uint8Array([1])).mockRejectedValueOnce(new Error("mobile capture failed"));
    const result = await certifyTemplateVersion(browserEnv, id);
    expect(result.status).toBe("rejected");
    expect(result.repair_messages.join(" ")).toContain("mobile capture failed");
    // Even a legacy/stale certified status must not let old passing evidence through.
    await env.FACTORY.prepare("UPDATE template_versions SET status = 'certified' WHERE template_version_id = ?").bind(id).run();
    await expect(seal(id)).rejects.toThrow("screenshot_mobile");
  });

  it("rejects empty screenshots", async () => {
    const id = await seedTemplateVersion();
    vi.mocked(takeScreenshot).mockResolvedValue(new Uint8Array());
    expect((await certifyTemplateVersion(browserEnv, id)).status).toBe("rejected");
  });

  it.each(["screenshot_desktop", "screenshot_mobile"])("blocks seal without %s check or artifact", async (name) => {
    const id = await seedTemplateVersion();
    const result = await certifyTemplateVersion(browserEnv, id);
    const key = result.checks.find((c) => c.check_name === name)!.artifact_r2_key!;
    await env.ARTIFACTS.delete(key);
    await expect(seal(id)).rejects.toThrow("Missing PNG");
    await env.FACTORY.prepare("DELETE FROM certifications WHERE template_version_id = ? AND check_name = ?").bind(id, name).run();
    await expect(seal(id)).rejects.toThrow(name);
  });

  it("audits import, certify, and owner seal without secrets", async () => {
    const id = await seedTemplateVersion(goodZip(), "audited");
    await certifyTemplateVersion(browserEnv, id);
    await seal(id);
    const { results } = await env.FACTORY.prepare("SELECT * FROM audit_log WHERE entity_id = ? ORDER BY id").bind(id).all();
    expect(results.map((r) => r.action)).toEqual(["template.import", "template.certify", "template.seal"]);
    expect(results[0]?.actor_id).toBe("test-user");
    expect(results[2]?.actor_id).toBe("owner-user");
    expect(results[2]?.actor_role).toBe("owner");
    expect(JSON.stringify(results)).not.toContain("test-owner-secret");
  });

  it("rolls back seal when its audit insertion fails", async () => {
    const id = await seedTemplateVersion(goodZip(), "rollback");
    await certifyTemplateVersion(browserEnv, id);
    await env.FACTORY.exec("CREATE TRIGGER fail_seal_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'template.seal' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;");
    try {
      await expect(seal(id)).rejects.toThrow("audit unavailable");
      const row = await env.FACTORY.prepare("SELECT status, sealed_by, sealed_at FROM template_versions WHERE template_version_id = ?").bind(id).first();
      expect(row).toEqual({ status: "certified", sealed_by: null, sealed_at: null });
      expect((await env.FACTORY.prepare("SELECT id FROM audit_log WHERE entity_id = ? AND action = 'template.seal'").bind(id).all()).results).toHaveLength(0);
    } finally {
      await env.FACTORY.exec("DROP TRIGGER fail_seal_audit;");
    }
  });
});
