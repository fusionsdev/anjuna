// Deterministic ZIP writer for the form artifact the factory reads (workers/factory/src/render.ts).
//
// Pure on purpose: no node imports, so the factory tests can run the same code inside workerd.
// Entries are STORED (no compression) with a fixed DOS timestamp and sorted by path, so one dist
// always yields the same bytes and the same SHA-256, whatever zlib version the runner has.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// 1980-01-01 00:00:00 in DOS format.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/**
 * Map the dist-relative file paths of the form build to the paths the factory expects inside the
 * ZIP. The factory renames only entries that start with "/_f/assets/", with the leading slash
 * (render.ts renderBrand), so every entry is "/_f/<dist path>".
 */
export function formZipEntries(files) {
  const entries = [];
  const seen = new Set();
  for (const [path, bytes] of files) {
    if (path === "" || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`form zip: unsafe dist path ${JSON.stringify(path)}`);
    }
    if (seen.has(path)) throw new Error(`form zip: duplicate dist path ${path}`);
    seen.add(path);
    entries.push({ path: `/_f/${path}`, bytes });
  }
  return entries;
}

/** Build a ZIP of stored entries. `entries` is [{ path, bytes }]; the output order is by path. */
export function storeZip(entries) {
  const encoder = new TextEncoder();
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (sorted.length === 0) throw new Error("form zip: no entries");
  if (sorted.length > 0xffff) throw new Error("form zip: too many entries");
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { path, bytes } of sorted) {
    const name = encoder.encode(path);
    if (bytes.length > 0xfffffff) throw new Error(`form zip: ${path} is too large`);
    const crc = crc32(bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 10, true); // version needed: stored
    local.setUint16(6, 0, true); // flags
    local.setUint16(8, 0, true); // method: stored
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true); // extra length
    chunks.push(new Uint8Array(local.buffer), name, bytes);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true); // version made by
    entry.setUint16(6, 10, true); // version needed
    entry.setUint16(8, 0, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, DOS_TIME, true);
    entry.setUint16(14, DOS_DATE, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, bytes.length, true);
    entry.setUint32(24, bytes.length, true);
    entry.setUint16(28, name.length, true);
    // extra, comment, disk, internal and external attributes stay 0
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + bytes.length;
  }
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, sorted.length, true);
  end.setUint16(10, sorted.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
