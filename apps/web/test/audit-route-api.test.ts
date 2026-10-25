import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditListResponse } from "@anjuna/contracts";
import { decodeAuditCursor, encodeAuditCursor } from "../src/server/audit-route";
import { mockCoreFetch } from "../src/server/mock-core";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;
let employeeId: string;

beforeAll(async () => {
  await setupDatabases();
});

const SEED = "seed-actor";
const userId = async (cookie: string): Promise<string> => ((await (await call("/api/me", { cookie })).json()) as { user: { id: string } }).user.id;

const coreEntry = (id: number, actor: string, action: string, type = "brand", target = "brand-a") =>
  ({ id, actor_id: actor, actor_role: "owner", action, target: { type, id: target }, old: null, new: null, at: "2026-10-21T00:00:00.000Z" });

const localRow = (id: number, actor: string, action: string, type = "user", target = "u1") =>
  env.FACTORY.prepare("INSERT OR IGNORE INTO audit_log (id,actor_id,actor_role,action,entity_type,entity_id,created_at) VALUES (?1,?2,'owner',?3,?4,?5,'2026-10-21T00:00:00.000Z')").bind(id, actor, action, type, target);

/** Core rows 1000006, 1000004, 1000002 and local rows 1000005, 1000003, 1000001, interleaved by id. */
const seedRows = () => [
  coreEntry(1000006, SEED, "brand.update"),
  coreEntry(1000004, SEED, "brand.pause"),
  coreEntry(1000002, SEED, "brand.resume"),
];

/** A CORE binding whose listAudit honours cursor, limit and the filters like real core and sends every other endpoint to the mock core. */
function coreEnv(rows: ReturnType<typeof seedRows>) {
  const core = { fetch: async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/admin/audit") return mockCoreFetch(request);
    const q = url.searchParams;
    const before = q.get("cursor") ? decodeAuditCursor(q.get("cursor")!) : null;
    const limit = Number(q.get("limit") ?? 50);
    const matched = [...rows]
      .sort((a, b) => b.id - a.id)
      .filter((e) => (before === null || e.id < before) && (!q.get("actor_id") || e.actor_id === q.get("actor_id")) && (!q.get("target_type") || e.target.type === q.get("target_type")));
    const page = matched.slice(0, limit);
    return Response.json({ entries: page, next_cursor: matched.length > limit ? encodeAuditCursor(page[page.length - 1]!.id) : null });
  } } as unknown as Fetcher;
  return makeEnv({ MOCK_CORE: undefined, CORE: core });
}

const audit = async (query: string, cookie: string, testEnv = coreEnv(seedRows())) => {
  const response = await call(`/api/audit?${query}`, { cookie, env: testEnv });
  expect(response.status).toBe(200);
  return AuditListResponse.parse(await response.json());
};
const ids = (body: AuditListResponse) => body.entries.map((e) => e.id);

beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
  employeeId = await userId(employee);
  await env.FACTORY.batch([
    localRow(1000005, SEED, "user.create"),
    localRow(1000003, SEED, "user.set_role"),
    localRow(1000001, SEED, "brand.create", "brand", "brand-a"),
    localRow(1000010, employeeId, "user.set_role"),
    localRow(1000008, "someone-else", "user.set_role"),
  ]);
});

describe("GET /api/audit paging", () => {
  it("pages through core and panel rows with no gap and no duplicate", async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    const pages: AuditListResponse[] = [];
    do {
      const page: AuditListResponse = await audit(`actor_id=${SEED}&limit=2${cursor ? `&cursor=${cursor}` : ""}`, owner);
      pages.push(page);
      seen.push(...ids(page));
      cursor = page.next_cursor;
    } while (cursor && pages.length < 10);
    expect(pages.map(ids)).toEqual([[1000006, 1000005], [1000004, 1000003], [1000002, 1000001]]);
    expect(seen).toEqual([1000006, 1000005, 1000004, 1000003, 1000002, 1000001]);
  });

  it("page 2 still includes panel user rows", async () => {
    const first = await audit(`actor_id=${SEED}&limit=2`, owner);
    const second = await audit(`actor_id=${SEED}&limit=2&cursor=${first.next_cursor}`, owner);
    expect(second.entries.map((e) => [e.id, e.action])).toContainEqual([1000003, "user.set_role"]);
  });

  it("a bad cursor answers 422 invalid", async () => {
    // "MA" decodes to "0", which is not a row id.
    const response = await call(`/api/audit?cursor=MA`, { cookie: owner, env: coreEnv(seedRows()) });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid", issues: [{ path: "cursor" }] });
  });

  it("an employee pages only their own rows", async () => {
    const rows = [coreEntry(1000009, employeeId, "brand.update"), coreEntry(1000007, "someone-else", "brand.update"), coreEntry(1000004, employeeId, "brand.pause")];
    const testEnv = coreEnv(rows);
    // Sign-in rows of this employee sit among the seeded ones, so walk every page.
    const entries: AuditListResponse["entries"] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page: AuditListResponse = await audit(`limit=2${cursor ? `&cursor=${cursor}` : ""}`, employee, testEnv);
      entries.push(...page.entries);
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    expect(entries.filter((e) => [1000010, 1000009, 1000008, 1000007, 1000004].includes(e.id)).map((e) => e.id)).toEqual([1000010, 1000009, 1000004]);
    expect(entries.every((e) => e.actor_id === employeeId)).toBe(true);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  });

  it("target_type brand skips panel rows on every page", async () => {
    const first = await audit(`actor_id=${SEED}&target_type=brand&limit=2`, owner);
    const second = await audit(`actor_id=${SEED}&target_type=brand&limit=2&cursor=${first.next_cursor}`, owner);
    expect(ids(first)).toEqual([1000006, 1000004]);
    expect(ids(second)).toEqual([1000002]);
  });

  it("the last page has next_cursor null", async () => {
    const all = await audit(`actor_id=${SEED}&limit=6`, owner);
    expect(ids(all)).toEqual([1000006, 1000005, 1000004, 1000003, 1000002, 1000001]);
    expect(all.next_cursor).toBeNull();
    const last = await audit(`actor_id=${SEED}&limit=2&cursor=${encodeAuditCursor(1000003)}`, owner);
    expect(ids(last)).toEqual([1000002, 1000001]);
    expect(last.next_cursor).toBeNull();
  });

  it("the cursor round trips the core format", () => {
    expect(encodeAuditCursor(1000005)).toBe(btoa("1000005").replace(/=+$/, ""));
    expect(decodeAuditCursor(encodeAuditCursor(1000005))).toBe(1000005);
    expect(decodeAuditCursor("MA")).toBeNull();
    expect(decodeAuditCursor("%%%")).toBeNull();
  });
});

describe("mock core listAudit", () => {
  it("honours limit and cursor and returns a real next_cursor", async () => {
    // Fixture rows: 103 and 101 by usr_emp_01, 102 by usr_owner_01.
    const page1 = AuditListResponse.parse(await (await call("/api/audit?actor_id=usr_emp_01&limit=1", { cookie: owner })).json());
    expect(ids(page1)).toEqual([103]);
    expect(page1.next_cursor).not.toBeNull();
    const page2 = AuditListResponse.parse(await (await call(`/api/audit?actor_id=usr_emp_01&limit=1&cursor=${page1.next_cursor}`, { cookie: owner })).json());
    expect(ids(page2)).toEqual([101]);
    expect(page2.next_cursor).toBeNull();
  });
});
