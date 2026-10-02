export const COOKIE_TTL = 30 * 24 * 60 * 60;

export function readCookie(request: Request, name: string): string | null {
  const pair = (request.headers.get("cookie") ?? "").split(";")
    .map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!pair) return null;
  try { return decodeURIComponent(pair.slice(name.length + 1)); } catch { return null; }
}

export function cookie(name: string, value: string, maxAge = COOKIE_TTL): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location, "cache-control": "no-store" } });
}

export function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: {
    "content-type": "text/plain; charset=utf-8", "cache-control": "no-store",
  } });
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

export class PayloadTooLarge extends Error {}

/** Enforce the cap on bytes actually read, including chunked/lying Content-Length requests. */
export async function readCappedBody(request: Request, limit: number): Promise<string> {
  if (Number(request.headers.get("content-length")) > limit) throw new PayloadTooLarge();
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) {
        void reader.cancel().catch(() => {});
        throw new PayloadTooLarge();
      }
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
