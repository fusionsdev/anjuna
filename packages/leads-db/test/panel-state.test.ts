import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("panel migrations apply to fresh D1 and persist alert state and delivery results", async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  const columns = await env.DB.prepare("PRAGMA table_info(traffic_events)").all<{ name: string; notnull: number }>();
  for (const name of ["user_agent_family", "country", "region"]) {
    expect(columns.results.find(c => c.name === name)?.notnull).toBe(0);
  }
  await env.DB.prepare("INSERT INTO alert_state(alert_key,state,first_seen,updated_at) VALUES ('adsbot:a','warn','now','now')").run();
  await env.DB.prepare("INSERT INTO notification_log(id,channel,target,alert_key,status,body_hash,sent_at) VALUES ('n1','telegram','123','adsbot:a','sent','hash','now')").run();
  expect(await env.DB.prepare("SELECT state FROM alert_state").first("state")).toBe("warn");
  expect(await env.DB.prepare("SELECT status FROM notification_log").first("status")).toBe("sent");
  const index = await env.DB.prepare("SELECT name FROM pragma_index_info('idx_traffic_events_brand_created') ORDER BY seqno").all<{ name: string }>();
  expect(index.results.map(x => x.name)).toEqual(["brand", "created_at"]);
});
