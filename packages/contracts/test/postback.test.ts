import { describe, expect, it } from "vitest";
import {
  clickIdFromLeadId,
  MAX_PAYOUT_USD,
  postbackRawFromSearchParams,
  PostbackQuery,
  PostbackResponse,
  queuesConversion,
} from "../src/index.js";
import { fixture } from "./helpers.js";

interface Case {
  name: string;
  query: string;
  expect: Record<string, unknown> | null;
  queues_conversion?: boolean;
}

const { cases } = fixture<{ cases: Case[] }>("postback/cases.json");

describe("postback query (V1 handlePostback)", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const raw = postbackRawFromSearchParams(new URLSearchParams(c.query));
    const r = PostbackQuery.safeParse(raw);
    if (c.expect === null) {
      expect(r.success).toBe(false);
      return;
    }
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual(c.expect);
    expect(queuesConversion(r.data)).toBe(c.queues_conversion);
  });

  it("payout ceiling is V1's 230", () => {
    expect(MAX_PAYOUT_USD).toBe(230);
  });

  it("cid joins to lead_id without hyphens", () => {
    expect(clickIdFromLeadId("6f1c2b9e-3a4d-4c5e-8f60-7a8b9c0d1e2f")).toBe("6f1c2b9e3a4d4c5e8f607a8b9c0d1e2f");
  });

  it("response bodies match V1", () => {
    for (const body of [
      { status: "accepted", lead_id: "x" },
      { status: "duplicate", lead_id: "x" },
      { status: "ignored", reason: "unknown_click" },
      { status: "invalid", message: "Unauthorized" },
      { status: "invalid", message: "Invalid postback" },
    ]) {
      expect(PostbackResponse.safeParse(body).success).toBe(true);
    }
    expect(PostbackResponse.safeParse({ status: "ok" }).success).toBe(false);
  });
});
