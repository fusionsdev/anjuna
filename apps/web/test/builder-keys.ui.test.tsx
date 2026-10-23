import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../src/client/api";
import { BuilderKeysScreen } from "../src/client/screens/BuilderKeys";
import { answerConfirm } from "./confirm";

const SECRET = `anj_mcp_${"A".repeat(43)}`;
const NEW_SECRET = `anj_mcp_${"B".repeat(43)}`;
const active = { key_id: "bk_1", label: "Somchai (bolt.new)", secret: SECRET, created_by: "owner", created_at: "2026-10-17T00:00:00.000Z", last_used_at: null, revoked_at: null };
const legacy = { ...active, key_id: "bk_0", label: "Legacy", secret: null };
const owner = { role: "owner" } as Me;
const employee = { role: "employee" } as Me;
let keys: unknown[];
let requests: Array<{ method: string; path: string }>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  keys = [active];
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, path: input });
    if (method === "GET" && input === "/api/builder-keys") return json({ keys });
    if (method === "POST" && input === "/api/builder-keys") {
      const key = { ...active, key_id: "bk_2", label: JSON.parse(String(init!.body)).label, secret: NEW_SECRET };
      keys = [key, ...keys];
      return json({ key }, 201);
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
  it("lists keys with their key and last use", async () => {
    keys = [active, legacy];
    render(<BuilderKeysScreen me={owner} />);
    expect(await screen.findByText("Somchai (bolt.new)")).toBeTruthy();
    expect(screen.getByText(SECRET).tagName).toBe("CODE");
    expect(screen.getByRole("button", { name: "คัดลอกคีย์ Somchai (bolt.new) (Copy)" })).toBeTruthy();
    expect(screen.getByText(/ไม่ได้เก็บไว้/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "คัดลอกคีย์ Legacy (Copy)" })).toBeNull();
    expect(screen.getAllByText("ยังไม่เคยใช้ (Never)")).toHaveLength(2);
  });

  it("creates a key and shows it in the table", async () => {
    render(<BuilderKeysScreen me={owner} />);
    await screen.findByText("Somchai (bolt.new)");
    const listFetches = () => requests.filter((r) => r.method === "GET" && r.path === "/api/builder-keys").length;
    expect(listFetches()).toBe(1);
    fireEvent.change(screen.getByLabelText("ชื่อคีย์ (Key label)"), { target: { value: "Malee (bolt.new)" } });
    fireEvent.click(screen.getByRole("button", { name: "สร้างคีย์ (Create key)" }));
    expect((await screen.findByText(NEW_SECRET)).tagName).toBe("CODE");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(listFetches()).toBe(2);
    expect(screen.getByText("Malee (bolt.new)")).toBeTruthy();
    expect((screen.getByLabelText("ชื่อคีย์ (Key label)") as HTMLInputElement).value).toBe("");
  });

  it("copies a key", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<BuilderKeysScreen me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: "คัดลอกคีย์ Somchai (bolt.new) (Copy)" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "คัดลอกคีย์ Somchai (bolt.new) (Copy)" }).textContent).toBe("คัดลอกแล้ว (Copied)"));
    expect(writeText).toHaveBeenCalledWith(SECRET);
  });

  it("hides Revoke for employee", async () => {
    render(<BuilderKeysScreen me={employee} />);
    expect(await screen.findByText(SECRET)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^ยกเลิกคีย์/ })).toBeNull();
  });

  it("revokes a key after confirmation", async () => {
    render(<BuilderKeysScreen me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: "ยกเลิกคีย์ Somchai (bolt.new) (Revoke)" }));
    expect(requests.some((r) => r.path === "/api/builder-keys/bk_1/revoke")).toBe(false);
    await answerConfirm(true);
    expect(await screen.findByText("ยกเลิกแล้ว (Revoked)")).toBeTruthy();
    expect(requests).toContainEqual({ method: "POST", path: "/api/builder-keys/bk_1/revoke" });
  });
});
