import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/server/index";
import type { Env } from "../src/server/env";
import { resetMockCore } from "../src/server/mock-core";
import { seedD1, type SeedUser } from "../src/server/seed";

export const ORIGIN = "https://app.test";
export const PASSWORD = "test-password-123";
export const LEAD_ID = "6f1c2b9e-3a4d-4c5e-8f60-7a8b9c0d1e2f";

export const USERS: SeedUser[] = [
  { email: "owner@example.test", name: "Owner", role: "owner", password: PASSWORD },
  { email: "emp1@example.test", name: "Employee 1", role: "employee", password: PASSWORD },
  { email: "emp2@example.test", name: "Employee 2", role: "employee", password: PASSWORD },
];

/** Static assets stand-in: proves what the Worker hands to the ASSETS binding. */
export const assetsFetcher = {
  async fetch(req: Request): Promise<Response> {
    return new Response(`ASSET:${new URL(req.url).pathname}`, { headers: { "content-type": "text/html" } });
  },
} as unknown as Fetcher;

const noCore = {
  async fetch(): Promise<Response> {
    throw new Error("CORE binding must not be called in these tests");
  },
} as unknown as Fetcher;

export function makeEnv(over: Partial<Env> = {}): Env {
  return {
    AUTH: env.AUTH,
    FACTORY: env.FACTORY,
    CORE: noCore,
    ASSETS: assetsFetcher,
    ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    ACCESS_AUD: "aud-test",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
    BETTER_AUTH_URL: ORIGIN,
    MOCK_CORE: "1",
    DEV_ACCESS_BYPASS: "1",
    ...over,
  };
}

export async function setupDatabases(): Promise<void> {
  await applyD1Migrations(env.AUTH, env.AUTH_MIGRATIONS);
  await applyD1Migrations(env.FACTORY, env.FACTORY_MIGRATIONS);
  await seedD1(env.AUTH, USERS);
}

export function resetState(): void {
  resetMockCore();
}

export interface CallOpts {
  cookie?: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  env?: Env;
  origin?: string;
}

export async function call(path: string, opts: CallOpts = {}): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  headers.set("origin", ORIGIN);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return worker.fetch(
    new Request(`${opts.origin ?? ORIGIN}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    opts.env ?? makeEnv(),
  );
}

export async function signIn(email: string, password = PASSWORD): Promise<string> {
  const res = await call("/api/auth/sign-in/email", { method: "POST", body: { email, password } });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

export const sessions = {
  owner: () => signIn("owner@example.test"),
  employee: () => signIn("emp1@example.test"),
  employee2: () => signIn("emp2@example.test"),
};

export async function auditRows(): Promise<{ actor_id: string; actor_role: string; action: string; entity_id: string }[]> {
  const { results } = await env.FACTORY.prepare(
    "SELECT actor_id, actor_role, action, entity_id FROM audit_log ORDER BY id",
  ).all<{ actor_id: string; actor_role: string; action: string; entity_id: string }>();
  return results;
}
