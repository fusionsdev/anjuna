import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { getReceipt, saveReceipt, withReceipt } from "../src/receipt";

beforeAll(async () => {
  await applyD1Migrations(env.FACTORY, env.MIGRATIONS);
});

const NOW = "2026-10-03T00:00:00.000Z";

/** Create the minimum rows needed for install_receipts FK constraints. */
async function seedInstall(installId: string, brandId = `brand-${installId}`): Promise<void> {
  await env.FACTORY.prepare(
    "INSERT OR IGNORE INTO brands (brand_id, name, account, domain, status, created_by, created_at, updated_at) VALUES (?, ?, 'test', ?, 'draft', 'test', ?, ?)",
  ).bind(brandId, brandId, `${brandId}.test`, NOW, NOW).run();
  await env.FACTORY.prepare(
    "INSERT OR IGNORE INTO installs (install_id, brand_id, kind, status, started_by, started_at) VALUES (?, ?, 'install', 'queued', 'test', ?)",
  ).bind(installId, brandId, NOW).run();
}

function uniq(): string {
  return crypto.randomUUID().slice(0, 8);
}

describe("getReceipt / saveReceipt", () => {
  it("returns null when no receipt exists", async () => {
    const id = `i-${uniq()}`;
    await seedInstall(id);
    expect(await getReceipt(env.FACTORY, id, "validate")).toBeNull();
  });

  it("round-trips status and output_json", async () => {
    const id = `i-${uniq()}`;
    await seedInstall(id);
    await saveReceipt(env.FACTORY, id, "validate", "ok", { zone_id: "abc123", domain: "harbor.test" });
    const r = await getReceipt(env.FACTORY, id, "validate");
    expect(r?.status).toBe("ok");
    expect(r?.output).toMatchObject({ zone_id: "abc123", domain: "harbor.test" });
  });

  it("second saveReceipt on same (install, step) throws UNIQUE constraint", async () => {
    const id = `i-${uniq()}`;
    await seedInstall(id);
    await saveReceipt(env.FACTORY, id, "validate", "ok", {});
    await expect(saveReceipt(env.FACTORY, id, "validate", "ok", {})).rejects.toThrow();
  });
});

describe("withReceipt idempotency", () => {
  it("runs work and returns result on first call", async () => {
    const id = `i-${uniq()}`;
    await seedInstall(id);
    let calls = 0;
    const r = await withReceipt(env.FACTORY, id, "render", async () => { calls++; return { key: "renders/x/y.zip" }; });
    expect(calls).toBe(1);
    expect(r).toMatchObject({ key: "renders/x/y.zip" });
  });

  it("skips work on second call when ok receipt exists", async () => {
    const id = `i-${uniq()}`;
    await seedInstall(id);
    let calls = 0;
    const work = async () => { calls++; return { result: "done" }; };
    await withReceipt(env.FACTORY, id, "render", work);
    const r2 = await withReceipt(env.FACTORY, id, "render", work);
    expect(calls).toBe(1);
    expect(r2).toMatchObject({ result: "done" });
  });

  it("saves failed receipt and re-throws on work error", async () => {
    const id = `i-${uniq()}`;
    await seedInstall(id);
    await expect(
      withReceipt(env.FACTORY, id, "validate", async () => { throw new Error("zone unavailable"); }),
    ).rejects.toThrow("zone unavailable");
    const r = await getReceipt(env.FACTORY, id, "validate");
    expect(r?.status).toBe("failed");
    expect(String(r?.output?.error)).toContain("zone unavailable");
  });

  it("re-throws stored error without calling work on a failed receipt", async () => {
    const id = `i-${uniq()}`;
    await seedInstall(id);
    await expect(
      withReceipt(env.FACTORY, id, "validate", async () => { throw new Error("dns conflict"); }),
    ).rejects.toThrow("dns conflict");
    let called = false;
    await expect(
      withReceipt(env.FACTORY, id, "validate", async () => { called = true; return {}; }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});
