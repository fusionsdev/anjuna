/** Template submit pipeline (Task 5). This task adds the deterministic zip and framework detection. */
import { zipSync } from "fflate";
import type { FileMap } from "./archive";

const FIXED_MTIME = new Date(2000, 0, 1, 0, 0, 0);

/** Same files give the same bytes and the same SHA-256: sorted paths, fixed timestamps, fixed compression level. */
export function assembleZip(files: FileMap): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const path of [...files.keys()].sort()) entries[path] = files.get(path)!;
  return zipSync(entries, { level: 6, mtime: FIXED_MTIME });
}

/** templates.framework for a build: Astro and Next export leave their folders; everything else is a Vite/React build. */
export function detectFramework(files: FileMap): "astro" | "next_export" | "react_spa" {
  const paths = [...files.keys()];
  if (paths.some((path) => path.startsWith("_astro/"))) return "astro";
  if (paths.some((path) => path.startsWith("_next/"))) return "next_export";
  return "react_spa";
}
