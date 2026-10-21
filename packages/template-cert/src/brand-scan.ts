/**
 * The identity scan of the template linter for files that are not a whole template (a brand's logo or favicon).
 * It runs the same `brand` check as certification: platform names, analytics keys and DSNs, and the names, ids
 * and domains of other brands, in the bytes and in the file name. Browser-safe: no filesystem access.
 */
import { brand } from "./checks/brand.js";

export interface BrandScanInput {
  /** File name as uploaded; it is scanned too. */
  name: string;
  bytes: Uint8Array;
  denyDomains: readonly string[];
  denyIdentifiers: readonly string[];
}

/** English messages of every finding. Empty means the file is clean. */
export function scanBrandFile(input: BrandScanInput): string[] {
  return brand({
    source: { label: input.name, files: new Map([[input.name, input.bytes]]) },
    denyDomains: [...input.denyDomains],
    denyIdentifiers: [...input.denyIdentifiers],
  }).map((issue) => issue.en);
}
