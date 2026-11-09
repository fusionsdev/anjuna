import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../src/client/api";
import { AdkitTerminalScreen } from "../src/client/screens/AdkitTerminal";

const owner = { role: "owner" } as Me;
const employee = { role: "employee" } as Me;
const AT = "2026-01-02T03:04:05.000Z";
const JOB_ID = "11111111-1111-4111-8111-111111111111";

const view = (over: Record<string, unknown> = {}) => ({
  id: JOB_ID, status: "queued", mode: "read", line: "manage google accounts list", output: null, error: null,
  requested_by: "u1", created_at: AT, updated_at: AT, ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let requests: Array<{ method: string; path: string; body: Record<string, unknown> | null }>;
let jobStatus: string;
let refusal: string | null;

beforeEach(() => {
  vi.useFakeTimers();
  requests = [];
  jobStatus = "queued";
  refusal = null;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ method, path: input, body });
    if (method === "POST" && input === "/api/adkit/terminal") {
      if (refusal) return json({ error: "invalid", issues: [{ path: "line", message: refusal }] }, 422);
      const mode = body!.mode as string;
      const argv = ["manage", "google", "accounts", "list", "--json"];
      return body!.dry_run
        ? json({ preview: true, argv, mode, job: null })
        : json({ preview: false, argv, mode, job: view({ mode }) }, 201);
    }
    if (method === "GET" && input === `/api/adkit/jobs/${JOB_ID}`) {
      return json({ job: view({ status: jobStatus, output: jobStatus === "done" ? '{"accounts":[]}' : null }) });
    }
    throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const polls = () => requests.filter((r) => r.method === "GET").length;

async function send(line: string, mode?: string) {
  if (mode) fireEvent.click(screen.getByRole("radio", { name: new RegExp(mode) }));
  fireEvent.change(screen.getByLabelText("คำสั่ง"), { target: { value: line } });
  fireEvent.click(screen.getByRole("button", { name: /ส่งคำสั่ง|ตรวจและเผยแพร่/ }));
  await flush();
}

describe("AdKit Terminal screen", () => {
  it("an employee sees the owner-only note and no form", () => {
    render(<AdkitTerminalScreen me={employee} />);
    expect(screen.getByRole("note").textContent).toContain("Owner เท่านั้น");
    expect(screen.queryByLabelText("คำสั่ง")).toBeNull();
  });

  it("the result view polls every 3 seconds and stops at 2 minutes", async () => {
    render(<AdkitTerminalScreen me={owner} />);
    await send("manage google accounts list");
    expect(screen.getByLabelText("ผลคำสั่ง")).toBeTruthy();
    expect(polls()).toBe(0);
    await advance(2999);
    expect(polls()).toBe(0);
    await advance(1);
    expect(polls()).toBe(1);
    await advance(3000);
    expect(polls()).toBe(2);
    // 39 polls fit before the 2 minute limit (3 s, 6 s, ... 117 s); the tick at 120 s gives up without a request.
    await advance(120_000 - 6000);
    expect(polls()).toBe(39);
    await advance(30_000);
    expect(polls()).toBe(39);
    expect(screen.getByRole("status").textContent).toContain("รอเกิน 2 นาที");
  });

  it("stops polling once the job is done and shows the output", async () => {
    render(<AdkitTerminalScreen me={owner} />);
    await send("manage google accounts list");
    jobStatus = "done";
    await advance(3000);
    expect(polls()).toBe(1);
    expect(screen.getByLabelText("ผลลัพธ์").textContent).toContain('"accounts"');
    await advance(30_000);
    expect(polls()).toBe(1);
  });

  it("shows the Thai reason of a refused line and starts no polling", async () => {
    refusal = "คำสั่งนี้สร้างแคมเปญร่าง สลับเป็นโหมดร่างก่อนส่ง";
    render(<AdkitTerminalScreen me={owner} />);
    await send("manage google campaigns create --account 1234567890 --data '{}'");
    expect(screen.getByRole("alert").textContent).toContain("สลับเป็นโหมดร่าง");
    expect(requests.every((r) => r.method === "POST" && (r.body as { dry_run?: boolean }).dry_run === true)).toBe(true);
    expect(screen.queryByLabelText("ผลคำสั่ง")).toBeNull();
    await advance(10_000);
    expect(polls()).toBe(0);
  });

  it("publish mode shows the parsed command in a confirm dialog and sends confirm only after Yes", async () => {
    render(<AdkitTerminalScreen me={owner} />);
    await send("manage google accounts list", "เผยแพร่");
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("adkit manage google accounts list --json");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toMatchObject({ dry_run: true });
    fireEvent.click(screen.getByRole("button", { name: "ส่งและเผยแพร่" }));
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body).toMatchObject({ mode: "publish", confirm: true });
  });

  it("cancelling the publish dialog sends nothing", async () => {
    render(<AdkitTerminalScreen me={owner} />);
    await send("manage google accounts list", "เผยแพร่");
    fireEvent.click(screen.getByRole("button", { name: /ยกเลิก/ }));
    await flush();
    expect(requests).toHaveLength(1);
    expect(screen.queryByLabelText("ผลคำสั่ง")).toBeNull();
  });
});
