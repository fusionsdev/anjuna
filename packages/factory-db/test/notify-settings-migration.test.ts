import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("notification keys migration preserves settings and only allows the three dotted keys", async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS.filter(m => m.name < "0015"));
  await env.DB.prepare("INSERT INTO panel_settings VALUES ('fx_thb_per_usd','35','owner','now')").run();
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  expect(await env.DB.prepare("SELECT value_json FROM panel_settings WHERE key='fx_thb_per_usd'").first("value_json")).toBe("35");
  for (const key of ["notify.telegram", "notify.routing", "notify.digest"]) {
    await env.DB.prepare("INSERT INTO panel_settings VALUES (?1,'{}','owner','now')").bind(key).run();
  }
  await expect(env.DB.prepare("INSERT INTO panel_settings VALUES ('arbitrary.key','{}','owner','now')").run()).rejects.toThrow();
});
