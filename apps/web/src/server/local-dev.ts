import type { Env } from "./env.js";

const LOOPBACK_IP = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/;

/**
 * The single local-development boundary for Access and better-auth.
 * Cloudflare's edge always sets CF-Connecting-IP to the real client IP (never loopback);
 * local workerd sets nothing or a loopback IP. `wrangler dev` rewrites the host to the
 * configured route, so the BETTER_AUTH_URL host also counts when there is no edge IP.
 */
export function isLocalDev(request: Request, env: Env): boolean {
  if (env.DEV_ACCESS_BYPASS !== "1") return false;
  const ip = request.headers.get("cf-connecting-ip");
  if (ip && !LOOPBACK_IP.test(ip)) return false;
  const host = new URL(request.url).hostname;
  return LOCAL_HOST.test(host) || host === new URL(env.BETTER_AUTH_URL).hostname;
}
