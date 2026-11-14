import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TemplateVersionSummary } from "@anjuna/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { SystemScreen } from "../src/client/screens/System";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const employee = { id: "staff", email: "staff@example.test", role: "employee" as const };

const version = (id: string, templateId: string, archived = false): TemplateVersionSummary => ({
  template_version_id: id, template_id: templateId, name: templateId, version: 1, status: "approved", submitted_by_label: null,
  created_at: "2026-11-01T00:00:00.000Z", sealed_at: null, thumbnail_url: null, brands_using: 0, archived, category_id: null, was_approved: true, similarity_fail_count: 0,
});
const key = (id: string, revoked: boolean) => ({
  key_id: id, label: id, secret: null, created_by: "owner", created_at: "2026-11-01T00:00:00.000Z", last_used_at: null, revoked_at: revoked ? "2026-11-02T00:00:00.000Z" : null,
});

beforeEach(() => {
  // Two versions of one template, one more template and an archived one: the tag counts 2 templates.
  vi.spyOn(api, "templates").mockResolvedValue({ templates: [version("v1", "t1"), version("v2", "t1"), version("v3", "t2"), version("v4", "t3", true)], categories: [] });
  vi.spyOn(api, "builderKeys").mockResolvedValue({ keys: [key("k1", false), key("k2", false), key("k3", true)] });
  vi.spyOn(api, "mailing").mockResolvedValue({ external_sync: "not_configured", counts: { pending: 561, sent: 0, skipped: 0, dead: 0 } });
  vi.spyOn(api, "notifySettings").mockResolvedValue({ telegram: { enabled: false, chat_ids: [] }, routing: {}, digest: { enabled: false, time: "09:00" } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const cards = () => within(screen.getByRole("list", { name: "หน้าในระบบ" })).getAllByRole("link");
const card = (name: string) => cards().find((link) => link.querySelector(".system-card-name")?.textContent === name)!;
const tagOf = (name: string) => card(name).querySelector(".chip");

describe("ระบบ page", () => {
  it("shows an owner the eleven cards in the mockup order, each linking to its existing screen", async () => {
    render(<SystemScreen me={owner} onOpen={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 1, name: "ระบบ" })).toBeTruthy();
    expect(screen.getByText("หน้าที่ไม่ได้ใช้ทุกวัน ถ้ามีอะไรต้องทำ จะขึ้นที่ \"งานรอทำ\" ให้เอง")).toBeTruthy();
    expect(cards().map((link) => [link.querySelector(".system-card-name")?.textContent, link.getAttribute("href")])).toEqual([
      ["เทมเพลต", "/templates"],
      ["AdKit Terminal", "/adkit-terminal"],
      ["อีเมล", "/mailing"],
      ["คีย์ Builder", "/builder-keys"],
      ["ช่องทางแจ้งเตือน", "/notify-settings"],
      ["แบ่งค่าโฆษณา", "/ad-allocation"],
      ["ผู้ใช้", "/users"],
      ["ประวัติการแก้ไข", "/audit"],
      ["ตั้งค่าทั่วไป", "/settings"],
      ["ข้อผิดพลาดฝั่งเว็บ", "/errors"],
      ["ประวัติการติดตั้ง", "/deploys"],
    ]);
    await waitFor(() => expect(tagOf("ช่องทางแจ้งเตือน")).toBeTruthy());
  });

  it("leaves the owner-only cards out for an employee and never reads the notify settings", async () => {
    render(<SystemScreen me={employee} onOpen={vi.fn()} />);
    expect(cards().map((link) => link.querySelector(".system-card-name")?.textContent)).toEqual(["เทมเพลต", "อีเมล", "คีย์ Builder", "ประวัติการแก้ไข", "ข้อผิดพลาดฝั่งเว็บ", "ประวัติการติดตั้ง"]);
    await waitFor(() => expect(tagOf("อีเมล")?.textContent).toBe("ค้าง 561"));
    expect(api.notifySettings).not.toHaveBeenCalled();
  });

  it("tags each card with its status: template count, live key count, stuck mail and Telegram off", async () => {
    render(<SystemScreen me={owner} onOpen={vi.fn()} />);
    await waitFor(() => expect(tagOf("ช่องทางแจ้งเตือน")?.textContent).toBe("Telegram ปิด"));
    expect(tagOf("ช่องทางแจ้งเตือน")!.className).toContain("chip-warning");
    await waitFor(() => expect(tagOf("เทมเพลต")?.textContent).toBe("2"));
    expect(tagOf("เทมเพลต")!.className).toContain("chip-neutral");
    await waitFor(() => expect(tagOf("คีย์ Builder")?.textContent).toBe("2"));
    await waitFor(() => expect(tagOf("อีเมล")?.textContent).toBe("ค้าง 561"));
    expect(tagOf("อีเมล")!.className).toContain("chip-warning");
    expect(within(card("อีเมล")).getByText("ยังไม่ได้ตั้งค่า listmonk เลยมีอีเมลค้างส่ง 561 ฉบับ")).toBeTruthy();
    expect(tagOf("AdKit Terminal")?.textContent).toBe("เจ้าของ");
    expect(tagOf("ประวัติการแก้ไข")).toBeNull();
  });

  it("shows no stuck-mail or Telegram tag when listmonk is set up and Telegram is on", async () => {
    vi.mocked(api.mailing).mockResolvedValue({ external_sync: "configured", counts: { pending: 12, sent: 40, skipped: 0, dead: 0 } });
    vi.mocked(api.notifySettings).mockResolvedValue({ telegram: { enabled: true, chat_ids: ["-100123"] }, routing: {}, digest: { enabled: false, time: "09:00" } });
    render(<SystemScreen me={owner} onOpen={vi.fn()} />);
    await waitFor(() => expect(tagOf("เทมเพลต")?.textContent).toBe("2"));
    await waitFor(() => expect(api.notifySettings).toHaveBeenCalled());
    await waitFor(() => expect(api.mailing).toHaveBeenCalled());
    expect(tagOf("อีเมล")).toBeNull();
    expect(tagOf("ช่องทางแจ้งเตือน")).toBeNull();
    expect(within(card("อีเมล")).getByText("รายชื่ออีเมลของลีดที่ยินยอมรับข่าวสาร และสถานะการส่งเข้า listmonk")).toBeTruthy();
  });

  it("shows the cards without tags when the status reads fail", async () => {
    for (const name of ["templates", "builderKeys", "mailing", "notifySettings"] as const) vi.mocked(api[name]).mockRejectedValue(new Error("unavailable"));
    render(<SystemScreen me={owner} onOpen={vi.fn()} />);
    await waitFor(() => expect(api.notifySettings).toHaveBeenCalled());
    await Promise.resolve();
    expect(cards()).toHaveLength(11);
    // Only the fixed owner tag is left.
    expect(cards().filter((link) => link.querySelector(".chip")).map((link) => link.querySelector(".system-card-name")?.textContent)).toEqual(["AdKit Terminal"]);
  });

  it("opens the card's screen on a plain click and leaves a modified click to the browser", () => {
    const onOpen = vi.fn();
    render(<SystemScreen me={owner} onOpen={onOpen} />);
    fireEvent.click(card("ประวัติการติดตั้ง"));
    expect(onOpen).toHaveBeenCalledWith("deploys");
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener("click", stop);
    try {
      fireEvent.click(card("เทมเพลต"), { metaKey: true });
    } finally {
      document.removeEventListener("click", stop);
    }
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

/** jsdom has no layout, so these read the stylesheet rules that keep the page inside a 375px screen. */
describe("ระบบ page and breadcrumb at 375px", () => {
  const read = (file: string) => readFileSync(join(__dirname, "../src/client", file), "utf8").replace(/\r\n/g, "\n");
  const rule = (css: string, selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.[\]"=]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";

  it("lets the card grid drop to one column narrower than 260px, so the page never scrolls sideways", () => {
    const css = read("screens/System.css");
    expect(rule(css, ".system-grid")).toContain("minmax(min(260px, 100%), 1fr)");
    expect(rule(css, ".system-card-head")).toContain("flex-wrap: wrap");
    expect(rule(css, ".system-card-name")).toContain("overflow-wrap: anywhere");
    expect(css).not.toMatch(/min-width: [1-9]/);
  });

  it("wraps the breadcrumb and keeps the create button inside the sidebar width", () => {
    const css = read("styles.css");
    expect(rule(css, ".crumbs")).toContain("flex-wrap: wrap");
    expect(rule(css, "a.sidebar-create")).toContain("margin: 0 12px 12px");
    expect(rule(css, "a.sidebar-create")).not.toContain("width");
  });
});
