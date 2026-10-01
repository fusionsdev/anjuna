export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}
export interface Manifest {
  artifact: "form";
  version: string;
  base: "/_f/";
  files: ManifestFile[];
  bundle_sha256: string;
}
export function sha256(buf: Buffer | string): string;
export function buildManifest(dir: string, version: string): Manifest;
