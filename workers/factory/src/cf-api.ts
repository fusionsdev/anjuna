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

const DOH_TYPES: Record<number, string> = { 1: "A", 5: "CNAME", 28: "AAAA" };

/**
 * Public DNS view of the apex and www hostnames (DNS-over-HTTPS, no credentials).
 * Used only when the zone DNS API refuses the token (Cloudflare error 10000): account API
 * tokens can be rejected by the zone DNS records endpoint even with DNS permissions. Proxied
 * and DNS-only records are both visible publicly, and Custom Domain attach still refuses a
 * hostname that already has records, so this keeps the preflight without widening the token.
 */
export async function publicApexDnsRecords(domain: string, fetcher: CfFetch = globalThis.fetch): Promise<DnsRecord[]> {
  const found: DnsRecord[] = [];
  for (const name of [domain, `www.${domain}`]) {
    for (const type of ["A", "AAAA", "CNAME"]) {
      const res = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
      });
      if (!res.ok) throw new Error(`Public DNS lookup ${type} ${name} failed: HTTP ${res.status}`);
      const body = await res.json<{ Status: number; Answer?: Array<{ name: string; type: number }> }>();
      if (body.Status !== 0 && body.Status !== 3) throw new Error(`Public DNS lookup ${type} ${name} failed: rcode ${body.Status}`);
      for (const answer of body.Answer ?? []) {
        const answerName = answer.name.replace(/\.$/, "").toLowerCase();
        const answerType = DOH_TYPES[answer.type];
        if (answerName === name && answerType && !found.some((r) => r.name === name && r.type === answerType)) {
          found.push({ id: "public-dns", type: answerType, name });
        }
      }
    }
  }
  return found;
}

/**
 * Returns A, AAAA and CNAME records on the apex and www hostnames.
 * The list API filters `name` and `type` by a single exact value each, so query each hostname
 * on its own and filter the type here. Falls back to the public DNS view when the zone DNS
 * API answers 10000 (authentication) for this token.
 */
export async function apexDnsRecords(token: string, zoneId: string, domain: string, fetcher?: CfFetch): Promise<DnsRecord[]> {
  const found: DnsRecord[] = [];
  try {
    for (const name of [domain, `www.${domain}`]) {
      const records = await cfFetch<DnsRecord[]>(
        token, "GET",
        `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=100`,
        undefined, undefined, fetcher,
      );
      found.push(...records.filter((record) => record.name === name && BLOCKING_TYPES.has(record.type)));
    }
  } catch (error) {
    if (!(error instanceof Error) || !/failed: 10000:/.test(error.message)) throw error;
    console.warn(`zone DNS API refused the token for ${domain}; using the public DNS view for the preflight`);
    return publicApexDnsRecords(domain, fetcher);
  }
  return found;
}

export interface AssetsSession {
  /** Upload JWT for the buckets, or the completion JWT when nothing needs uploading. */
  jwt: string;
  /** Hashes still to upload, grouped as Cloudflare wants them uploaded together. */
  buckets: string[][];
}

export type AssetManifest = Record<string, { hash: string; size: number }>;

/**
 * Register the asset manifest for a Worker script (Workers static assets direct upload).
 * Manifest keys are absolute paths ("/index.html"); hashes are 32 hex characters.
 */
export async function createAssetsSession(
  token: string, accountId: string, scriptName: string, manifest: AssetManifest, fetcher?: CfFetch,
): Promise<AssetsSession> {
  return cfFetch<AssetsSession>(
    token, "POST", `/accounts/${accountId}/workers/scripts/${scriptName}/assets-upload-session`,
    JSON.stringify({ manifest }), "application/json", fetcher,
  );
}

/**
 * Upload one bucket of files with the session's upload JWT (multipart, base64 contents).
 * Returns the completion JWT when this upload finished the manifest, otherwise undefined.
 */
export async function uploadAssetBucket(
  uploadJwt: string, accountId: string, files: Array<{ hash: string; base64: string; contentType: string }>,
  fetcher: CfFetch = globalThis.fetch,
): Promise<string | undefined> {
  const form = new FormData();
  for (const file of files) form.append(file.hash, new File([file.base64], file.hash, { type: file.contentType }));
  const res = await fetcher(`${CF_API}/accounts/${accountId}/workers/assets/upload?base64=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${uploadJwt}` },
    body: form,
  });
  const text = await res.text();
  let json: { success?: boolean; errors?: { code: number; message: string }[]; result?: { jwt?: string } };
  try { json = JSON.parse(text); } catch { throw new Error(`Asset upload failed: ${res.status} ${text.slice(0, 200)}`); }
  if (!res.ok || json.success === false) {
    const msg = json.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? text.slice(0, 200);
    throw new Error(`Asset upload failed: ${res.status} ${msg}`);
  }
  return json.result?.jwt;
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html", css: "text/css", js: "application/javascript", mjs: "application/javascript",
  json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", txt: "text/plain",
  woff: "font/woff", woff2: "font/woff2", xml: "application/xml", webmanifest: "application/manifest+json",
};

/** Content type served for an asset path; unknown extensions are sent without one. */
export function assetContentType(path: string): string {
  const extension = path.split("/").pop()!.split(".").pop()!.toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/null";
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
