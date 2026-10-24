import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BrandConfig, type BrandSummary } from "@anjuna/contracts";
import brandFixture from "@anjuna/contracts/fixtures/admin/brand.get.response.json";
import { SettingsBrandsResponse } from "../src/shared/settings";
import { buildSettingsRows } from "../src/server/settings";
import { call, resetState, sessions, setupDatabases } from "./helpers";

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

const base = BrandConfig.parse(brandFixture.brand);
const brandFor = (id: string): BrandConfig => ({ ...base, brand_id: id, hostnames: [`${id}.test`] });
const summaries = (ids: string[]): Pick<BrandSummary, "brand_id" | "hostnames">[] =>
  ids.map((id) => ({ brand_id: id, hostnames: [`${id}.test`] }));

describe("GET /api/settings/brands", () => {
  it("an owner gets one parsed row per core brand, sorted by domain", async () => {
    const res = await call("/api/settings/brands", { cookie: owner });
    expect(res.status).toBe(200);
    const body = SettingsBrandsResponse.parse(await res.json());
    const listed = ((await (await call("/api/brands", { cookie: owner })).json()) as { brands: unknown[] }).brands;
    expect(body.rows).toHaveLength(listed.length);
    expect(body.rows.every((r) => r.error === null && r.brand !== null)).toBe(true);
    const hosts = body.rows.map((r) => r.hostname);
    expect(hosts).toEqual([...hosts].sort((a, b) => a.localeCompare(b)));
  });

  it("an employee gets 403 forbidden_role owner", async () => {
    const res = await call("/api/settings/brands", { cookie: employee });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden_role", required_role: "owner" });
  });
});

describe("buildSettingsRows", () => {
  it("turns one failed getBrand into an error row and keeps the rest", async () => {
    const rows = await buildSettingsRows(summaries(["c", "b", "a"]), async (id) =>
      id === "b" ? { status: 502, body: { error: "bad_gateway" } } : { status: 200, body: { brand: brandFor(id) } });
    expect(rows.map((r) => r.hostname)).toEqual(["a.test", "b.test", "c.test"]);
    expect(rows.map((r) => r.error)).toEqual([null, "unavailable", null]);
    expect(rows[1]).toEqual({ brand_id: "b", hostname: "b.test", brand: null, error: "unavailable" });
    expect(rows[0]!.brand?.brand_id).toBe("a");
  });

  it("never has more than `limit` getBrand calls in flight", async () => {
    let inFlight = 0;
    let max = 0;
    const ids = Array.from({ length: 10 }, (_, i) => `brand-${i}`);
    const rows = await buildSettingsRows(summaries(ids), async (id) => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { status: 200, body: { brand: brandFor(id) } };
    }, 3);
    expect(rows).toHaveLength(10);
    expect(max).toBe(3);
  });

  it("treats a thrown getBrand as an error row", async () => {
    const rows = await buildSettingsRows(summaries(["b", "a"]), async (id) => {
      if (id === "a") throw new Error("boom");
      return { status: 200, body: { brand: brandFor(id) } };
    });
    expect(rows.map((r) => [r.hostname, r.error])).toEqual([["a.test", "unavailable"], ["b.test", null]]);
  });

  it("treats a 200 body that is not a BrandConfig as an error row", async () => {
    const rows = await buildSettingsRows(summaries(["a"]), async () => ({ status: 200, body: { brand: { nope: true } } }));
    expect(rows).toEqual([{ brand_id: "a", hostname: "a.test", brand: null, error: "unavailable" }]);
  });
});
