/**
 * Minimal, dependency-free ZIP reader (standard ZIP, no ZIP64). We parse the central directory
 * first — that is where the security decisions (zip-slip, symlink, oversized, encrypted,
 * unsupported method) happen, before any entry is inflated.
 */

import { inflateRawSync } from "node:zlib";
import { TextDecoder } from "node:util";

const utf8 = new TextDecoder("utf-8", { fatal: false });

export interface ZipEntry {
  name: string; // decoded, forward-slash path as written in the archive
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  versionMadeBy: number;
  externalAttrs: number;
  localOffset: number;
  isDirectory: boolean;
  isSymlink: boolean;
}

export class ZipError extends Error {
  readonly code: "not-zip" | "zip64" | "encrypted" | "unsupported-method" | "slip" | "symlink" | "oversized" | "too-many" | "bad-entry";
  constructor(code: ZipError["code"], message: string) {
    super(message);
    this.code = code;
    Object.setPrototypeOf(this, ZipError.prototype);
  }
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;

function u16(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8)) >>> 0;
}
function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

export interface ArchiveLimits {
  /** Hard cap on the total declared uncompressed size (zip-bomb guard). */
  maxUncompressedBytes: number;
  maxEntries: number;
}

const DEFAULT_LIMITS: ArchiveLimits = {
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxEntries: 20_000,
};

function decodeName(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

const UNX_DIR = 0o040000;
const UNX_LNK = 0o120000;

function findEocd(b: Uint8Array): { totalEntries: number; cdOffset: number; cdSize: number } {
  const min = Math.max(0, b.length - 65_557);
  for (let i = b.length - 22; i >= min; i--) {
    if (u32(b, i) === SIG_EOCD) {
      const totalEntries = u16(b, i + 10);
      const cdSize = u32(b, i + 12);
      const cdOffset = u32(b, i + 16);
      if (totalEntries === 0xffff || cdSize === ZIP64_MARKER || cdOffset === ZIP64_MARKER) {
        throw new ZipError("zip64", "ZIP64 archives are not supported.");
      }
      return { totalEntries, cdOffset, cdSize };
    }
  }
  throw new ZipError("not-zip", "Not a ZIP file (end-of-central-directory record not found).");
}

export function parseEntries(bytes: Uint8Array): ZipEntry[] {
  const { totalEntries, cdOffset } = findEocd(bytes);
  if (totalEntries === 0) throw new ZipError("not-zip", "The ZIP archive is empty.");
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (u32(bytes, p) !== SIG_CENTRAL) throw new ZipError("bad-entry", `Central directory entry ${i} is corrupt.`);
    const versionMadeBy = u16(bytes, p + 4);
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const compressedSize = u32(bytes, p + 20);
    const uncompressedSize = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const externalAttrs = u32(bytes, p + 38);
    const localOffset = u32(bytes, p + 42);

    if (
      compressedSize === ZIP64_MARKER ||
      uncompressedSize === ZIP64_MARKER ||
      localOffset === ZIP64_MARKER
    ) {
      throw new ZipError("zip64", "ZIP64 archives are not supported.");
    }

    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
    const name = decodeName(nameBytes);

    const madeByUnix = (versionMadeBy >> 8) === 3;
    const mode = madeByUnix ? ((externalAttrs >>> 16) & 0xffff) : 0;
    const isDirectory = name.endsWith("/") || (madeByUnix && (mode & 0o170000) === UNX_DIR);
    const isSymlink = madeByUnix && (mode & 0o170000) === UNX_LNK;

    entries.push({ name, flags, method, compressedSize, uncompressedSize, versionMadeBy, externalAttrs, localOffset, isDirectory, isSymlink });

    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export interface ExtractedEntry {
  path: string; // normalised posix path relative to the archive root (no leading slash)
  bytes: Uint8Array;
}

/**
 * Parse and unpack a ZIP. Security checks run against central-directory metadata first, then
 * each entry is inflated (bounded by its declared uncompressed size) into memory.
 */
export function extractZip(bytes: Uint8Array, limits: ArchiveLimits = DEFAULT_LIMITS): ExtractedEntry[] {
  const entries = parseEntries(bytes);
  const files: ExtractedEntry[] = [];
  let totalUncompressed = 0;

  for (const e of entries) {
    if (e.isSymlink) throw new ZipError("symlink", `Archive contains a symbolic link: "${e.name}".`);
    if ((e.flags & 0x1) !== 0) throw new ZipError("encrypted", `Archive entry is encrypted: "${e.name}".`);

    // Normalise separators and reject anything that could escape the root.
    const norm = e.name.replace(/\\/g, "/");
    if (norm.startsWith("/")) throw new ZipError("slip", `Archive entry has an absolute path: "${e.name}".`);
    if (/^[a-zA-Z]:/.test(norm)) throw new ZipError("slip", `Archive entry has a drive-letter path: "${e.name}".`);
    if (norm.split("/").includes("..")) throw new ZipError("slip", `Archive entry escapes the root with "..": "${e.name}".`);
    if (e.isDirectory) continue;

    if (e.method !== 0 && e.method !== 8) throw new ZipError("unsupported-method", `Archive entry "${e.name}" uses an unsupported compression method (${e.method}).`);

    totalUncompressed += e.uncompressedSize;
    if (totalUncompressed > limits.maxUncompressedBytes) {
      throw new ZipError("oversized", `Archive expands beyond the ${Math.round(limits.maxUncompressedBytes / 1024 / 1024)} MB safety limit.`);
    }
    if (files.length + 1 > limits.maxEntries) {
      throw new ZipError("too-many", `Archive has more than ${limits.maxEntries} files.`);
    }

    const data = readEntryData(bytes, e);
    files.push({ path: norm, bytes: data });
  }

  if (files.length > limits.maxEntries) throw new ZipError("too-many", `Archive has more than ${limits.maxEntries} files.`);
  return files;
}

function readEntryData(b: Uint8Array, e: ZipEntry): Uint8Array {
  const p = e.localOffset;
  if (u32(b, p) !== SIG_LOCAL) throw new ZipError("bad-entry", `Local header for "${e.name}" is corrupt.`);
  const nameLen = u16(b, p + 26);
  const extraLen = u16(b, p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const compressed = b.subarray(dataStart, dataStart + e.compressedSize);
  if (e.method === 0) return compressed.slice();
  const maxOut = Math.min(e.uncompressedSize + 16, 210 * 1024 * 1024);
  return new Uint8Array(inflateRawSync(compressed, { maxOutputLength: maxOut }));
}