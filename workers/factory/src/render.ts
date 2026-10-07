import { unzipSync, zipSync } from "fflate";

export type FileMap = Map<string, Uint8Array>;

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** Derive an 8-char hex salt unique per (brandId, revisionId). */
async function deriveSalt(brandId: string, revisionId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", ENC.encode("anjuna-asset-salt"),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, ENC.encode(`${brandId}:${revisionId}`));
  return Array.from(new Uint8Array(sig).slice(0, 4)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Derive a deterministic opaque basename for one rendered asset. */
async function deriveAssetName(salt: string, path: string, bytes: Uint8Array, extension: string): Promise<string> {
  const input = new Uint8Array(ENC.encode(`${salt}:` + path + ":").length + bytes.length);
  const prefix = ENC.encode(`${salt}:` + path + ":");
  input.set(prefix);
  input.set(bytes, prefix.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const hash = Array.from(digest.slice(0, 8)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${salt}_${hash}.${extension}`;
}

/** Unzip R2 object bytes into a FileMap. */
export function unzip(bytes: Uint8Array): FileMap {
  const entries = unzipSync(bytes);
  const map: FileMap = new Map();
  for (const [path, content] of Object.entries(entries)) {
    if (content.length > 0 || !path.endsWith("/")) map.set(path, content);
  }
  return map;
}

/** Zip FileMap back to bytes. */
export function zip(files: FileMap): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of files) entries[path] = content;
  return zipSync(entries);
}

/**
 * Merge template files + form files, rename form `/_f/assets/HASH.ext` chunks using
 * a per-brand salt, rewrite all references, and add a salt comment to JS chunks.
 *
 * Returns a FileMap ready to be uploaded to Cloudflare Workers Assets.
 */
export async function renderBrand(
  templateFiles: FileMap,
  formFiles: FileMap,
  brandId: string,
  revisionId: string,
): Promise<{ files: FileMap; saltPrefix: string }> {
  const salt = await deriveSalt(brandId, revisionId);

  // Validate source paths as well as bytes before opaque renaming hides their names.
  assertCleanBrandBytes(templateFiles, brandId);
  assertCleanBrandBytes(formFiles, brandId);

  // Identify form JS/CSS chunks in /_f/assets/ that need renaming.
  const renames = new Map<string, string>();
  for (const [path, bytes] of formFiles) {
    if (/^\/_f\/assets\/[^/]+\.(js|css)$/.test(path)) {
      const extension = path.split(".").pop()!;
      renames.set(path, `/_f/assets/${await deriveAssetName(salt, path, bytes, extension)}`);
    }
  }

  const merged: FileMap = new Map();

  // Add template files unchanged.
  for (const [path, bytes] of templateFiles) merged.set(path, bytes);

  // Add form files, renaming chunks and rewriting references.
  for (const [path, bytes] of formFiles) {
    const newPath = renames.get(path) ?? path;
    let content = bytes;

    // Rewrite references to renamed chunks inside text files (HTML, JS).
    if (/\.(html?|js|json)$/i.test(path)) {
      let text = DEC.decode(bytes);
      for (const [oldPath, newPath2] of renames) {
        // Match the filename portion (e.g. "index-abc123.js") so we don't need to know full paths.
        const oldBase = oldPath.split("/").pop()!;
        const newBase = newPath2.split("/").pop()!;
        text = text.replaceAll(oldBase, newBase);
      }
      content = ENC.encode(text);
    }

    merged.set(newPath, content);
  }

  assertCleanBrandBytes(merged, brandId);

  return { files: merged, saltPrefix: salt };
}

/** Reject readable platform, cross-brand, analytics-key, and DSN bytes. */
export function assertCleanBrandBytes(files: FileMap, brandId: string): void {
  const identity = new RegExp(`anjuna|aurum|${escapeRegExp(brandId)}|brand_[0-9a-f]{16}`, "i");
  const credentials = /ph[cx]_[a-z0-9]{16,}|https?:\/\/[^\s"'<>/@]+(?::[^\s"'<>/@]+)?@[a-z0-9.-]+(?::\d+)?\/\d+|[a-z0-9-]+\.ingest(?:\.[a-z]{2})?\.sentry\.io/i;
  for (const [path, bytes] of files) {
    const content = DEC.decode(bytes);
    // This neutral DSN is replaced by the same-origin proxy; SDK names are not credentials.
    const withoutPlaceholder = content.replaceAll("https://public@placeholder.invalid/0", "");
    if (identity.test(path) || identity.test(content) || credentials.test(path) || credentials.test(withoutPlaceholder)) {
      throw new Error(`Brand bytes contain forbidden identity in ${path}`);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Read a ZIP from R2, return the FileMap.
 * Throws if the key does not exist.
 */
export async function readZipFromR2(bucket: R2Bucket, key: string): Promise<FileMap> {
  const obj = await bucket.get(key);
  if (!obj) throw new Error(`R2 object not found: ${key}`);
  return unzip(new Uint8Array(await obj.arrayBuffer()));
}

/**
 * Write a rendered FileMap as a ZIP to R2 and return the stored key.
 * Key pattern: `renders/{brandId}/{revisionId}.zip`
 */
export async function writeRenderToR2(bucket: R2Bucket, brandId: string, revisionId: string, files: FileMap): Promise<string> {
  const key = `renders/${brandId}/${revisionId}.zip`;
  await bucket.put(key, zip(files));
  return key;
}
