import { AdminError, SuppressionsResponse } from "@anjuna/contracts";
import suppressionsList from "@anjuna/contracts/fixtures/admin/suppressions.list.response.json";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;

beforeAll(async () => {
  await setupDatabases();
});
beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
});

const EMAILS = suppressionsList.rows.map((r) => r.email);

/** A stand-in CORE binding: records each request and answers with `reply`. */
function fakeCore(reply: (url: URL) => unknown) {
  const seen: URL[] = [];
  const fetcher = {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      seen.push(url);
      return Response.json(reply(url));
    },
  } as unknown as Fetcher;
  return { seen, env: makeEnv({ MOCK_CORE: "0", CORE: fetcher }) };
}

describe("suppressions route (FUS-376)", () => {
  it("is 403 forbidden_role for an employee and 200 for an owner", async () => {
    // The stand-in core would answer with every email: the panel gate must answer on its own.
    const gate = fakeCore(() => suppressionsList);
    const denied = await call("/api/suppressions", { cookie: employee, env: gate.env });
    expect(denied.status).toBe(403);
    const deniedText = await denied.text();
    expect(AdminError.parse(JSON.parse(deniedText))).toMatchObject({ error: "forbidden_role", required_role: "owner" });
    for (const email of EMAILS) expect(deniedText).not.toContain(email);

    // the role gate answers before validation: an employee learns nothing about a bad reason
    const badReason = await call("/api/suppressions?reason=bogus&q=bounced.person", { cookie: employee, env: gate.env });
    expect(badReason.status).toBe(403);
    const badText = await badReason.text();
    expect(AdminError.parse(JSON.parse(badText))).toMatchObject({ error: "forbidden_role", required_role: "owner" });
    expect(badText).not.toContain("bounced.person");
    expect(gate.seen).toHaveLength(0);

    const allowed = await call("/api/suppressions", { cookie: owner });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
    const ownerText = await allowed.text();
    expect(SuppressionsResponse.parse(JSON.parse(ownerText)).rows).toHaveLength(2);
    for (const email of EMAILS) expect(ownerText).toContain(email);
  });

  it("passes q, reason, source, limit and cursor through to core", async () => {
    const { seen, env } = fakeCore(() => suppressionsList);
    const res = await call(
      "/api/suppressions?q=Bounced.Person&reason=bounce&source=ses&limit=10&cursor=Y29tcGxhaW5lckBleGFtcGxlLmNvbQ",
      { cookie: owner, env },
    );
    expect(res.status).toBe(200);
    const body = SuppressionsResponse.parse(await res.json());
    expect(body.rows.map((r) => r.email)).toEqual(EMAILS);
    expect(body.next_cursor).toBe(suppressionsList.next_cursor);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.pathname).toBe("/admin/suppressions");
    // core lowercases q itself; the panel sends it as typed
    expect(Object.fromEntries(seen[0]!.searchParams)).toEqual({
      q: "Bounced.Person",
      reason: "bounce",
      source: "ses",
      limit: "10",
      cursor: "Y29tcGxhaW5lckBleGFtcGxlLmNvbQ",
    });
  });

  it("answers 401 without a session and 422 on an unknown reason", async () => {
    const { seen, env } = fakeCore(() => suppressionsList);
    expect((await call("/api/suppressions", { env })).status).toBe(401);

    const q = "needle.person@example.com";
    const bad = await call(`/api/suppressions?q=${encodeURIComponent(q)}&reason=bogus`, { cookie: owner, env });
    expect(bad.status).toBe(422);
    const badText = await bad.text();
    expect(JSON.parse(badText)).toMatchObject({ error: "invalid", issues: [expect.objectContaining({ path: "reason" })] });
    // an error body never echoes the search or an email
    expect(badText).not.toContain("needle");
    for (const email of EMAILS) expect(badText).not.toContain(email);

    const long = `${"a".repeat(250)}@x.com`;
    const tooLong = await call(`/api/suppressions?q=${long}`, { cookie: owner, env });
    expect(tooLong.status).toBe(422);
    expect(await tooLong.text()).not.toContain("aaaaaaaa");
    expect(seen).toHaveLength(0); // neither the 401 nor a 422 reaches core
  });

  it("does not answer a method other than GET", async () => {
    const { seen, env } = fakeCore(() => suppressionsList);
    const res = await call("/api/suppressions", { cookie: owner, env, method: "POST", body: {} });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found", resource: "route" });
    expect(seen).toHaveLength(0);
  });
});
