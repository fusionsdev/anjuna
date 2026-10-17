/**
 * Diagnostics kept from the bolt.new spike: how large one tool argument can be, and how a published site
 * URL behaves (redirects, status, empty JavaScript shell). Page JavaScript is never run.
 */
import { allElements, parseHtml, visibleText } from "./html";
import { assertPublicHttpsUrl } from "./input";

export function measurePayload(text: string): { received_chars: number; received_bytes: number } {
  return { received_chars: text.length, received_bytes: new TextEncoder().encode(text).length };
}

/** Visible body text (script, style and noscript excluded). Empty means a client-rendered shell. */
export function visibleBodyText(html: string): string {
  const doc = parseHtml(html);
  const body = allElements(doc).find((el) => el.name === "body");
  return visibleText(body ?? doc);
}

export interface UrlHop {
  url: string;
  status: number;
  location: string | null;
}

export interface UrlProbe {
  hops: UrlHop[];
  final_url: string;
  status: number;
  content_type: string;
  html_bytes: number;
  visible_text_chars: number;
  /** First 500 visible characters. */
  visible_text: string;
  client_rendered: boolean;
  ok: boolean;
}

/** The first request plus 3 redirects: the same limit the crawler applies. */
const MAX_HOPS = 4;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const VISIBLE_TEXT_PREVIEW_CHARS = 500;
const PROBE_TIMEOUT_MS = 20_000;

/** Reads at most `max` bytes and cancels the stream after that. */
async function readUpTo(response: Response, max: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel();
  const out = new Uint8Array(Math.min(total, max));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, out.length - offset);
    if (take <= 0) break;
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

export async function probePublishedUrl(raw: string): Promise<UrlProbe> {
  let url = assertPublicHttpsUrl(raw);
  const hops: UrlHop[] = [];
  for (;;) {
    const response = await fetch(url.toString(), { redirect: "manual", headers: { "user-agent": "anjuna-template-mcp/1" }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const location = response.headers.get("location");
    hops.push({ url: url.toString(), status: response.status, location });
    if (response.status >= 300 && response.status < 400 && location && hops.length < MAX_HOPS) {
      await response.body?.cancel();
      url = assertPublicHttpsUrl(new URL(location, url).toString());
      continue;
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const body = await readUpTo(response, MAX_HTML_BYTES);
    const html = contentType.includes("html") ? new TextDecoder().decode(body) : "";
    const visible = html ? visibleBodyText(html) : "";
    const isHtml = response.ok && contentType.includes("html");
    return {
      hops, final_url: url.toString(), status: response.status, content_type: contentType, html_bytes: body.length,
      visible_text_chars: visible.length, visible_text: visible.slice(0, VISIBLE_TEXT_PREVIEW_CHARS),
      client_rendered: isHtml && visible.length === 0, ok: isHtml && visible.length > 0,
    };
  }
}
