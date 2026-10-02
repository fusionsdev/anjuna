import { V1_JSON_HEADERS } from "@anjuna/contracts";

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: V1_JSON_HEADERS });
}

export const unauthorized = () => json({ status: "invalid", message: "Unauthorized" }, 401);
export const notFound = () => new Response("Not Found", {
  status: 404,
  headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
});
