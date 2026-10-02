import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { call, makeEnv, setupDatabases } from "./helpers";

const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-test";
let privateKey: CryptoKey;
let jwk: Record<string, unknown>;

async function token(over: { aud?: string; iss?: string; key?: CryptoKey; exp?: string } = {}): Promise<string> {
  return new SignJWT({ email: "someone@example.test" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(over.iss ?? `https://${TEAM}`)
    .setAudience(over.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(over.exp ?? "5m")
    .sign(over.key ?? privateKey);
}

const strict = () => makeEnv({ DEV_ACCESS_BYPASS: undefined, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD });
const withJwt = (t: string) => ({ "Cf-Access-Jwt-Assertion": t });

beforeAll(async () => {
  await setupDatabases();
  const kp = await generateKeyPair("RS256", { extractable: true });
  privateKey = kp.privateKey;
  jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    return realFetch(input as RequestInfo, init);
  });
});
afterEach(() => undefined);

describe("Cloudflare Access gate on /api/*", () => {
  it("returns 401 when the Access JWT is missing", async () => {
    for (const path of ["/api/brands", "/api/me", "/api/audit", "/api/auth/get-session", "/api/auth/sign-in/email"]) {
      const res = await call(path, { env: strict() });
      expect(res.status, path).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("returns 401 for a malformed, mis-signed, wrong-audience, wrong-issuer or expired JWT", async () => {
    const other = await generateKeyPair("RS256");
    const bad = [
      "not-a-jwt",
      await token({ key: other.privateKey }),
      await token({ aud: "someone-else" }),
      await token({ iss: "https://evil.example" }),
      await token({ exp: "-1m" }),
    ];
    for (const t of bad) {
      expect((await call("/api/brands", { env: strict(), headers: withJwt(t) })).status).toBe(401);
    }
  });

  it("accepts a valid JWT; the request then still needs a better-auth session", async () => {
    const t = await token();
    const noSession = await call("/api/brands", { env: strict(), headers: withJwt(t) });
    expect(noSession.status).toBe(401); // passed Access, failed the session check
    const cookie = await signInWith(t);
    const ok = await call("/api/brands", { env: strict(), headers: withJwt(t), cookie });
    expect(ok.status).toBe(200);
  });

  it("fails closed while ACCESS_TEAM_DOMAIN / ACCESS_AUD are still placeholders", async () => {
    const t = await token();
    const env = makeEnv({ DEV_ACCESS_BYPASS: undefined, ACCESS_TEAM_DOMAIN: "<team>.cloudflareaccess.com", ACCESS_AUD: "<ACCESS_APPLICATION_AUD>" });
    expect((await call("/api/brands", { env, headers: withJwt(t) })).status).toBe(401);
  });

  it("ignores the dev bypass on the production host", async () => {
    const env = makeEnv({ DEV_ACCESS_BYPASS: "1" });
    const res = await call("/api/brands", { env, origin: "https://app.aduplift.ai" });
    expect(res.status).toBe(401);
  });

  it("does not gate the SPA itself, only /api/*", async () => {
    const res = await call("/some/spa/route", { env: strict() });
    expect(res.status).toBe(200);
  });
});

async function signInWith(t: string): Promise<string> {
  const res = await call("/api/auth/sign-in/email", {
    env: strict(),
    headers: withJwt(t),
    method: "POST",
    body: { email: "emp1@example.test", password: "test-password-123" },
  });
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}
