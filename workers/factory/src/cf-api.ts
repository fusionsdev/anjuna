/**
 * Cloudflare Workers Upload REST API helpers.
 *
 * All functions take an explicit `fetcher` so tests can inject stubs without
 * touching globalThis.fetch. Wave 4 gates real calls; tests use mocks.
 */

export type CfFetch = (input: string, init?: RequestInit) => Promise<Response>;

const CF_API = "https://api.cloudflare.com/client/v4";

async function cfFetch<T>(
  token: string,
  method: string,
  path: string,
  body?: BodyInit,
  contentType?: string,
  fetcher: CfFetch = globalThis.fetch,
): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (contentType) headers["Content-Type"] = contentType;
  const res = await fetcher(`${CF_API}${path}`, { method, headers, body });
  const json = await res.json<{ success: boolean; errors?: { code: number; message: string }[]; result: T }>();
  if (!json.success) {
    const msg = json.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? "unknown error";
    throw new Error(`CF API ${method} ${path} failed: ${msg}`);
  }
  return json.result;
}

export interface ZoneInfo {
  id: string;
  status: "active" | "pending" | "initializing" | "moved" | "deleted" | "deactivated" | "read only";
}

/** Returns the zone for `domain`. Throws if zone is not active. */
export async function getZone(token: string, domain: string, fetcher?: CfFetch): Promise<ZoneInfo> {
  const zones = await cfFetch<ZoneInfo[]>(token, "GET", `/zones?name=${domain}&per_page=1`, undefined, undefined, fetcher);
  const zone = zones[0];
  if (!zone) throw new Error(`Zone not found for domain ${domain}`);
  if (zone.status !== "active") throw new Error(`Zone ${domain} is not active (status=${zone.status})`);
  return zone;
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
}

/** Record types that block a Workers Custom Domain on a hostname. */
const BLOCKING_TYPES = new Set(["A", "AAAA", "CNAME"]);

/**
 * Returns A, AAAA and CNAME records on the apex and www hostnames.
 * The list API filters `name` and `type` by a single exact value each, so query each hostname
 * on its own and filter the type here.
 */
export async function apexDnsRecords(token: string, zoneId: string, domain: string, fetcher?: CfFetch): Promise<DnsRecord[]> {
  const found: DnsRecord[] = [];
  for (const name of [domain, `www.${domain}`]) {
    const records = await cfFetch<DnsRecord[]>(
      token, "GET",
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=100`,
      undefined, undefined, fetcher,
    );
    found.push(...records.filter((record) => record.name === name && BLOCKING_TYPES.has(record.type)));
  }
  return found;
}

export interface AssetsSession {
  /** JWT used to upload individual files. */
  jwt: string;
  /** Hashes already present in the store — skip uploading these. */
  buckets: string[][];
}

/** Start a Workers Assets upload session. */
export async function createAssetsSession(
  token: string, accountId: string, files: { hash: string; size: number }[], fetcher?: CfFetch,
): Promise<AssetsSession> {
  return cfFetch<AssetsSession>(
    token, "POST", `/accounts/${accountId}/workers/assets/upload`,
    JSON.stringify(files), "application/json", fetcher,
  );
}

/** Upload one hashed file to an open assets session. */
export async function uploadAssetFile(
  sessionJwt: string, hash: string, content: Uint8Array, contentType: string, fetcher: CfFetch = globalThis.fetch,
): Promise<void> {
  const res = await fetcher(`${CF_API}/accounts/assets/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionJwt}`, "Content-Type": contentType, "CF-Asset-Hash": hash },
    body: content,
  });
  if (!res.ok) throw new Error(`Asset upload failed: ${res.status} ${await res.text()}`);
}

export interface ScriptUploadResult {
  id: string;
  etag: string;
}

/**
 * Upload (or replace) the brand Worker script with its env vars and assets session.
 * `scriptBody` is the pre-bundled ESM Worker source (brand-runtime).
 */
export async function uploadScript(
  token: string,
  accountId: string,
  scriptName: string,
  scriptBody: string,
  metadata: {
    main_module: string;
    bindings: Array<{ type: string; name: string; [key: string]: unknown }>;
    assets?: {
      jwt: string;
      config: { html_handling: "none"; run_worker_first: true | string[]; not_found_handling?: "none" | "404-page" };
    };
    compatibility_date: string;
    compatibility_flags?: string[];
    keep_bindings?: string[];
    brand_id?: string;
    core_token?: string;
  },
  fetcher?: CfFetch,
): Promise<ScriptUploadResult> {
  const bindings = [
    ...metadata.bindings.filter((binding) => binding.name !== "CORE_TOKEN"),
    ...(metadata.core_token ? [{ type: "secret_text", name: "CORE_TOKEN", text: metadata.core_token }] : []),
  ];
  const uploadMetadata = { ...metadata, bindings };
  delete uploadMetadata.brand_id;
  delete uploadMetadata.core_token;
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(uploadMetadata)], { type: "application/json" }), "metadata.json");
  form.append("worker.js", new Blob([scriptBody], { type: "application/javascript+module" }), "worker.js");
  return cfFetch<ScriptUploadResult>(token, "PUT", `/accounts/${accountId}/workers/scripts/${scriptName}`, form as unknown as BodyInit, undefined, fetcher);
}

export interface DeploymentResult {
  id: string;
  /** Cloudflare Worker version id, stored in brand_revisions.worker_version_id. */
  versions: Array<{ version_id: string; percentage: number }>;
}

/** Deploy a specific version (or the latest upload) to 100% traffic. */
export async function deployScript(
  token: string, accountId: string, scriptName: string, versionId?: string, fetcher?: CfFetch,
): Promise<DeploymentResult> {
  const body = versionId
    ? { strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }] }
    : { strategy: "percentage" };
  return cfFetch<DeploymentResult>(token, "POST", `/accounts/${accountId}/workers/scripts/${scriptName}/deployments`, JSON.stringify(body), "application/json", fetcher);
}

export interface CustomDomainResult {
  id: string;
  hostname: string;
  service: string;
}

/** Attach a Custom Domain to a Worker script. Idempotent if already attached. */
export async function attachCustomDomain(
  token: string, zoneId: string, hostname: string, scriptName: string, fetcher?: CfFetch,
): Promise<CustomDomainResult> {
  return cfFetch<CustomDomainResult>(
    token, "PUT", `/zones/${zoneId}/workers/domains`,
    JSON.stringify({ hostname, service: scriptName, environment: "production" }),
    "application/json", fetcher,
  );
}

/** Remove a Custom Domain attachment. */
export async function detachCustomDomain(token: string, zoneId: string, domainId: string, fetcher?: CfFetch): Promise<void> {
  await cfFetch<unknown>(token, "DELETE", `/zones/${zoneId}/workers/domains/${domainId}`, undefined, undefined, fetcher);
}
