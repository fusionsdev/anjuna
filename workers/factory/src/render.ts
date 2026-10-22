import { NonRetryableError } from "cloudflare:workflows";
import { unzipSync, zipSync } from "fflate";
import { BrandProfile, TEMPLATE_RULES } from "@anjuna/contracts";
import { renderPageText } from "@anjuna/brand-runtime/page-text";

export type FileMap = Map<string, Uint8Array>;

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** Pass the revision's config_json.profile and the brand's public display name, never its ID. */
export interface LegalRenderData {
  brand_name?: string;
  profile?: BrandProfile;
  /** The template's own brand name (text_defaults.brand_name, else the template display name). */
  template_brand?: string | null;
  /** Default text of the H1 [data-kw] slot; needed when profile.copy.h1 is set. */
  keyword_default?: string | null;
}

/**
 * Static text-node slots in terms/disclosures. A slot with no value in the profile keeps the template's own text:
 * the template carries its APR table, term range and state list, and the lender sets the real rate at review.
 * No product defaults are invented.
 */
async function fillLegalPage(bytes: Uint8Array, data: LegalRenderData): Promise<Uint8Array> {
  const profile = BrandProfile.parse(data.profile ?? {});
  const contact = profile.contact ?? {};
  const disclosures = profile.disclosures ?? {};
  const text = (value: string | undefined) => value?.trim() || undefined;
  const slots: Record<string, string | undefined> = {
    brand_name: text(data.brand_name),
    "contact.address": text(contact.address),
    "contact.email": text(contact.email),
    "contact.phone": text(contact.phone),
    "disclosures.apr_max": disclosures.apr_max === undefined ? undefined : `${disclosures.apr_max}%`,
    "disclosures.term_min_months": disclosures.term_min_months === undefined ? undefined : `${disclosures.term_min_months} months`,
    "disclosures.term_max_months": disclosures.term_max_months === undefined ? undefined : `${disclosures.term_max_months} months`,
    "disclosures.term_range": disclosures.term_min_months === undefined || disclosures.term_max_months === undefined
      ? undefined : `${disclosures.term_min_months}–${disclosures.term_max_months} months`,
    "disclosures.representative_example": text(disclosures.representative_example),
    "disclosures.unsupported_states": disclosures.unsupported_states?.length ? disclosures.unsupported_states.join(", ") : undefined,
  };
  // Use a parser, not string substitution: values can only replace text inside an explicit span.
  const html = await new HTMLRewriter().on("[data-legal]", { element(element) {
    const key = element.getAttribute("data-legal") ?? "";
    if (element.tagName !== "span" || !Object.hasOwn(slots, key)) {
      throw new Error("Legal placeholders must be spans with a documented data-legal key.");
    }
    const value = slots[key];
    if (value === undefined) return;
    if (TEMPLATE_RULES.forbiddenWording.test(value)) throw new Error("Legal text contains forbidden wording.");
    element.setInnerContent(value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"), { html: true });
  } }).transform(new Response(DEC.decode(bytes))).text();
  return ENC.encode(html);
}

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
  legal: LegalRenderData = {},
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

  // Fill only explicit legal-page slots, once per render. Existing templates without slots stay byte-identical.
  const pages = new Map<string, string>();
  for (const [path, bytes] of templateFiles) {
    const legalPage = /^\/?(?:terms|disclosures)(?:\/index)?\.html?$/i.test(path);
    const filled = legalPage && /data-legal/i.test(DEC.decode(bytes)) ? await fillLegalPage(bytes, legal) : bytes;
    merged.set(path, filled);
    if (/\.html?$/i.test(path)) pages.set(path, DEC.decode(filled));
  }

  // Page text (wizard copy, contact, the template's own brand name): the function the wizard preview runs too.
  // Pages with nothing to change keep their bytes.
  const rendered = await renderPageText(pages, {
    brand_name: legal.brand_name ?? "", template_brand: legal.template_brand, keyword_default: legal.keyword_default, profile: legal.profile,
  });
  for (const [path, html] of rendered) if (html !== pages.get(path)) merged.set(path, ENC.encode(html));

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
 * Throws a NonRetryableError if the key does not exist or holds no readable ZIP: the same key fails the same way.
 * An R2 read that fails keeps its own error, which a Workflow step retries.
 */
export async function readZipFromR2(bucket: R2Bucket, key: string): Promise<FileMap> {
  const obj = await bucket.get(key);
  if (!obj) throw new NonRetryableError(`R2 object not found: ${key}`);
  const bytes = new Uint8Array(await obj.arrayBuffer());
  try { return unzip(bytes); } catch (err) { throw new NonRetryableError(err instanceof Error ? err.message : String(err)); }
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
