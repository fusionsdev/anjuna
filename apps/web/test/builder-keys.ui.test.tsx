import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuilderKeysScreen } from "../src/client/screens/BuilderKeys";

const SECRET = `anj_mcp_${"A".repeat(43)}`;
const active = { key_id: "bk_1", label: "Somchai (bolt.new)", created_by: "owner", created_at: "2026-10-17T00:00:00.000Z", last_used_at: null, revoked_at: null };
let keys: unknown[];
let requests: Array<{ method: string; path: string }>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  keys = [active];
  requests = [];
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, path: input });
    if (method === "GET" && input === "/api/builder-keys") return json({ keys });
    if (method === "POST" && input === "/api/builder-keys") {
      const key = { ...active, key_id: "bk_2", label: JSON.parse(String(init!.body)).label };
      keys = [key, ...keys];
      return json({ key, secret: SECRET }, 201);
    }
    if (method === "POST" && input === "/api/builder-keys/bk_1/revoke") {
      keys = [{ ...active, revoked_at: "2026-10-17T01:00:00.000Z" }];
      return json({ key: keys[0] });
    }
    throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Builder keys screen", () => {
  it("lists keys with their last use", async () => {
    render(<BuilderKeysScreen />);
    expect(await screen.findByText("Somchai (bolt.new)")).toBeTruthy();
    expect(screen.getByText("ยังไม่เคยใช้ (Never)")).toBeTruthy();
  });

  it("shows a new key once, then hides it", async () => {
    render(<BuilderKeysScreen />);
    await screen.findByText("Somchai (bolt.new)");
    fireEvent.change(screen.getByLabelText("ชื่อคีย์ (Key label)"), { target: { value: "Malee (bolt.new)" } });
    fireEvent.click(screen.getByRole("button", { name: "สร้างคีย์ (Create key)" }));
    expect(await screen.findByText(SECRET)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ปิด (Close)" }));
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(await screen.findByText("Malee (bolt.new)")).toBeTruthy();
  });

  it("revokes a key after confirmation", async () => {
    render(<BuilderKeysScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "ยกเลิกคีย์ Somchai (bolt.new) (Revoke)" }));
    expect(await screen.findByText("ยกเลิกแล้ว (Revoked)")).toBeTruthy();
    expect(requests).toContainEqual({ method: "POST", path: "/api/builder-keys/bk_1/revoke" });
  });
});
