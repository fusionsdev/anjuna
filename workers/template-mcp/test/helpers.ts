import { applyD1Migrations, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sha256Hex } from "../src/auth";
import type { Fingerprint } from "../src/fingerprint";

export const BASE = "https://mcp.test";
export const KEY = "anj_mcp_test-key-0123456789abcdef";
export const NOW = "2026-10-02T00:00:00.000Z";

export async function setupDb(): Promise<void> {
  await applyD1Migrations(env.FACTORY, env.MIGRATIONS);
}

export async function resetDb(): Promise<void> {
  await env.FACTORY.batch(
    ["builder_key_usage", "builder_keys", "template_fingerprints", "brand_revisions", "brands", "form_artifacts", "template_versions", "templates"].map((t) => env.FACTORY.prepare(`DELETE FROM ${t}`)),
  );
}

export async function addKey(key = KEY, label = "test builder", id = "bk_test"): Promise<void> {
  await env.FACTORY.prepare("INSERT INTO builder_keys (key_id, label, key_hash, created_by, created_at) VALUES (?1, ?2, ?3, 'system', ?4)")
    .bind(id, label, await sha256Hex(key), NOW)
    .run();
}

export async function addBrand(id: string, name: string, domain: string): Promise<void> {
  await env.FACTORY.prepare("INSERT INTO brands (brand_id, name, account, domain, created_by, created_at, updated_at) VALUES (?1, ?2, 'acct', ?3, 'u', ?4, ?4)")
    .bind(id, name, domain, NOW)
    .run();
}

/** Seed a sealed template with a fingerprint, optionally installed for a brand. */
export async function addSealedTemplate(opts: { id: string; name: string; fingerprint: Fingerprint; brandId?: string }): Promise<void> {
  const sha = opts.id.padEnd(64, "a");
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT INTO templates (template_id, name, framework, created_by, created_at) VALUES (?1, ?2, 'astro', 'u', ?3)").bind(`t_${opts.id}`, opts.name, NOW),
    env.FACTORY.prepare("INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at) VALUES (?1, ?2, 1, ?3, 'k', 'sealed', 'u', ?4, 'u', ?4)").bind(`tv_${opts.id}`, `t_${opts.id}`, sha, NOW),
    env.FACTORY.prepare("INSERT INTO template_fingerprints (template_version_id, fingerprint_json, created_at) VALUES (?1, ?2, ?3)").bind(`tv_${opts.id}`, JSON.stringify(opts.fingerprint), NOW),
  ]);
  if (opts.brandId) {
    await env.FACTORY.batch([
      env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id, git_sha, r2_key, manifest_sha256, created_at) VALUES ('fa1', 'abc', 'k', 'm', ?1)").bind(NOW),
      env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id, brand_id, revision, template_version_id, form_artifact_id, config_json, created_by, created_at) VALUES (?1, ?2, 1, ?3, 'fa1', '{}', 'u', ?4)").bind(`r_${opts.id}`, opts.brandId, `tv_${opts.id}`, NOW),
    ]);
  }
}

export async function connect(key = KEY): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: (input, init) => SELF.fetch(input as RequestInfo, init as RequestInit),
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  return client;
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const first = (result.content as { type: string; text: string }[])[0]!;
  return { isError: result.isError === true, data: JSON.parse(first.text) as Record<string, any> };
}
