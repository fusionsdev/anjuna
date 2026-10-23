import { AdminError, TrafficRiskResponse } from "@anjuna/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { csvRows } from "../src/server/csv";
import { csvCell, riskCsv } from "../src/server/traffic-risk";
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

describe("GET /api/traffic/risk (FUS-372)", () => {
  it("returns signals, domains and 24 hours to an employee", async () => {
    const res = await call("/api/traffic/risk?period=7d", { cookie: employee });
    expect(res.status).toBe(200);
    const body = TrafficRiskResponse.parse(await res.json());
    expect(Object.keys(body).sort()).toEqual(["domains", "hours", "signals"]);
    expect(body.signals.map((s) => [s.id, s.weight])).toEqual([["known_bot_ua", 50], ["timezone_geo_mismatch", 20], ["rapid_repeat_session", 30]]);
    expect(body.domains[0]).toEqual({ hostname: "brand-a.example", visits: 100, high_risk: 15 });
    expect(body.hours).toHaveLength(24);
  });

  it("rejects an unknown period and an anonymous caller", async () => {
    expect((await call("/api/traffic/risk?period=90d", { cookie: employee })).status).toBe(422);
    expect((await call("/api/traffic/risk?period=7d")).status).toBe(401);
  });
});

describe("GET /api/traffic/risk/export (FUS-372)", () => {
  it("downloads a CSV of gclid, hostname, score, signals, created_at for the owner", async () => {
    const res = await call("/api/traffic/risk/export?period=7d", { cookie: owner });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="click-risk-7d.csv"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe([
      "gclid,hostname,score,signals,created_at",
      "Cj0KCQjw-test-gclid-1,brand-a.example,70,known_bot_ua;timezone_geo_mismatch,2026-10-01T03:10:00.000Z",
      ",brand-a.example,50,known_bot_ua,2026-10-01T02:55:00.000Z",
      "",
    ].join("\r\n"));
  });

  it("filters by hostname and names the file after it", async () => {
    const res = await call("/api/traffic/risk/export?period=30d&hostname=brand-b.example", { cookie: owner });
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="click-risk-30d-brand-b.example.csv"');
    expect(await res.text()).toBe("gclid,hostname,score,signals,created_at\r\n");
  });

  it("is owner only", async () => {
    const res = await call("/api/traffic/risk/export?period=7d", { cookie: employee });
    expect(res.status).toBe(403);
    expect(AdminError.parse(await res.json())).toMatchObject({ error: "forbidden_role", required_role: "owner" });
  });

  it("rejects a hostname that is not a hostname", async () => {
    const res = await call("/api/traffic/risk/export?period=7d&hostname=a%22b", { cookie: owner });
    expect(res.status).toBe(422);
  });
});

describe("CSV cells", () => {
  it("neutralises spreadsheet formulas and quotes separators", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe("");
    expect(csvCell(50)).toBe("50");
    expect(riskCsv({ rows: [], truncated: false })).toBe("gclid,hostname,score,signals,created_at\r\n");
  });

  it("guards a formula, a quote and a CRLF in one cell", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("-Smith")).toBe("'-Smith");
    expect(csvCell("@SUM(1)")).toBe("'@SUM(1)");
    expect(csvCell("\tcmd")).toBe("'\tcmd");
    expect(csvCell("\rcmd")).toBe("\"'\rcmd\"");
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(0)).toBe("0");
  });

  it("renders a header row and CRLF line endings in column order", () => {
    expect(csvRows(["b", "a"], [{ a: 1, b: "x" }])).toBe("b,a\r\nx,1\r\n");
    expect(csvRows(["a"], [{}])).toBe("a\r\n\r\n");
  });
});
