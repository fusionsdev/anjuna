/**
 * Loading a template to check: base64 zip, a URL (zip download or live static site), or a GitHub repo.
 * Everything is read as bytes. No template code is executed and no build tool is run.
 */
import { InputError, LIMITS, readTarGz, readZip, type FileMap } from "./archive";
import { allElements, cssUrls, decode, parseHtml, rawText, srcsetUrls } from "./html";
import type { Env } from "./env";

export interface SourceInput {
  zip_base64?: string;
  url?: string;
}

export interface Loaded {
  files: FileMap;
  source: string;
  notes: string[];
}

const FETCH_TIMEOUT_MS = 20_000;
const MAX_CRAWL_FETCHES = 150;
const MAX_REDIRECTS = 3;

export function loadZipBase64(b64: string): Loaded {
  const cleaned = b64.replace(/^data:[^,]*;base64,/, "").replace(/\s+/g, "");
  if (cleaned.length > Math.ceil((LIMITS.maxArchiveBytes * 4) / 3) + 8) {
    throw new InputError("too_large", "Zip is larger than 30 MB. Pass a URL to the zip instead, or shrink the build.");
  }
  let binary: string;
  try {
    binary = atob(cleaned);
  } catch {
    throw new InputError("bad_base64", "zip_base64 is not valid base64.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { files: readZip(bytes), source: "zip_base64", notes: [] };
}

/** Public https hosts only. Workers cannot reach private networks, but fail fast with a clear message. */
export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InputError("bad_url", `Not a valid URL: ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:") throw new InputError("bad_url", "Only https:// URLs are accepted.");
  if (url.username || url.password) throw new InputError("bad_url", "URLs with credentials are not accepted.");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.startsWith("[")
  ) {
    throw new InputError("bad_url", "Only public hostnames are accepted (no localhost, IP addresses or internal names).");
  }
  return url;
}

async function readCapped(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > max) throw new InputError("too_large", `Response is larger than ${Math.round(max / 1048576)} MB.`);
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new InputError("too_large", `Response is larger than ${Math.round(max / 1048576)} MB.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function safeFetch(raw: string, init: RequestInit = {}): Promise<{ response: Response; url: URL }> {
  let url = assertPublicHttpsUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(url.toString(), { ...init, redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel();
      url = assertPublicHttpsUrl(new URL(response.headers.get("location")!, url).toString());
      continue;
    }
    return { response, url };
  }
  throw new InputError("too_many_redirects", "Too many redirects.");
}

export async function loadFromUrl(raw: string): Promise<Loaded> {
  const { response, url } = await safeFetch(raw, { headers: { accept: "application/zip,text/html;q=0.9,*/*;q=0.5", "user-agent": "anjuna-template-mcp/1" } });
  if (!response.ok) throw new InputError("fetch_failed", `GET ${url} returned HTTP ${response.status}.`);
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const body = await readCapped(response, LIMITS.maxArchiveBytes);
  const isZip = body.length > 4 && body[0] === 0x50 && body[1] === 0x4b && body[2] === 3 && body[3] === 4;
  if (isZip || type.includes("zip")) return { files: readZip(body), source: `url:zip:${url.host}`, notes: [] };
  if (!type.includes("html") && body.length > 0 && !/^\s*<(!doctype|html)/i.test(decode(body.subarray(0, 200)))) {
    throw new InputError("unsupported_url", `The URL returned ${type || "unknown content"}; pass a .zip of the static build or the URL of the deployed static site.`);
  }
  return crawlSite(url, body);
}

function fileKey(url: URL, contentType: string): string | null {
  let path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (path.split("/").includes("..")) return null;
  if (path === "" || path.endsWith("/")) path += "index.html";
  else if (contentType.includes("html") && !/\.html?$/i.test(path)) path += "/index.html";
  return path;
}

/** Fetch a live static site breadth-first (same origin only) into a file map. */
async function crawlSite(entry: URL, entryBody: Uint8Array): Promise<Loaded> {
  const origin = entry.origin;
  const files: FileMap = new Map();
  const notes: string[] = [];
  const seen = new Set<string>();
  const queue: URL[] = [];
  let fetches = 0;
  let total = 0;

  const enqueue = (ref: string, base: URL) => {
    if (!ref || ref.startsWith("#") || /^(?:mailto|tel|sms|javascript|data|blob):/i.test(ref)) return;
    let target: URL;
    try {
      target = new URL(ref, base);
    } catch {
      return;
    }
    if (target.origin !== origin || target.protocol !== "https:") return;
    target.hash = "";
    target.search = "";
    const first = target.pathname.split("/")[1] ?? "";
    if (["go", "api", "_f"].includes(first)) return;
    if (!seen.has(target.toString())) {
      seen.add(target.toString());
      queue.push(target);
    }
  };

  const absorb = (url: URL, type: string, body: Uint8Array) => {
    const key = fileKey(url, type);
    if (!key || files.has(key)) return;
    // Running totals stop the crawl as soon as the site breaks the import limits, before the bytes are zipped.
    total += body.length;
    if (total > LIMITS.maxArchiveBytes || files.size >= LIMITS.maxFiles) {
      throw new InputError("too_large", `The published site is larger than the import limits (${LIMITS.maxFiles} files / ${LIMITS.maxArchiveBytes / 1048576} MB).`);
    }
    files.set(key, body);
    if (type.includes("html") || /\.html?$/i.test(key)) {
      const doc = parseHtml(decode(body));
      for (const el of allElements(doc)) {
        for (const attr of ["href", "src", "poster", "data"]) if (el.attribs[attr]) enqueue(el.attribs[attr]!, url);
        if (el.attribs.srcset) for (const u of srcsetUrls(el.attribs.srcset)) enqueue(u, url);
        if (el.attribs.style) for (const u of cssUrls(el.attribs.style)) enqueue(u, url);
        if (el.name === "style") for (const u of cssUrls(rawText(el))) enqueue(u, url);
      }
    } else if (type.includes("css") || /\.css$/i.test(key)) {
      for (const u of cssUrls(decode(body))) enqueue(u, url);
    }
  };

  seen.add(entry.toString());
  absorb(entry, "text/html", entryBody);
  for (const page of ["/privacy/", "/terms/", "/do-not-sell/", "/disclosures/"]) enqueue(page, entry);

  while (queue.length > 0) {
    const batch = queue.splice(0, 6);
    await Promise.all(
      batch.map(async (url) => {
        if (fetches >= MAX_CRAWL_FETCHES) return;
        fetches++;
        try {
          const { response, url: finalUrl } = await safeFetch(url.toString(), { headers: { "user-agent": "anjuna-template-mcp/1" } });
          if (!response.ok) {
            await response.body?.cancel();
            return;
          }
          const type = (response.headers.get("content-type") ?? "").toLowerCase();
          const body = await readCapped(response, LIMITS.maxFileBytes);
          if (finalUrl.origin === origin) absorb(url, type, body);
        } catch (error) {
          if (error instanceof InputError && error.code === "too_large") throw error;
        }
      }),
    );
  }
  if (fetches >= MAX_CRAWL_FETCHES) notes.push(`Crawl stopped after ${MAX_CRAWL_FETCHES} requests; pass a zip for a complete check.`);
  notes.push("Live URL checked as served HTML/CSS/JS bytes only; JavaScript was not executed, so client-rendered content is not visible. Prerender the page or send a zip of dist/.");
  return { files, source: `url:site:${entry.host}`, notes };
}

export interface GithubInput {
  owner: string;
  repo: string;
  ref?: string;
  path?: string;
}

export interface GithubResult extends Loaded {
  needsBuild?: { framework: string; command: string; output_dir: string };
}

const OUTPUT_DIRS = ["dist", "out", "build"];

export async function loadFromGithub(input: GithubInput, env: Pick<Env, "GITHUB_TOKEN">): Promise<GithubResult> {
  const { owner, repo, ref, path } = input;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) throw new InputError("bad_repo", "Invalid GitHub owner.");
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) throw new InputError("bad_repo", "Invalid GitHub repo name.");
  if (ref && (!/^[A-Za-z0-9_./@+-]{1,200}$/.test(ref) || ref.includes(".."))) throw new InputError("bad_ref", "Invalid git ref.");
  const prefix = path ? path.replace(/^\/+|\/+$/g, "") : "";
  if (prefix && (prefix.split("/").includes("..") || !/^[\w./@+-]+$/.test(prefix))) throw new InputError("bad_path", "Invalid path.");

  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "anjuna-template-mcp/1", "x-github-api-version": "2022-11-28" };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const target = `https://api.github.com/repos/${owner}/${repo}/tarball${ref ? `/${encodeURIComponent(ref).replace(/%2F/g, "/")}` : ""}`;
  const response = await fetch(target, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (response.status === 404) throw new InputError("repo_not_found", `${owner}/${repo}${ref ? `@${ref}` : ""} was not found or is private. Make it public, or ask the Anjuna owner to configure read access.`);
  if (response.status === 403 || response.status === 429) throw new InputError("github_rate_limited", "GitHub refused the request (rate limit or access). Try again later.");
  if (!response.ok || !response.body) throw new InputError("fetch_failed", `GitHub returned HTTP ${response.status}.`);

  const wanted = (p: string) =>
    !/^(?:\.git|node_modules)\//.test(p) && !p.includes("/node_modules/") &&
    (!prefix ? true : p.startsWith(`${prefix}/`) || p === "package.json");
  const all = await readTarGz(response.body, { stripTopLevel: true, keep: wanted });

  let root = prefix;
  if (!root) {
    const dir = OUTPUT_DIRS.find((d) => all.has(`${d}/index.html`));
    if (dir) root = dir;
  }
  const files: FileMap = new Map();
  if (root) {
    for (const [p, bytes] of all) if (p.startsWith(`${root}/`)) files.set(p.slice(root.length + 1), bytes);
    if (!files.has("index.html")) throw new InputError("no_build_output", `${root}/index.html was not found in the repository.`);
    return { files, source: `github:${owner}/${repo}@${ref ?? "HEAD"}:${root}`, notes: [] };
  }
  // No build folder. A repo whose root is the built site (e.g. a dist/gh-pages branch) has index.html and no package.json.
  if (all.has("index.html") && !all.has("package.json")) {
    for (const [p, bytes] of all) files.set(p, bytes);
    return { files, source: `github:${owner}/${repo}@${ref ?? "HEAD"}:/`, notes: [] };
  }
  const pkg = all.has("package.json") ? decode(all.get("package.json")!) : "";
  let framework = "";
  let command = "";
  let outputDir = "dist";
  try {
    const parsed = JSON.parse(pkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...parsed.dependencies, ...parsed.devDependencies };
    if (deps.astro) [framework, command] = ["astro", "astro build"];
    else if (deps.next) [framework, command, outputDir] = ["next", "next build (with output: 'export')", "out"];
    else if (deps.vite) [framework, command] = ["vite", "vite build"];
  } catch {
    /* no usable package.json */
  }
  return {
    files,
    source: `github:${owner}/${repo}@${ref ?? "HEAD"}`,
    notes: [],
    needsBuild: { framework: framework || "unknown", command: command || "your build command", output_dir: outputDir },
  };
}
