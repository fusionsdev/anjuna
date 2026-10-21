/**
 * Cloudflare Workers Upload REST API helpers.
 *
 * All functions take an explicit `fetcher` so tests can inject stubs without
 * touching globalThis.fetch. Wave 4 gates real calls; tests use mocks.
 */

export type CfFetch = (input: string, init?: RequestInit) => Promise<Response>;

const CF_API = "https://api.cloudflare.com/client/v4";

/**
 * A Cloudflare failure. `deterministic` marks one that the same input always repeats, so a
 * Workflow step can stop at once instead of retrying: a 4xx other than 408 and 429 (bad token,
 * missing scope, unknown resource) or a zone that is absent or inactive. 5xx, 408, 429, network
 * errors and unreadable 200 bodies stay retriable.
 */
export class CfError extends Error {
  constructor(message: string, readonly deterministic: boolean) { super(message); }
}

function deterministicStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function responseJson<T>(res: Response, context: string, allowEmpty = false): Promise<T> {
  const text = await res.text();
  // Workers Custom Domain DELETE succeeds with no JSON envelope (200 or 204).
  if (res.ok && allowEmpty && !text.trim()) return undefined as T;
  try {
    const json: unknown = JSON.parse(text);
    if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error();
    return json as T;
  } catch {
    const detail = text.trim() ? `invalid JSON envelope: ${text.slice(0, 200)}` : "empty response";
    throw new CfError(`${context} failed: HTTP ${res.status}: ${detail}`, deterministicStatus(res.status));
  }
}

export async function cfFetch<T>(
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
  const context = `CF API ${method} ${path}`;
  const json = await responseJson<{ success: boolean; errors?: { code: number; message: string }[]; result: T } | undefined>(res, context, method === "DELETE");
  if (json === undefined) return undefined as T;
  if (!res.ok || !json.success) {
    const msg = json.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? "unknown error";
    throw new CfError(`${context} failed: ${msg} (HTTP ${res.status})`, deterministicStatus(res.status));
  }
  return json.result;
}

export interface ZoneInfo {
  id: string;
  name: string;
  status: "active" | "pending" | "initializing" | "moved" | "deleted" | "deactivated" | "read only";
  /** Cloudflare name servers assigned to the zone. Read by the wizard zone pre-check only. */
  name_servers?: string[];
}

/**
 * Hostnames a brand serves on its zone. A brand whose domain equals the zone name is an
 * apex brand and serves the apex plus `www.`; a brand on a subdomain of the zone serves
 * only the bare subdomain, because Universal SSL covers the zone apex and `*.zone` but
 * never a second-level name such as `www.<subdomain>.<zone>`.
 */
export function brandHostnames(domain: string, zoneName: string): string[] {
  const bare = domain.toLowerCase().replace(/\.$/, "");
  const zone = zoneName.toLowerCase().replace(/\.$/, "");
  return bare === zone ? [bare, `www.${bare}`] : [bare];
}

/**
 * Returns the zone covering `domain`. Cloudflare zones are registered at the apex, so a
 * subdomain brand domain never matches `/zones?name=` directly: try the full domain first,
 * then strip one left label at a time (`a.b.example.com` -> `b.example.com` -> `example.com`).
 * A bare TLD (single label) is never queried. Throws if the zone found is not active.
 */
export async function getZone(token: string, domain: string, fetcher?: CfFetch): Promise<ZoneInfo> {
  const labels = domain.split(".").filter(Boolean);
  const candidates: string[] = [];
  for (let skip = 0; skip <= labels.length - 2; skip++) candidates.push(labels.slice(skip).join("."));
  for (const name of candidates) {
    const zones = await cfFetch<ZoneInfo[]>(token, "GET", `/zones?name=${encodeURIComponent(name)}&per_page=1`, undefined, undefined, fetcher);
    const zone = zones[0];
    if (!zone) continue;
    if (zone.status !== "active") throw new CfError(`Zone ${name} is not active (status=${zone.status})`, true);
    return zone;
  }
  throw new CfError(`Zone not found for domain ${domain} (tried: ${candidates.join(", ")})`, true);
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
 * Public DNS view of the brand hostnames (DNS-over-HTTPS, no credentials).
 * Used only when the zone DNS API refuses the token (Cloudflare error 10000): account API
 * tokens can be rejected by the zone DNS records endpoint even with DNS permissions. Proxied
 * and DNS-only records are both visible publicly, and Custom Domain attach still refuses a
 * hostname that already has records, so this keeps the preflight without widening the token.
 */
export async function publicApexDnsRecords(hostnames: string[], fetcher: CfFetch = globalThis.fetch): Promise<DnsRecord[]> {
  const found: DnsRecord[] = [];
  for (const name of hostnames) {
    for (const type of ["A", "AAAA", "CNAME"]) {
      const res = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
      });
      if (!res.ok) throw new Error(`Public DNS lookup ${type} ${name} failed: HTTP ${res.status}`);
      const body = await responseJson<{ Status: number; Answer?: Array<{ name: string; type: number }> }>(res, `Public DNS lookup ${type} ${name}`);
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
 * Returns A, AAAA and CNAME records on the brand hostnames.
 * The list API filters `name` and `type` by a single exact value each, so query each hostname
 * on its own and filter the type here. Falls back to the public DNS view when the zone DNS
 * API answers 10000 (authentication) for this token.
 */
export async function apexDnsRecords(token: string, zoneId: string, hostnames: string[], fetcher?: CfFetch): Promise<DnsRecord[]> {
  const found: DnsRecord[] = [];
  try {
    for (const name of hostnames) {
      const records = await cfFetch<DnsRecord[]>(
        token, "GET",
        `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=100`,
        undefined, undefined, fetcher,
      );
      found.push(...records.filter((record) => record.name === name && BLOCKING_TYPES.has(record.type)));
    }
  } catch (error) {
    if (!(error instanceof Error) || !/failed: 10000:/.test(error.message)) throw error;
    console.warn(`zone DNS API refused the token for ${hostnames[0]}; using the public DNS view for the preflight`);
    return publicApexDnsRecords(hostnames, fetcher);
  }
  return found;
}

/**
 * A, AAAA and CNAME records on the brand hostnames that do not belong to the brand's own Custom Domains.
 * Cloudflare creates the DNS record of an attached Custom Domain itself, so a record on a hostname that
 * the account's Workers Domains list shows attached to `scriptName` is the brand's own and does not
 * block. A hostname attached to another script, or not attached at all, keeps blocking. The list is
 * read only when the zone holds a record, and a failed read throws instead of letting records through.
 */
export async function blockingDnsRecords(
  token: string, accountId: string, zoneId: string, scriptName: string, hostnames: string[], fetcher?: CfFetch,
): Promise<DnsRecord[]> {
  const records = await apexDnsRecords(token, zoneId, hostnames, fetcher);
  if (records.length === 0) return [];
  // The list is filtered by service on Cloudflare's side; an entry that names another service is still refused.
  const own = new Set((await listCustomDomains(token, accountId, zoneId, scriptName, fetcher))
    .filter((domain) => domain.service === undefined || domain.service === scriptName)
    .map((domain) => domain.hostname.toLowerCase().replace(/\.$/, "")));
  return records.filter((record) => !own.has(record.name));
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
  try { json = JSON.parse(text); } catch { throw new CfError(`Asset upload failed: ${res.status} ${text.slice(0, 200)}`, deterministicStatus(res.status)); }
  if (!res.ok || json.success === false) {
    const msg = json.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? text.slice(0, 200);
    throw new CfError(`Asset upload failed: ${res.status} ${msg}`, deterministicStatus(res.status));
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

/**
 * Deploy a specific version to 100% traffic, or, without a version, return the deployment that
 * the script upload (`PUT /workers/scripts/{name}`) already created for the newest version.
 */
export async function deployScript(
  token: string, accountId: string, scriptName: string, versionId?: string, fetcher?: CfFetch,
): Promise<DeploymentResult> {
  if (!versionId) {
    const list = await cfFetch<{ deployments: DeploymentResult[] }>(
      token, "GET", `/accounts/${accountId}/workers/scripts/${scriptName}/deployments`, undefined, undefined, fetcher,
    );
    const latest = list.deployments?.[0];
    if (!latest) throw new Error(`No deployment found for ${scriptName}`);
    return latest;
  }
  const body = { strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }] };
  return cfFetch<DeploymentResult>(token, "POST", `/accounts/${accountId}/workers/scripts/${scriptName}/deployments`, JSON.stringify(body), "application/json", fetcher);
}

export interface CustomDomainResult {
  id: string;
  hostname: string;
  service: string;
}

/** Attach a Custom Domain to a Worker script (account-level Workers Domains API). Idempotent. */
export async function attachCustomDomain(
  token: string, accountId: string, zoneId: string, hostname: string, scriptName: string, fetcher?: CfFetch,
): Promise<CustomDomainResult> {
  return cfFetch<CustomDomainResult>(
    token, "PUT", `/accounts/${accountId}/workers/domains`,
    JSON.stringify({ hostname, service: scriptName, zone_id: zoneId, environment: "production" }),
    "application/json", fetcher,
  );
}

/** Custom Domains attached to a Worker script in one zone. */
export async function listCustomDomains(
  token: string, accountId: string, zoneId: string, scriptName: string, fetcher?: CfFetch,
): Promise<CustomDomainResult[]> {
  return cfFetch<CustomDomainResult[]>(
    token, "GET", `/accounts/${accountId}/workers/domains?zone_id=${zoneId}&service=${encodeURIComponent(scriptName)}`,
    undefined, undefined, fetcher,
  );
}

/** Remove a Custom Domain attachment. */
export async function detachCustomDomain(token: string, accountId: string, domainId: string, fetcher?: CfFetch): Promise<void> {
  await cfFetch<void>(token, "DELETE", `/accounts/${accountId}/workers/domains/${domainId}`, undefined, undefined, fetcher);
}
