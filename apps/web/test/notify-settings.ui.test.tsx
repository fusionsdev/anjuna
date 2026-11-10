import type { NotifySettings } from "@anjuna/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotifySettingsScreen } from "../src/client/screens/NotifySettings";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const base: NotifySettings = {
  telegram: { enabled: true, chat_ids: ["-100184", "5550001"] },
  routing: { click_risk: { telegram: false, repeat_hours: 24, quiet: { from: "23:00", to: "06:30" } } },
  digest: { enabled: true, time: "09:00" },
};

let stored: NotifySettings;
let requests: Array<{ method: string; path: string; body: unknown }>;
let testReply: () => Response;
let putReply: ((body: NotifySettings) => Response) | null;
let getReply: (() => Response) | null;

beforeEach(() => {
  stored = structuredClone(base);
  requests = [];
  testReply = () => json({ status: "sent", response_code: 200 });
  putReply = null;
  getReply = null;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: input, body });
    if (input === "/api/settings/notify" && method === "GET") return getReply ? getReply() : json(stored);
    if (input === "/api/settings/notify" && method === "PUT") {
      if (putReply) return putReply(body);
      stored = body;
      return json(stored);
    }
    if (input === "/api/settings/notify/test" && method === "POST") return testReply();
    throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const puts = () => requests.filter((r) => r.method === "PUT");
const open = async () => { render(<NotifySettingsScreen />); await screen.findByRole("heading", { name: "Telegram" }); };

describe("Notification channels", () => {
  it("loads the saved settings: status chip, chat ids, one row per known rule, saved rule values and the digest", async () => {
    await open();
    expect(screen.getByRole("heading", { name: "ช่องทางแจ้งเตือน", level: 1 })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Telegram" })).getByText("เปิดอยู่")).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(expect.arrayContaining(["-100184", "5550001"]));
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => row.querySelector("td")!.textContent)).toEqual([
      "คอนเวอร์ชันส่งไม่ได้", "แบรนด์ไม่มี postback", "อัตราส่งฟอร์มไม่สำเร็จสูง", "อัตราปฏิเสธสูง", "คลิกที่จ่ายไม่มี gclid",
    ]);
    // A rule with no entry shows the sender's default; click risk shows what was saved.
    expect((screen.getByLabelText("ส่ง คอนเวอร์ชันส่งไม่ได้ ผ่าน Telegram") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("ส่ง คอนเวอร์ชันส่งไม่ได้ ซ้ำทุก") as unknown as HTMLInputElement).value).toBe("6");
    expect((screen.getByLabelText("ส่ง คลิกที่จ่ายไม่มี gclid ผ่าน Telegram") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("ส่ง คลิกที่จ่ายไม่มี gclid ซ้ำทุก") as unknown as HTMLInputElement).value).toBe("24");
    expect((screen.getByLabelText("ช่วงเงียบของ คลิกที่จ่ายไม่มี gclid เริ่ม") as HTMLInputElement).value).toBe("23:00");
    expect((screen.getByLabelText("ช่วงเงียบของ คลิกที่จ่ายไม่มี gclid สิ้นสุด") as HTMLInputElement).value).toBe("06:30");
    expect(screen.queryByLabelText("ช่วงเงียบของ คอนเวอร์ชันส่งไม่ได้ เริ่ม")).toBeNull();
    expect((screen.getByLabelText("เปิดสรุปรายวัน") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("เวลาส่งสรุปรายวัน") as HTMLInputElement).value).toBe("09:00");
    expect(requests).toEqual([{ method: "GET", path: "/api/settings/notify", body: undefined }]);
  });

  it("greys the LINE card with เร็ว ๆ นี้ and gives it no control", async () => {
    await open();
    const line = screen.getByRole("region", { name: "LINE" });
    expect(within(line).getByText("เร็ว ๆ นี้")).toBeTruthy();
    expect(line.getAttribute("aria-disabled")).toBe("true");
    expect(within(line).queryAllByRole("button")).toHaveLength(0);
    expect(within(line).queryAllByRole("textbox")).toHaveLength(0);
  });

  it("toggles a rule and saves: the PUT body holds the changed rule and keeps the rest of the document", async () => {
    await open();
    const save = screen.getByRole("button", { name: "บันทึก" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("ส่ง แบรนด์ไม่มี postback ผ่าน Telegram"));
    fireEvent.change(screen.getByLabelText("ส่ง แบรนด์ไม่มี postback ซ้ำทุก"), { target: { value: "1" } });
    fireEvent.click(screen.getByLabelText("ตั้งช่วงเงียบของ แบรนด์ไม่มี postback"));
    fireEvent.change(screen.getByLabelText("ช่วงเงียบของ แบรนด์ไม่มี postback เริ่ม"), { target: { value: "21:30" } });
    expect(screen.getByText("มีการแก้ไขที่ยังไม่บันทึก")).toBeTruthy();
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(await screen.findByText("บันทึกแล้ว")).toBeTruthy();
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.body).toEqual({
      telegram: { enabled: true, chat_ids: ["-100184", "5550001"] },
      routing: {
        click_risk: { telegram: false, repeat_hours: 24, quiet: { from: "23:00", to: "06:30" } },
        brands_without_postbacks: { telegram: false, repeat_hours: 1, quiet: { from: "21:30", to: "07:00" } },
      },
      digest: { enabled: true, time: "09:00" },
    });
    expect((screen.getByRole("button", { name: "บันทึก" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("locks every control while the save runs and keeps the saved document on screen when the response arrives", async () => {
    let release: (() => void) | undefined;
    // A slow server: the PUT answers only when the test lets it.
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/api/settings/notify" && init?.method === "PUT") await new Promise<void>((resolve) => { release = resolve; });
      return realFetch(input, init);
    }));
    await open();
    fireEvent.click(screen.getByLabelText("ส่ง แบรนด์ไม่มี postback ผ่าน Telegram"));
    fireEvent.click(screen.getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "กำลังบันทึก…" })).toBeTruthy());
    const telegram = screen.getByLabelText("เปิดแจ้งเตือนผ่าน Telegram") as HTMLInputElement;
    const digest = screen.getByLabelText("เปิดสรุปรายวัน") as HTMLInputElement;
    for (const control of [telegram, digest, screen.getByLabelText("ส่ง แบรนด์ไม่มี postback ผ่าน Telegram"), screen.getByLabelText("chat id ใหม่")]) expect(control.matches(":disabled")).toBe(true);
    release?.();
    expect(await screen.findByText("บันทึกแล้ว")).toBeTruthy();
    expect(telegram.checked).toBe(true);
    expect(screen.queryByText("มีการแก้ไขที่ยังไม่บันทึก")).toBeNull();
    expect(puts()).toHaveLength(1);
    expect((puts()[0]!.body as NotifySettings).telegram.enabled).toBe(true);
    // The controls open again after the response.
    expect(telegram.matches(":disabled")).toBe(false);
  });

  it("clears a quiet window to null and changes the digest time and switch in the same save", async () => {
    await open();
    fireEvent.click(screen.getByLabelText("ตั้งช่วงเงียบของ คลิกที่จ่ายไม่มี gclid"));
    fireEvent.change(screen.getByLabelText("เวลาส่งสรุปรายวัน"), { target: { value: "08:15" } });
    fireEvent.click(screen.getByRole("button", { name: "บันทึก" }));
    await screen.findByText("บันทึกแล้ว");
    expect(puts()[0]!.body).toMatchObject({ routing: { click_risk: { quiet: null } }, digest: { enabled: true, time: "08:15" } });
    fireEvent.click(screen.getByLabelText("เปิดสรุปรายวัน"));
    expect((screen.getByLabelText("เวลาส่งสรุปรายวัน") as HTMLInputElement).disabled).toBe(true);
  });

  it("adds a chat id, refuses a bad or repeated one, removes one, and saves the list", async () => {
    await open();
    const input = screen.getByLabelText("chat id ใหม่");
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "เพิ่ม chat id" }));
    expect((await screen.findByRole("alert")).textContent).toContain("chat id เป็นตัวเลข");
    fireEvent.change(input, { target: { value: "5550001" } });
    fireEvent.click(screen.getByRole("button", { name: "เพิ่ม chat id" }));
    expect((await screen.findByRole("alert")).textContent).toBe("มี chat id นี้แล้ว");
    fireEvent.change(input, { target: { value: "-100777" } });
    fireEvent.click(screen.getByRole("button", { name: "เพิ่ม chat id" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect((input as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "ลบ chat id -100184" }));
    expect(screen.queryByText("-100184")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "บันทึก" }));
    await screen.findByText("บันทึกแล้ว");
    expect(puts()[0]!.body).toMatchObject({ telegram: { enabled: true, chat_ids: ["5550001", "-100777"] } });
  });

  it("sends the test message and shows the delivery result; the test waits for a save", async () => {
    await open();
    const test = screen.getByRole("button", { name: "ส่งข้อความทดสอบ" }) as HTMLButtonElement;
    expect(test.disabled).toBe(false);
    fireEvent.click(test);
    const result = await screen.findByText(/^ส่งแล้ว \d{2}:\d{2} · 200$/);
    expect(result.className).toContain("pos");
    expect(requests.filter((r) => r.path === "/api/settings/notify/test")).toEqual([{ method: "POST", path: "/api/settings/notify/test", body: undefined }]);
    // An unsaved edit disables the test: core sends to the saved chat ids.
    fireEvent.click(screen.getByLabelText("เปิดสรุปรายวัน"));
    expect((screen.getByRole("button", { name: "ส่งข้อความทดสอบ" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("บันทึกก่อน แล้วจึงทดสอบ")).toBeTruthy();
  });

  it("shows a failed delivery with its response code, and an unreachable sender", async () => {
    await open();
    testReply = () => json({ status: "failed", response_code: 403 });
    fireEvent.click(screen.getByRole("button", { name: "ส่งข้อความทดสอบ" }));
    const failed = await screen.findByText(/^ส่งไม่สำเร็จ \d{2}:\d{2} · 403$/);
    expect(failed.className).toContain("neg");
    testReply = () => json({ error: "unavailable" }, 502);
    fireEvent.click(screen.getByRole("button", { name: "ส่งข้อความทดสอบ" }));
    expect(await screen.findByText("ติดต่อระบบส่งแจ้งเตือนไม่ได้")).toBeTruthy();
  });

  it("cannot test with Telegram off or with no chat id", async () => {
    stored = { ...base, telegram: { enabled: true, chat_ids: [] } };
    await open();
    expect((screen.getByRole("button", { name: "ส่งข้อความทดสอบ" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("เปิด Telegram และใส่ chat id ก่อนทดสอบ")).toBeTruthy();
  });

  it("shows the server's refusal on a failed save and keeps the edits", async () => {
    await open();
    putReply = () => json({ error: "invalid", issues: [{ path: "digest.time", message: "bad" }] }, 422);
    fireEvent.click(screen.getByLabelText("เปิดสรุปรายวัน"));
    fireEvent.click(screen.getByRole("button", { name: "บันทึก" }));
    expect((await screen.findByRole("alert")).textContent).toContain("ข้อมูลไม่ถูกต้อง");
    expect((screen.getByLabelText("เปิดสรุปรายวัน") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("button", { name: "บันทึก" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("drops the edits on ยกเลิกการแก้ไข", async () => {
    await open();
    fireEvent.click(screen.getByLabelText("ส่ง อัตราปฏิเสธสูง ผ่าน Telegram"));
    fireEvent.click(screen.getByRole("button", { name: "ยกเลิกการแก้ไข" }));
    expect((screen.getByLabelText("ส่ง อัตราปฏิเสธสูง ผ่าน Telegram") as HTMLInputElement).checked).toBe(true);
    expect(puts()).toHaveLength(0);
  });

  it("lists a rule the server holds but this page does not know, under its key", async () => {
    stored = { ...base, routing: { adsbot: { telegram: true, repeat_hours: 6, quiet: null } } };
    await open();
    expect(screen.getByLabelText("ส่ง adsbot ผ่าน Telegram")).toBeTruthy();
  });

  it("shows a load failure with a retry that reads again", async () => {
    getReply = () => json({ error: "unauthorized" }, 401);
    render(<NotifySettingsScreen />);
    expect((await screen.findByRole("alert")).textContent).toContain("เซสชันหมดอายุ");
    getReply = null;
    fireEvent.click(screen.getByRole("button", { name: "ลองอีกครั้ง" }));
    await screen.findByRole("heading", { name: "Telegram" });
    await waitFor(() => expect(requests.filter((r) => r.method === "GET")).toHaveLength(2));
  });

  it("shows no English-only visible label beside the Telegram, LINE and chat id names", async () => {
    await open();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\b(Save|Cancel|Retry|Add|Remove|Test)\b/);
  });
});
