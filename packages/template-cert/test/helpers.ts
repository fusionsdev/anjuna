import { deflateRawSync } from "node:zlib";
import type { Source } from "../src/workspace.js";
import { runChecks } from "../src/index.js";
import type { CheckResult, RuleId } from "../src/types.js";

const enc = new TextEncoder();

export function makeSource(files: Record<string, string>, label = "fixture"): Source {
  return { label, files: new Map(Object.entries(files).map(([path, text]) => [path, enc.encode(text)])) };
}

export function validIndex(): string {
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<style>:root{color:#000}</style></head><body>` +
    `<h1><span data-kw>Funding Options</span> | Check Your Options</h1>` +
    `<form method="get" action="/go" data-cta>` +
    `<select name="requested_amount"><option value="350">$350</option><option value="1000">$1,000</option><option value="5000">$5,000</option></select>` +
    `<input name="zip" inputmode="numeric" pattern="[0-9]{5}" maxlength="5" required>` +
    `<button type="submit">Continue</button>` +
    `</form></body></html>`;
}

export function legalPage(title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>Placeholder copy.</p></body></html>`;
}

export function validFiles(): Record<string, string> {
  return {
    "index.html": validIndex(),
    "privacy/index.html": legalPage("Privacy Policy"),
    "terms/index.html": legalPage("Terms of Use"),
    "disclosures/index.html": legalPage("Disclosures"),
    "do-not-sell/index.html": legalPage("Do Not Sell or Share"),
  };
}

export function check(files: Record<string, string>, denyDomains: string[] = []): CheckResult {
  return runChecks(makeSource(files), { denyDomains });
}

export function rulesFailed(result: CheckResult): RuleId[] {
  return result.checks.filter((c) => c.status === "fail").map((c) => c.rule);
}

export function issuesFor(result: CheckResult, rule: RuleId) {
  return result.checks.find((c) => c.rule === rule)?.issues ?? [];
}

// --- minimal ZIP writer (store + deflate), for exercising the archive paths ---

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

export interface ZipFileSpec {
  name: string;
  data?: Uint8Array;
  method?: 0 | 8;
  /** Override the declared uncompressed size (used for the oversized-archive fixture). */
  uncompressedSize?: number;
  /** Unix external attributes (<< 16 = mode). */
  externalAttrs?: number;
  /** version made by; high byte = host OS (3 = Unix). */
  versionMadeBy?: number;
  isDirectory?: boolean;
}

export function buildZip(files: ZipFileSpec[]): Uint8Array {
  const locals: number[][] = [];
  const centrals: number[][] = [];
  let offset = 0;

  for (const f of files) {
    const name = f.isDirectory && !f.name.endsWith("/") ? f.name + "/" : f.name;
    const nameBytes = new TextEncoder().encode(name);
    const raw = f.data ?? new Uint8Array(0);
    const method = f.method ?? 8;
    const compressed = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const uncompressedSize = f.uncompressedSize ?? raw.length;
    const crc = crc32(raw);
    const versionMadeBy = f.versionMadeBy ?? 20;
    const externalAttrs = (f.externalAttrs ?? 0) >>> 0;
    const flags = 0;
    const time = 0;
    const date = 0;

    const local = [
      0x50, 0x4b, 0x03, 0x04,
      ...u16(20), ...u16(flags), ...u16(method), ...u16(time), ...u16(date),
      ...u32(crc), ...u32(compressed.length), ...u32(uncompressedSize),
      ...u16(nameBytes.length), ...u16(0),
      ...Array.from(nameBytes),
      ...Array.from(compressed),
    ];
    locals.push(local);
    const localLen = local.length;

    const central = [
      0x50, 0x4b, 0x01, 0x02,
      ...u16(versionMadeBy), ...u16(20), ...u16(flags), ...u16(method), ...u16(time), ...u16(date),
      ...u32(crc), ...u32(compressed.length), ...u32(uncompressedSize),
      ...u16(nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(externalAttrs), ...u32(offset),
      ...Array.from(nameBytes),
    ];
    centrals.push(central);
    offset += localLen;
  }

  const cdOffset = offset;
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const total = files.length;

  const out: number[] = [];
  for (const l of locals) out.push(...l);
  for (const c of centrals) out.push(...c);
  out.push(
    0x50, 0x4b, 0x05, 0x06,
    ...u16(0), ...u16(0), ...u16(total), ...u16(total),
    ...u32(cdSize), ...u32(cdOffset), ...u16(0),
  );

  return new Uint8Array(out);
}

export function dirEntry(name: string): ZipFileSpec {
  return { name, isDirectory: true, method: 0 };
}