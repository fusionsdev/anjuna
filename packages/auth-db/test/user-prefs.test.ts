import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("user preferences migration applies on fresh D1 and isolates keys per user", async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  await env.DB.prepare("INSERT INTO user_prefs VALUES ('a','brand_scope','{}','now'),('b','brand_scope','{}','now')").run();
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM user_prefs").first("n")).toBe(2);
  await expect(env.DB.prepare("INSERT INTO user_prefs VALUES ('a','brand_scope','{}','now')").run()).rejects.toThrow();
});
