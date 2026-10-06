import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { getReceipt, saveReceipt, setInstallStatus, shouldRetainBrandLockOnFailure, withReceipt } from "../src/receipt";

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

describe("lifecycle lock claim", () => {
  it("reports a same-ID dispatch as resume without releasing the brand lock", async () => {
    const id = `i-${uniq()}`;
    const brand = `brand-${id}`;
    await seedInstall(id, brand);
    await expect(setInstallStatus(env.FACTORY, id, "running", undefined, brand)).resolves.toBe("claimed");
    await expect(setInstallStatus(env.FACTORY, id, "running", undefined, brand)).resolves.toBe("resumed");
    const row = await env.FACTORY.prepare("SELECT status FROM brands WHERE brand_id = ?").bind(brand).first<{ status: string }>();
    expect(row?.status).toBe("installing");
  });

  it("lets only the linked compensation restore under the original lock and finalizes both installs", async () => {
    const original = `i-${uniq()}`;
    const compensation = `compensate-${original}`;
    const brand = `brand-${original}`;
    await seedInstall(original, brand);
    await seedInstall(compensation, brand);

    await expect(setInstallStatus(env.FACTORY, original, "running", undefined, brand)).resolves.toBe("claimed");
    await expect(setInstallStatus(env.FACTORY, `rollback-${original}`, "running", undefined, brand, {
      compensationForInstallId: original,
    })).rejects.toThrow(/lifecycle mutation in progress|not authorized/i);

    await expect(setInstallStatus(env.FACTORY, compensation, "running", undefined, brand, {
      compensationForInstallId: original,
    })).resolves.toBe("claimed");
    await expect(setInstallStatus(env.FACTORY, compensation, "rolled_back", undefined, brand)).resolves.toBe("updated");
    await expect(setInstallStatus(env.FACTORY, original, "rolled_back", undefined, brand)).resolves.toBe("updated");

    const rows = await env.FACTORY.prepare(
      "SELECT install_id, status FROM installs WHERE install_id IN (?, ?) ORDER BY install_id",
    ).bind(original, compensation).all<{ install_id: string; status: string }>();
    expect(rows.results).toEqual([
      { install_id: compensation, status: "rolled_back" },
      { install_id: original, status: "rolled_back" },
    ]);
    const brandRow = await env.FACTORY.prepare("SELECT status FROM brands WHERE brand_id = ?").bind(brand).first<{ status: string }>();
    expect(brandRow?.status).toBe("live");
  });

  it("preserves the original brand lock when linked compensation fails", async () => {
    const original = `i-${uniq()}`;
    const compensation = `compensate-${original}`;
    const brand = `brand-${original}`;
    await seedInstall(original, brand);
    await seedInstall(compensation, brand);

    await setInstallStatus(env.FACTORY, original, "running", undefined, brand);
    await setInstallStatus(env.FACTORY, compensation, "running", undefined, brand, {
      compensationForInstallId: original,
    });
    await setInstallStatus(env.FACTORY, compensation, "failed", "restore failed", brand, {
      retainBrandLock: shouldRetainBrandLockOnFailure(false, original),
    });

    const brandRow = await env.FACTORY.prepare("SELECT status FROM brands WHERE brand_id = ?").bind(brand).first<{ status: string }>();
    expect(brandRow?.status).toBe("installing");
    const compensationRow = await env.FACTORY.prepare("SELECT status FROM installs WHERE install_id = ?")
      .bind(compensation).first<{ status: string }>();
    expect(compensationRow?.status).toBe("failed");
  });
});
