import { AddSuppressionResponse, AdminError, RemoveSuppressionResponse, SuppressionsResponse } from "@anjuna/contracts";
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

  it("answers 422 with a fixed message and no key name when an unknown parameter name is an email", async () => {
    const { seen, env } = fakeCore(() => suppressionsList);
    const email = "leaky.person@example.com";
    const res = await call(`/api/suppressions?${encodeURIComponent(email)}=1`, { cookie: owner, env });
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: "invalid", issues: [{ message: "Unrecognized query parameter" }] });
    expect(text).not.toContain(email);
    expect(text).not.toContain("leaky");
    expect(seen).toHaveLength(0);
  });

  it("answers only GET and the two POST routes", async () => {
    const { seen, env } = fakeCore(() => suppressionsList);
    for (const opts of [
      { method: "PUT", body: {} },
      { method: "DELETE", body: undefined },
      { method: "PATCH", body: {} },
    ] as const) {
      const res = await call("/api/suppressions", { cookie: owner, env, ...opts });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: "not_found", resource: "route" });
    }
    // the remove path answers no method other than POST, and unknown paths answer 404
    expect((await call("/api/suppressions/remove", { cookie: owner, env })).status).toBe(404);
    expect((await call("/api/suppressions/unknown", { cookie: owner, env, method: "POST", body: {} })).status).toBe(404);
    expect(seen).toHaveLength(0);
  });
});

/** A stand-in CORE binding for the writes: records method, path and body, answers per endpoint. */
function fakeCoreWrites() {
  const seen: { method: string; pathname: string; search: string; body: unknown }[] = [];
  const fetcher = {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      seen.push({ method: req.method, pathname: url.pathname, search: url.search, body: await req.json().catch(() => null) });
      if (url.pathname === "/admin/suppressions/remove") return Response.json({ removed: true });
      return Response.json(
        {
          email: "new.person@example.com",
          reason: "manual",
          source: "manual",
          added_by: "usr_owner_01",
          created_at: "2026-10-25T08:00:00.000Z",
          updated_at: null,
        },
        { status: 201 },
      );
    },
  } as unknown as Fetcher;
  return { seen, env: makeEnv({ MOCK_CORE: "0", CORE: fetcher }) };
}

describe("suppressions writes through the panel (FUS-382)", () => {
  it("an owner adds a suppression through the panel", async () => {
    const { seen, env } = fakeCoreWrites();
    const res = await call("/api/suppressions", {
      cookie: owner,
      env,
      method: "POST",
      body: { email: "New.Person@Example.com", reason: "complaint" },
    });
    expect(res.status).toBe(201);
    expect(AddSuppressionResponse.parse(await res.json())).toMatchObject({
      email: "new.person@example.com",
      reason: "manual",
      source: "manual",
    });
    // the address travels in the body: the core URL holds no query string
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      pathname: "/admin/suppressions",
      search: "",
      body: { email: "new.person@example.com", reason: "complaint" },
    });
  });

  it("an owner removes a suppression through the panel", async () => {
    const { seen, env } = fakeCoreWrites();
    const res = await call("/api/suppressions/remove", {
      cookie: owner,
      env,
      method: "POST",
      body: { email: "Bounced.Person@Example.com" },
    });
    expect(res.status).toBe(200);
    expect(RemoveSuppressionResponse.parse(await res.json())).toEqual({ removed: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      pathname: "/admin/suppressions/remove",
      search: "",
      body: { email: "bounced.person@example.com" },
    });
  });

  it("an employee gets 403 on add and remove", async () => {
    const { seen, env } = fakeCoreWrites();
    for (const path of ["/api/suppressions", "/api/suppressions/remove"]) {
      const res = await call(path, { cookie: employee, env, method: "POST", body: { email: "someone@example.com" } });
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(AdminError.parse(JSON.parse(text))).toMatchObject({ error: "forbidden_role", required_role: "owner" });
      expect(text).not.toContain("someone@example.com");
    }
    expect(seen).toHaveLength(0);
  });

  it("an invalid email answers 422 before core is called", async () => {
    const { seen, env } = fakeCoreWrites();
    const bad = await call("/api/suppressions", { cookie: owner, env, method: "POST", body: { email: "not-an-email" } });
    expect(bad.status).toBe(422);
    expect(JSON.parse(await bad.text())).toMatchObject({ error: "invalid", issues: [expect.objectContaining({ path: "email" })] });

    // a valid email with a bad reason is still 422, and the error body never echoes the address
    const address = "leaky.person@example.com";
    const badReason = await call("/api/suppressions", { cookie: owner, env, method: "POST", body: { email: address, reason: "bogus" } });
    expect(badReason.status).toBe(422);
    const badReasonText = await badReason.text();
    expect(badReasonText).not.toContain(address);
    expect(badReasonText).not.toContain("leaky");

    const badRemove = await call("/api/suppressions/remove", { cookie: owner, env, method: "POST", body: { email: "also-bad" } });
    expect(badRemove.status).toBe(422);
    expect(seen).toHaveLength(0);
  });

  it("GET passes added_by to core", async () => {
    const { seen, env } = fakeCore(() => suppressionsList);
    for (const addedBy of ["system", "usr_owner_01"]) {
      const res = await call(`/api/suppressions?added_by=${addedBy}`, { cookie: owner, env });
      expect(res.status).toBe(200);
    }
    expect(seen).toHaveLength(2);
    expect(seen.map((u) => u.searchParams.get("added_by"))).toEqual(["system", "usr_owner_01"]);
  });

  it("mock core adds, conflicts, filters by added_by, and removes", async () => {
    // default env: the panel proxy talks to the in-memory mock core
    const fresh = "fresh.person@example.com";
    const added = await call("/api/suppressions", { cookie: owner, method: "POST", body: { email: fresh } });
    expect(added.status).toBe(201);
    const row = AddSuppressionResponse.parse(await added.json());
    expect(row).toMatchObject({ email: fresh, reason: "manual", source: "manual" });
    expect(typeof row.added_by).toBe("string");

    // a fixture address is already suppressed
    const conflict = await call("/api/suppressions", { cookie: owner, method: "POST", body: { email: "bounced.person@example.com" } });
    expect(conflict.status).toBe(409);
    expect(AdminError.parse(await conflict.json())).toMatchObject({ error: "conflict" });

    // added_by=system holds only the sync rows; a user id holds only their manual rows
    const system = await call("/api/suppressions?added_by=system", { cookie: owner });
    expect(system.status).toBe(200);
    const systemBody = SuppressionsResponse.parse(await system.json());
    expect(systemBody.rows.length).toBeGreaterThan(0);
    for (const r of systemBody.rows) expect(r.added_by).toBeNull();
    expect(systemBody.rows.map((r) => r.email)).toContain("bounced.person@example.com");

    const mine = await call(`/api/suppressions?added_by=${encodeURIComponent(row.added_by!)}`, { cookie: owner });
    expect(SuppressionsResponse.parse(await mine.json()).rows.map((r) => r.email)).toContain(fresh);

    // an unknown address removes with 404, a known one with 200
    expect((await call("/api/suppressions/remove", { cookie: owner, method: "POST", body: { email: "nobody@example.com" } })).status).toBe(404);
    const removed = await call("/api/suppressions/remove", { cookie: owner, method: "POST", body: { email: fresh } });
    expect(removed.status).toBe(200);
    expect(RemoveSuppressionResponse.parse(await removed.json())).toEqual({ removed: true });
    const after = SuppressionsResponse.parse(await (await call("/api/suppressions", { cookie: owner })).json());
    expect(after.rows.map((r) => r.email)).not.toContain(fresh);
  });
});
