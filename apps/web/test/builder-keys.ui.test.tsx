import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../src/client/api";
import { BuilderKeysScreen } from "../src/client/screens/BuilderKeys";
import { answerConfirm } from "./confirm";

const SECRET = `anj_mcp_${"A".repeat(39)}1234`;
const SECOND_SECRET = `anj_mcp_${"C".repeat(39)}9012`;
const NEW_SECRET = `anj_mcp_${"B".repeat(39)}5678`;
const masked = (secret: string) => `•••• ${secret.slice(-4)}`;
const active = { key_id: "bk_1", label: "Somchai (bolt.new)", secret: SECRET, created_by: "owner", created_at: "2026-10-17T00:00:00.000Z", last_used_at: null, revoked_at: null };
const legacy = { ...active, key_id: "bk_0", label: "Legacy", secret: null };
const second = { ...active, key_id: "bk_3", label: "Malee", secret: SECOND_SECRET };
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
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Builder keys screen", () => {
  it("lists keys with their key and last use", async () => {
    keys = [active, legacy];
    render(<BuilderKeysScreen me={owner} />);
    expect(await screen.findByText("Somchai (bolt.new)")).toBeTruthy();
    expect(screen.getByText(masked(SECRET)).tagName).toBe("CODE");
    expect(screen.getByRole("button", { name: "คัดลอกคีย์ Somchai (bolt.new)" })).toBeTruthy();
    expect(screen.getByText(/ไม่ได้เก็บไว้/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "คัดลอกคีย์ Legacy" })).toBeNull();
    expect(screen.queryByRole("button", { name: "ดูคีย์ Legacy" })).toBeNull();
    expect(screen.getAllByText("ยังไม่เคยใช้ (Never)")).toHaveLength(2);
  });

  it("creates a key and shows it in the table", async () => {
    render(<BuilderKeysScreen me={owner} />);
    await screen.findByText("Somchai (bolt.new)");
    const listFetches = () => requests.filter((r) => r.method === "GET" && r.path === "/api/builder-keys").length;
    expect(listFetches()).toBe(1);
    fireEvent.change(screen.getByLabelText("ชื่อคีย์ (Key label)"), { target: { value: "Malee (bolt.new)" } });
    fireEvent.click(screen.getByRole("button", { name: "สร้างคีย์ (Create key)" }));
    expect((await screen.findByText(masked(NEW_SECRET))).tagName).toBe("CODE");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(listFetches()).toBe(2);
    expect(screen.getByText("Malee (bolt.new)")).toBeTruthy();
    expect((screen.getByLabelText("ชื่อคีย์ (Key label)") as HTMLInputElement).value).toBe("");
  });

  it("masks the key on first render and keeps the full secret out of the DOM", async () => {
    const view = render(<BuilderKeysScreen me={owner} />);
    expect(await screen.findByText(masked(SECRET))).toBeTruthy();
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(view.container.textContent).not.toContain(SECRET);
    expect(view.container.textContent).toContain("คีย์โชว์แค่ 4 ตัวท้าย กดดูคีย์เพื่อดูเต็ม แล้วจะซ่อนเองใน 30 วินาที");
  });

  it("reveals the full key on ดูคีย์ and hides it on ซ่อน", async () => {
    render(<BuilderKeysScreen me={owner} />);
    const reveal = await screen.findByRole("button", { name: "ดูคีย์ Somchai (bolt.new)" });
    expect(reveal.getAttribute("aria-pressed")).toBe("false");
    expect(reveal.textContent).toBe("ดูคีย์");
    fireEvent.click(reveal);
    expect(screen.getByText(SECRET).tagName).toBe("CODE");
    expect(screen.queryByText(masked(SECRET))).toBeNull();
    const hide = screen.getByRole("button", { name: "ซ่อนคีย์ Somchai (bolt.new)" });
    expect(hide.getAttribute("aria-pressed")).toBe("true");
    expect(hide.textContent).toBe("ซ่อน");
    fireEvent.click(hide);
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.getByText(masked(SECRET))).toBeTruthy();
  });

  it("reveals one row at a time", async () => {
    keys = [active, second];
    render(<BuilderKeysScreen me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: "ดูคีย์ Somchai (bolt.new)" }));
    expect(screen.getByText(SECRET)).toBeTruthy();
    expect(screen.getByText(masked(SECOND_SECRET))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ดูคีย์ Malee" }));
    expect(screen.getByText(SECOND_SECRET)).toBeTruthy();
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.getByText(masked(SECRET))).toBeTruthy();
    expect(screen.getByRole("button", { name: "ดูคีย์ Somchai (bolt.new)" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("hides a revealed key after 30 seconds", async () => {
    render(<BuilderKeysScreen me={owner} />);
    const reveal = await screen.findByRole("button", { name: "ดูคีย์ Somchai (bolt.new)" });
    vi.useFakeTimers();
    fireEvent.click(reveal);
    expect(screen.getByText(SECRET)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(29_999); });
    expect(screen.getByText(SECRET)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.getByText(masked(SECRET))).toBeTruthy();
  });

  it("restarts the 30 second timer when another row is revealed", async () => {
    keys = [active, second];
    render(<BuilderKeysScreen me={owner} />);
    const first = await screen.findByRole("button", { name: "ดูคีย์ Somchai (bolt.new)" });
    vi.useFakeTimers();
    fireEvent.click(first);
    act(() => { vi.advanceTimersByTime(20_000); });
    fireEvent.click(screen.getByRole("button", { name: "ดูคีย์ Malee" }));
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(screen.getByText(SECOND_SECRET)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.queryByText(SECOND_SECRET)).toBeNull();
  });

  it("copies the full secret while the key stays masked", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<BuilderKeysScreen me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: "คัดลอกคีย์ Somchai (bolt.new)" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "คัดลอกคีย์ Somchai (bolt.new)" }).textContent).toBe("คัดลอกแล้ว"));
    expect(writeText).toHaveBeenCalledWith(SECRET);
    expect(screen.getByText(masked(SECRET))).toBeTruthy();
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it("hides Revoke for employee", async () => {
    render(<BuilderKeysScreen me={employee} />);
    expect(await screen.findByText(masked(SECRET))).toBeTruthy();
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
