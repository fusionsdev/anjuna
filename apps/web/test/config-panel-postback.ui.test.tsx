import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import brandFixture from "@anjuna/contracts/fixtures/admin/brand.get.response.json";
import { ConfigPanel } from "../src/client/screens/ConfigPanel";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
let postbackToken: string;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && input === "/api/brands/brand-a") return json({ brand: { ...brandFixture.brand, postback_token: postbackToken } });
    if (method === "GET" && input === "/api/brands/brand-a/site-text") return json({ error: "not_found" }, 404);
    throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Postback token state", () => {
  it("shows the tenant postback for a brand the global token covers", async () => {
    postbackToken = "global";
    render(<ConfigPanel me={owner} brandId="brand-a" onClose={() => {}} onChanged={() => {}} />);
    expect(await screen.findByText("ใช้ postback กลาง (global)")).toBeTruthy();
    expect(screen.queryByText("ยังไม่ได้ตั้งค่า")).toBeNull();
  });

  it("still shows not set when neither token exists", async () => {
    postbackToken = "not_set";
    render(<ConfigPanel me={owner} brandId="brand-a" onClose={() => {}} onChanged={() => {}} />);
    expect(await screen.findByText("ยังไม่ได้ตั้งค่า")).toBeTruthy();
    expect(screen.queryByText("ใช้ postback กลาง (global)")).toBeNull();
  });
});
