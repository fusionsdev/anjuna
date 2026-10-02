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

  // Identify form JS/CSS chunks in /_f/assets/ that need renaming.
  const renames = new Map<string, string>();
  for (const path of formFiles.keys()) {
    if (/^\/_f\/assets\/[^/]+\.(js|css)$/.test(path)) {
      const base = path.split("/").pop()!;
      renames.set(path, `/_f/assets/${salt}_${base}`);
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
      // Add salt comment to JS chunks so brand identity is traceable in audits.
      if (/\.js$/.test(path) && renames.has(path)) {
        text = `// @anjuna-salt:${salt}\n${text}`;
      }
      content = ENC.encode(text);
    }

    merged.set(newPath, content);
  }

  return { files: merged, saltPrefix: salt };
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
