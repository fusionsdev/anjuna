/**
 * Safe archive readers. Nothing here executes template code; files are only read as bytes.
 * Limits (owner decision): zip <= 30 MB, <= 2000 files. Zip-slip, symlinks, encryption and
 * decompression bombs are rejected.
 */
import { unzipSync } from "fflate";

import { TEMPLATE_ZIP_LIMITS } from "@anjuna/contracts";

export const LIMITS = TEMPLATE_ZIP_LIMITS;

export type FileMap = Map<string, Uint8Array>;

export class InputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Normalize an archive path or throw if it escapes the root (zip-slip) or is otherwise unsafe. */
export function safePath(raw: string): string {
  if (raw.includes("\0")) throw new InputError("unsafe_path", `Path contains a NUL byte: ${JSON.stringify(raw)}`);
  if (raw.includes("\\")) throw new InputError("unsafe_path", `Path contains a backslash: ${JSON.stringify(raw)}`);
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) throw new InputError("unsafe_path", `Absolute path in archive: ${raw}`);
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new InputError("zip_slip", `Path escapes the archive root (zip-slip): ${raw}`);
    parts.push(part);
  }
  if (parts.length === 0) throw new InputError("unsafe_path", `Empty path in archive: ${JSON.stringify(raw)}`);
  return parts.join("/");
}

interface CentralEntry {
  name: string;
  flags: number;
  method: number;
  madeBy: number;
  externalAttrs: number;
  compressedSize: number;
  size: number;
}

function parseCentralDirectory(data: Uint8Array): CentralEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new InputError("bad_zip", "Not a valid zip file (end of central directory not found).");
  const total = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new InputError("zip64", "ZIP64 archives are not accepted (the limit is 30 MB / 2000 files).");
  }
  if (total > LIMITS.maxFiles * 2) throw new InputError("too_many_files", `Archive has ${total} entries; the limit is ${LIMITS.maxFiles} files.`);
  const entries: CentralEntry[] = [];
  let p = cdOffset;
  const decoder = new TextDecoder("utf-8");
  for (let n = 0; n < total; n++) {
    if (p + 46 > data.length || view.getUint32(p, true) !== 0x02014b50) {
      throw new InputError("bad_zip", "Corrupt zip central directory.");
    }
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    entries.push({
      madeBy: view.getUint16(p + 4, true),
      flags: view.getUint16(p + 8, true),
      method: view.getUint16(p + 10, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      externalAttrs: view.getUint32(p + 38, true),
      name: decoder.decode(data.subarray(p + 46, p + 46 + nameLen)),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Read a zip into a file map, enforcing every limit before any byte is inflated. */
export function readZip(data: Uint8Array): FileMap {
  if (data.length > LIMITS.maxArchiveBytes) {
    throw new InputError("too_large", `Zip is ${(data.length / 1048576).toFixed(1)} MB; the limit is 30 MB.`);
  }
  const entries = parseCentralDirectory(data);
  const wanted = new Map<string, CentralEntry>();
  let totalBytes = 0;
  for (const entry of entries) {
    const isDir = entry.name.endsWith("/");
    const hostOs = entry.madeBy >> 8;
    const mode = (entry.externalAttrs >>> 16) & 0xffff;
    // Unix host: the file-type bits live in the high word of the external attributes.
    if (hostOs === 3 && (mode & 0o170000) === 0o120000) {
      throw new InputError("symlink", `Symlinks are not allowed: ${entry.name}`);
    }
    if (hostOs === 3 && mode !== 0 && ![0o100000, 0o040000].includes(mode & 0o170000)) {
      throw new InputError("special_file", `Only regular files are allowed: ${entry.name}`);
    }
    const path = safePath(isDir ? entry.name.slice(0, -1) || "." : entry.name);
    if (isDir) continue;
    if (entry.flags & 1) throw new InputError("encrypted", `Encrypted entries are not allowed: ${entry.name}`);
    if (entry.method !== 0 && entry.method !== 8) throw new InputError("bad_zip", `Unsupported compression method ${entry.method}: ${entry.name}`);
    if (wanted.has(path)) throw new InputError("duplicate_entry", `Duplicate entry in zip: ${path}`);
    if (entry.size > LIMITS.maxFileBytes) {
      throw new InputError("file_too_large", `${path} is ${(entry.size / 1048576).toFixed(1)} MB uncompressed; the per-file limit is 10 MB.`);
    }
    totalBytes += entry.size;
    if (totalBytes > LIMITS.maxTotalBytes) throw new InputError("too_large", "Archive expands to more than 100 MB.");
    if (wanted.size + 1 > LIMITS.maxFiles) throw new InputError("too_many_files", `Archive has more than ${LIMITS.maxFiles} files.`);
    wanted.set(path, entry);
  }
  const byRaw = new Map<string, string>();
  for (const [path, entry] of wanted) byRaw.set(entry.name, path);
  let inflated: Record<string, Uint8Array>;
  try {
    inflated = unzipSync(data, { filter: (file) => byRaw.has(file.name) });
  } catch (error) {
    throw new InputError("bad_zip", `Could not read the zip: ${error instanceof Error ? error.message : String(error)}`);
  }
  const files: FileMap = new Map();
  for (const [raw, bytes] of Object.entries(inflated)) {
    const path = byRaw.get(raw);
    if (!path) continue;
    if (bytes.length !== wanted.get(path)!.size) throw new InputError("bad_zip", `Size mismatch for ${path}.`);
    files.set(path, bytes);
  }
  return files;
}

function octal(block: Uint8Array, start: number, len: number): number {
  const text = new TextDecoder().decode(block.subarray(start, start + len)).replace(/\0.*$/s, "").trim();
  return text ? parseInt(text, 8) : 0;
}

function cString(block: Uint8Array, start: number, len: number): string {
  const slice = block.subarray(start, start + len);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end < 0 ? slice : slice.subarray(0, end));
}

export interface TarOptions {
  /** Keep only paths for which this returns true (after the top-level directory is stripped). */
  keep?: (path: string) => boolean;
  /** Strip the single top-level directory (GitHub tarballs). */
  stripTopLevel?: boolean;
  maxStoredBytes?: number;
  maxStoredFiles?: number;
  maxScannedBytes?: number;
}

/** Stream-read a .tar.gz (GitHub tarball). Symlinks are skipped, never followed. */
export async function readTarGz(body: ReadableStream<Uint8Array>, options: TarOptions = {}): Promise<FileMap> {
  const maxStoredBytes = options.maxStoredBytes ?? LIMITS.maxTotalBytes;
  const maxStoredFiles = options.maxStoredFiles ?? 5000;
  const maxScanned = options.maxScannedBytes ?? 400 * 1024 * 1024;
  const reader = body.pipeThrough(new DecompressionStream("gzip")).getReader();
  let buffer: Uint8Array = new Uint8Array(0);
  let scanned = 0;
  const pull = async (): Promise<Uint8Array | undefined> => {
    const { done, value } = await reader.read();
    if (done) return undefined;
    scanned += value.length;
    if (scanned > maxScanned) {
      throw new InputError("too_large", "Repository tarball expands beyond the 400 MB scan limit; point `path` at the built output folder.");
    }
    return value;
  };
  const need = async (n: number): Promise<boolean> => {
    while (buffer.length < n) {
      const value = await pull();
      if (!value) return false;
      const merged = new Uint8Array(buffer.length + value.length);
      merged.set(buffer);
      merged.set(value, buffer.length);
      buffer = merged;
    }
    return true;
  };
  /** Drop n bytes without accumulating them. */
  const discard = async (n: number): Promise<void> => {
    let left = n;
    while (left > 0) {
      if (buffer.length === 0) {
        const value = await pull();
        if (!value) return;
        buffer = value;
      }
      const take = Math.min(left, buffer.length);
      buffer = buffer.subarray(take);
      left -= take;
    }
  };
  const files: FileMap = new Map();
  let stored = 0;
  let longName: string | undefined;
  let paxPath: string | undefined;
  for (;;) {
    if (!(await need(512))) break;
    const header = buffer.slice(0, 512);
    if (header.every((b) => b === 0)) break;
    buffer = buffer.subarray(512);
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const padded = Math.ceil(size / 512) * 512;
    let name = cString(header, 0, 100);
    const prefix = cString(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const isFile = type === "0";
    let path = "";
    let keep = false;
    if (isFile) {
      path = longName ?? paxPath ?? name;
      longName = paxPath = undefined;
      if (options.stripTopLevel) {
        const slash = path.indexOf("/");
        path = slash < 0 ? "" : path.slice(slash + 1);
      }
      keep = !!path && !path.split("/").includes("..") && !path.startsWith("/") && (options.keep?.(path) ?? true);
      if (keep && size > LIMITS.maxFileBytes) throw new InputError("file_too_large", `${path} is larger than 10 MB.`);
    }
    if (type === "x" || type === "L" || keep) {
      if (size > 1024 * 1024 && type !== "0") throw new InputError("bad_tar", "Oversized tar metadata block.");
      if (!(await need(padded))) throw new InputError("bad_tar", "Truncated tarball.");
      const content = buffer.subarray(0, size);
      if (type === "x") {
        const match = /\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(content));
        if (match) paxPath = match[1];
      } else if (type === "L") {
        longName = cString(content, 0, content.length);
      } else {
        stored += size;
        if (stored > maxStoredBytes || files.size + 1 > maxStoredFiles) {
          throw new InputError("too_large", "Too many or too large files to check; point `path` at the built output folder.");
        }
        files.set(path, content.slice());
      }
      buffer = buffer.subarray(padded);
    } else {
      if (type !== "0") longName = paxPath = undefined; // symlinks, hardlinks, devices, directories: skipped
      await discard(padded);
    }
  }
  await reader.cancel().catch(() => undefined);
  return files;
}
