export interface ZipEntry {
  path: string;
  bytes: Uint8Array;
}
export function crc32(bytes: Uint8Array): number;
export function formZipEntries(files: Iterable<[string, Uint8Array]>): ZipEntry[];
export function storeZip(entries: ZipEntry[]): Uint8Array;
