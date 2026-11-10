import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConfirm } from "../src/client/components/ConfirmDialog";
import { ShortcutsOverlay } from "../src/client/components/ShortcutsOverlay";
import { TemplatesScreen } from "../src/client/screens/Templates";
import { openModal, useShortcuts } from "../src/client/useShortcuts";

const go = vi.fn();
const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** The shell's keyboard layer: the shortcuts, the list overlay, a page with a search field, and a confirm dialog the page can open. */
function Shell({ children }: { children?: React.ReactNode }) {
  const [help, setHelp] = useState(false);
  const [confirm, confirmElement] = useConfirm();
  useShortcuts({ go, toggleHelp: () => setHelp((open) => !open) });
  return (
    <>
      <main>
        <input type="search" aria-label="ค้นหาในหน้านี้" />
        <button type="button" onClick={() => void confirm({ title: "ลบรายการนี้", confirmLabel: "ลบ", tone: "danger" })}>ถามก่อนลบ</button>
        {children}
      </main>
      <ShortcutsOverlay open={help} onClose={() => setHelp(false)} />
      {confirmElement}
    </>
  );
}

const press = (key: string, target: Element | Document = document) => fireEvent.keyDown(target, { key });
const search = () => screen.getByLabelText("ค้นหาในหน้านี้");

beforeEach(() => {
  go.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T10:00:00.000Z"));
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (input.startsWith("/api/templates")) return json({ templates: [], categories: [] });
    throw new Error(`Unexpected test HTTP request: ${input}`);
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

/** The two keys that reached the page behind a modal in the review: "/" moved focus to the search field, "g b" navigated. */
function pressPageShortcuts(from: Element) {
  press("/", from);
  press("g", from);
  press("b", from);
}

describe("page shortcuts while a modal is open", () => {
  it("do nothing behind the shortcut list: / keeps focus on its close button and g b does not navigate", () => {
    render(<Shell />);
    press("?");
    const close = screen.getByRole("button", { name: "ปิดรายการทางลัด" });
    expect(document.activeElement).toBe(close);
    pressPageShortcuts(close);
    expect(document.activeElement).toBe(close);
    expect(document.activeElement).not.toBe(search());
    expect(go).not.toHaveBeenCalled();
    // The list still closes itself with "?", and the page shortcuts work again after it.
    press("?", close);
    expect(screen.queryByRole("dialog")).toBeNull();
    press("/");
    expect(document.activeElement).toBe(search());
    press("g"); press("b");
    expect(go).toHaveBeenCalledWith("brands");
  });

  it("do nothing behind a confirm dialog", () => {
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "ถามก่อนลบ" }));
    const dialog = screen.getByRole("alertdialog");
    const cancel = within(dialog).getAllByRole("button")[0]!;
    cancel.focus();
    pressPageShortcuts(cancel);
    press("?", cancel);
    expect(document.activeElement).toBe(cancel);
    expect(document.activeElement).not.toBe(search());
    expect(go).not.toHaveBeenCalled();
    // The shortcut list did not open on top of the confirm dialog either.
    expect(screen.queryByRole("dialog", { name: "ทางลัดคีย์บอร์ด" })).toBeNull();
    // Closing the dialog gives the page its shortcuts back.
    fireEvent.click(cancel);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    press("g"); press("t");
    expect(go).toHaveBeenCalledWith("templates");
  });

  it("do nothing behind the template upload modal", async () => {
    vi.useRealTimers();
    render(<Shell><TemplatesScreen me={owner} /></Shell>);
    fireEvent.click(await screen.findByRole("button", { name: "อัปโหลดเทมเพลต" }));
    const modal = screen.getByRole("dialog", { name: "อัปโหลดเทมเพลต" });
    expect(openModal()).toBe(modal);
    const inside = within(modal).getAllByRole("button")[0]!;
    inside.focus();
    pressPageShortcuts(inside);
    press("?", inside);
    expect(document.activeElement).toBe(inside);
    expect(document.activeElement).not.toBe(search());
    expect(go).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "ทางลัดคีย์บอร์ด" })).toBeNull();
  });

  it("drops a half typed chord when a modal opens in between", () => {
    render(<Shell />);
    press("g");
    act(() => { fireEvent.click(screen.getByRole("button", { name: "ถามก่อนลบ" })); });
    const cancel = within(screen.getByRole("alertdialog")).getAllByRole("button")[0]!;
    press("b", cancel);
    fireEvent.click(cancel);
    press("b");
    expect(go).not.toHaveBeenCalled();
  });
});
