import { detectTemplateZip, TEMPLATE_ZIP_LIMITS, type TemplateZipType } from "@anjuna/contracts";
import { unzipSync } from "fflate";

/** Inspect locally; the server independently validates paths, symlinks and all archive limits. */
export async function inspectTemplateZip(file: File): Promise<TemplateZipType> {
  if (file.size > TEMPLATE_ZIP_LIMITS.maxArchiveBytes) throw new Error("ZIP เกิน 30 MB (ZIP exceeds 30 MB)");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const files = new Map<string, Uint8Array>();
  let total = 0;
  let count = 0;
  const inflated = unzipSync(bytes, { filter: (entry) => {
    if (entry.name.startsWith("/") || /^[a-z]:/i.test(entry.name) || /[\\\0]/.test(entry.name) || entry.name.split("/").includes("..")) {
      throw new Error("ZIP มี path ไม่ปลอดภัย (Unsafe archive path)");
    }
    if (entry.name.endsWith("/")) return false;
    const name = entry.name.split("/").filter((part) => part && part !== ".").join("/");
    if (!name || files.has(name)) throw new Error("ZIP มี path ซ้ำหรือว่าง (Duplicate or empty path)");
    total += entry.originalSize;
    count++;
    if (entry.originalSize > TEMPLATE_ZIP_LIMITS.maxFileBytes || total > TEMPLATE_ZIP_LIMITS.maxTotalBytes || count > TEMPLATE_ZIP_LIMITS.maxFiles) {
      throw new Error("ZIP เกินขีดจำกัด (ZIP exceeds upload limits)");
    }
    files.set(name, new Uint8Array());
    // Names are enough for other entries. Do not inflate images just to detect the framework.
    return /(^|\/)index\.html$/.test(name);
  } });
  for (const [path, data] of Object.entries(inflated)) {
    files.set(path.split("/").filter((part) => part && part !== ".").join("/"), data);
  }
  return detectTemplateZip(files);
}
