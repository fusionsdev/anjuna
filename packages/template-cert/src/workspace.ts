/**
 * Turns an input (a directory, or a ZIP file) into an in-memory `Source`: a map of posix-relative
 * path -> bytes. The linter reads only from this map, so ZIP contents are never written to disk
 * and directory symlinks cannot escape the root.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { extractZip, ZipError } from "./zip.js";
import type { LoadFailure } from "./types.js";

export interface Source {
  /** Display path / zip name the input came from. */
  label: string;
  /** posix-relative path (e.g. "index.html", "privacy/index.html") -> bytes. */
  files: Map<string, Uint8Array>;
}

export const DIST_LIMITS = {
  /** 30 MB total (T11 brief). */
  maxBytes: 30 * 1024 * 1024,
  /** 2000 files (T11 brief). */
  maxFiles: 2000,
} as const;

export function isZipInput(path: string): boolean {
  return /\.zip$/i.test(path);
}

class SourceError extends Error {}

export function loadSource(input: string): Source | LoadFailure {
  try {
    if (isZipInput(input)) {
      const bytes = new Uint8Array(readFileSync(input));
      const entries = extractZip(bytes);
      const files = new Map<string, Uint8Array>();
      for (const e of entries) files.set(e.path, e.bytes);
      return { label: basename(input), files };
    }
    return loadDirectory(input);
  } catch (err) {
    if (err instanceof ZipError) return zipFailure(err);
    if (err instanceof SourceError) return { message: err.message, messageTh: err.message };
    return { message: err instanceof Error ? err.message : String(err), messageTh: err instanceof Error ? err.message : String(err) };
  }
}

function zipFailure(err: ZipError): LoadFailure {
  const th: Record<ZipError["code"], string> = {
    "not-zip": "ไฟล์นี้ไม่ใช่ไฟล์ ZIP ที่ถูกต้อง ส่งออก template เป็น ZIP ใหม่",
    zip64: "ไม่รองรับ ZIP ในรูปแบบ ZIP64 ส่งออกใหม่โดยไม่ใช่ ZIP64",
    encrypted: "ไฟล์ ZIP ถูกเข้ารหัส กรุณาส่งไฟล์ที่ไม่เข้ารหัส",
    "unsupported-method": "ไฟล์ ZIP ใช้วิธีบีบอัดที่ไม่รองรับ ส่งออกใหม่ด้วย ZIP มาตรฐาน",
    slip: "พบรายการใน ZIP ที่มีพาธลัดออกนอกโฟลเดอร์ (zip-slip) ตรวจสอบต้นทางของไฟล์และส่งออกใหม่",
    symlink: "พบ symbolic link ใน ZIP ซึ่งไม่อนุญาต ใช้ไฟล์จริงแทน symlink",
    oversized: "ZIP นี้ขยายแล้วใหญ่เกินขีดจำกัดความปลอดภัย ตรวจสอบว่าใส่ไฟล์ขนาดใหญ่ผิดหรือเป็น ZIP bomb",
    "too-many": "ZIP นี้มีไฟล์มากเกินไป ตรวจสอบว่ารวมโฟลเดอร์ build ถูกต้อง (dist) ไม่ใช่โฟลเดอร์ต้นทาง",
    "bad-entry": "โครงสร้าง ZIP เสียหาย ส่งออก template ใหม่",
  };
  return { message: err.message, messageTh: th[err.code] ?? err.message };
}

function loadDirectory(root: string): Source {
  if (!existsSync(root)) {
    throw new SourceError(`Path does not exist: ${root}`);
  }
  const files = new Map<string, Uint8Array>();
  walk(root, "", files);
  return { label: basename(root), files };
}

function walk(dir: string, prefix: string, files: Map<string, Uint8Array>): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(full);
      throw new SourceError(`Symbolic links are not allowed in a template dist (${prefix + name} -> ${target}). Use real files instead.`);
    }
    if (st.isDirectory()) {
      walk(full, prefix + name + "/", files);
    } else {
      files.set(prefix + name, new Uint8Array(readFileSync(full)));
    }
  }
}