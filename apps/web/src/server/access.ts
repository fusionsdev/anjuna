/**
 * Cloudflare Access (outer protection, plan decision 3). Every /api/* request must carry a
 * `Cf-Access-Jwt-Assertion` signed by the team's JWKS, issued for this application's AUD.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "./env.js";

export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

const jwksByTeam = new Map<string, JWTVerifyGetKey>();

function jwksFor(teamDomain: string): JWTVerifyGetKey {
  let jwks = jwksByTeam.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksByTeam.set(teamDomain, jwks);
  }
  return jwks;
}

const isPlaceholder = (v: string | undefined): boolean => !v || v.includes("<") || v.includes("REPLACE");

export type AccessResult = { ok: true; email: string | null; bypass: boolean } | { ok: false };

export async function verifyAccess(request: Request, env: Env, localDev: boolean): Promise<AccessResult> {
  if (localDev) return { ok: true, email: null, bypass: true };
  // Fail closed: an unconfigured team domain or AUD accepts nothing.
  if (isPlaceholder(env.ACCESS_TEAM_DOMAIN) || isPlaceholder(env.ACCESS_AUD)) return { ok: false };
  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (!token) return { ok: false };
  try {
    const { payload } = await jwtVerify(token, jwksFor(env.ACCESS_TEAM_DOMAIN), {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
    });
    return { ok: true, email: typeof payload.email === "string" ? payload.email : null, bypass: false };
  } catch {
    return { ok: false };
  }
}
