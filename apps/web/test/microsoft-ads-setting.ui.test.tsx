import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicrosoftAdsSetting } from "../src/client/screens/MicrosoftAdsSetting";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const LABEL = "บัญชี Microsoft Ads (Microsoft Ads account)";
let sent: Array<{ method: string; body: unknown }>;
let stored: string | null;

beforeEach(() => {
  sent = [];
  stored = "123456";
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (input !== "/api/settings/microsoft-ads") throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { microsoft_ads_account: string | null } : undefined;
    sent.push({ method, body });
    if (method === "PUT") stored = body!.microsoft_ads_account;
    return json({ microsoft_ads_account: stored, updated_at: "2026-11-07T08:00:00.000Z" });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const input = () => screen.getByRole("textbox", { name: LABEL }) as HTMLInputElement;
const save = () => screen.getByRole("button", { name: "บันทึก (Save)" }) as HTMLButtonElement;

describe("Settings: the global Microsoft Ads account", () => {
  it("loads the saved account, saves a new one with PUT and clears it with null", async () => {
    render(<MicrosoftAdsSetting />);
    await waitFor(() => expect(input().value).toBe("123456"));
    expect(save().disabled).toBe(true);

    fireEvent.change(input(), { target: { value: "987654321" } });
    fireEvent.click(save());
    expect(await screen.findByText("บันทึกแล้ว (Saved)")).toBeTruthy();
    expect(sent.at(-1)).toEqual({ method: "PUT", body: { microsoft_ads_account: "987654321" } });

    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.click(save());
    await waitFor(() => expect(sent.at(-1)).toEqual({ method: "PUT", body: { microsoft_ads_account: null } }));
    expect(input().value).toBe("");
  });

  it("refuses a value that is not 6 to 12 digits and sends nothing", async () => {
    render(<MicrosoftAdsSetting />);
    await waitFor(() => expect(input().value).toBe("123456"));
    fireEvent.change(input(), { target: { value: "12-34" } });
    expect(screen.getByRole("alert").textContent).toBe("ต้องเป็นเลข 6 ถึง 12 หลัก (6 to 12 digits)");
    expect(save().disabled).toBe(true);
    expect(sent.filter((s) => s.method === "PUT")).toHaveLength(0);
  });

  it("shows the Thai error of a refused save", async () => {
    render(<MicrosoftAdsSetting />);
    await waitFor(() => expect(input().value).toBe("123456"));
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "forbidden_role", required_role: "owner" }, 403)));
    fireEvent.change(input(), { target: { value: "7654321" } });
    fireEvent.click(save());
    expect((await screen.findByRole("alert")).textContent).not.toBe("");
  });
});
