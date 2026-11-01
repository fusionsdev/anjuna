import { beforeAll, describe, expect, it } from "vitest";
import { call, makeEnv, setupDatabases } from "./helpers";

const credentials = { email: "emp1@example.test", password: "test-password-123" };

beforeAll(setupDatabases);

describe("better-auth is the only gate on /api/*", () => {
  it("returns 401 without a session and needs no Access header", async () => {
    const env = makeEnv({ DEV_ACCESS_BYPASS: undefined });
    for (const path of ["/api/brands", "/api/me", "/api/audit"]) {
      const res = await call(path, { env });
      expect(res.status, path).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("signs in with email and password, then serves /api/brands", async () => {
    const env = makeEnv({ DEV_ACCESS_BYPASS: undefined });
    const signIn = await call("/api/auth/sign-in/email", { env, method: "POST", body: credentials });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect((await call("/api/brands", { env, cookie })).status).toBe(200);
  });

  it("rejects a wrong password", async () => {
    const env = makeEnv({ DEV_ACCESS_BYPASS: undefined });
    const res = await call("/api/auth/sign-in/email", { env, method: "POST", body: { ...credentials, password: "wrong-password-1" } });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("does not gate the SPA itself, only /api/*", async () => {
    expect((await call("/some/spa/route", { env: makeEnv({ DEV_ACCESS_BYPASS: undefined }) })).status).toBe(200);
  });

  it.each(["app.maimax.com", "app.aduplift.ai"])("keeps Secure cookies at the edge even with the dev flag set (%s)", async (host) => {
    const origin = `https://${host}`;
    const env = makeEnv({ DEV_ACCESS_BYPASS: "1", BETTER_AUTH_URL: origin });
    const res = await call("/api/auth/sign-in/email", {
      env, origin, method: "POST", body: credentials,
      headers: { "CF-Connecting-IP": "203.0.113.8", origin },
    });
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(cookie.split(";").slice(1).map((attribute) => attribute.trim().toLowerCase())).toContain("secure");
    }
  });

  it.each(["app.maimax.com", "app.aduplift.ai"])("rejects local HTTP origins at the edge even with the dev flag set (%s)", async (host) => {
    const origin = `https://${host}`;
    const env = makeEnv({ DEV_ACCESS_BYPASS: "1", BETTER_AUTH_URL: origin });
    const res = await call("/api/auth/sign-in/email", {
      env, origin, method: "POST", body: credentials,
      headers: { "CF-Connecting-IP": "203.0.113.8", origin: `http://${host}` },
    });
    expect(res.status).toBe(403);
  });
});
