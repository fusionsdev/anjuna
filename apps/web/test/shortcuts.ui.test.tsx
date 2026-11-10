import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShortcutsOverlay } from "../src/client/components/ShortcutsOverlay";
import { CHORD_TIMEOUT_MS, SHORTCUTS, findPageSearch, isTypingTarget, useShortcuts } from "../src/client/useShortcuts";

const go = vi.fn();

/** A page the way the shell draws it: the shortcuts, the overlay and a main area with a search field and other inputs. */
function Page() {
  const [help, setHelp] = useState(false);
  useShortcuts({ go, toggleHelp: () => setHelp((open) => !open) });
  return (
    <>
      <button type="button">before</button>
      <main>
        <input type="search" aria-label="ค้นหาในหน้านี้" />
        <input type="text" aria-label="ช่องข้อความ" />
        <textarea aria-label="ช่องยาว" />
        <select aria-label="ตัวเลือก"><option>a</option></select>
        <div contentEditable suppressContentEditableWarning data-testid="editable">แก้ไขได้</div>
      </main>
      <ShortcutsOverlay open={help} onClose={() => setHelp(false)} />
    </>
  );
}

const press = (key: string, init: KeyboardEventInit = {}, target: Element | Document = document) => fireEvent.keyDown(target, { key, ...init });

beforeEach(() => { go.mockClear(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-10T10:00:00.000Z")); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("keyboard shortcuts", () => {
  it("focuses the page search field with /", () => {
    render(<Page />);
    press("/");
    expect(document.activeElement).toBe(screen.getByLabelText("ค้นหาในหน้านี้"));
  });

  it("goes to the brands page with g then b, and to home, templates and alerts with h, t and a", () => {
    render(<Page />);
    for (const [second, view] of [["b", "brands"], ["h", "home"], ["t", "templates"], ["a", "alerts"]] as const) {
      press("g"); press(second);
      expect(go).toHaveBeenLastCalledWith(view);
    }
    expect(go).toHaveBeenCalledTimes(4);
  });

  it("drops the chord when the second key is another key or comes after the timeout", () => {
    render(<Page />);
    press("g"); press("x"); press("b");
    expect(go).not.toHaveBeenCalled();
    press("g");
    act(() => { vi.setSystemTime(Date.now() + CHORD_TIMEOUT_MS + 50); });
    press("b");
    expect(go).not.toHaveBeenCalled();
  });

  it("opens the shortcut list with ? and closes it with Escape, returning focus", () => {
    render(<Page />);
    screen.getByRole("button", { name: "before" }).focus();
    press("?", { shiftKey: true });
    const dialog = screen.getByRole("dialog", { name: "ทางลัดคีย์บอร์ด" });
    expect(dialog.textContent).toContain(SHORTCUTS[0]!.text);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "ปิดรายการทางลัด" }));
    press("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "before" }));
  });

  it("closes the shortcut list from its close button and from the scrim", () => {
    render(<Page />);
    press("?");
    fireEvent.click(screen.getByRole("button", { name: "ปิดรายการทางลัด" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    press("?");
    fireEvent.click(document.querySelector(".shortcuts-scrim")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does nothing while the user types in a field, a text area, a select or an editable area", () => {
    render(<Page />);
    for (const target of [screen.getByLabelText("ช่องข้อความ"), screen.getByLabelText("ช่องยาว"), screen.getByLabelText("ตัวเลือก"), screen.getByTestId("editable")]) {
      (target as HTMLElement).focus();
      press("g", {}, target); press("b", {}, target); press("/", {}, target); press("?", {}, target);
    }
    expect(go).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByLabelText("ค้นหาในหน้านี้"));
  });

  it("ignores a chord split by typing, and keys with Ctrl, Alt or Meta", () => {
    render(<Page />);
    press("g");
    press("b", {}, screen.getByLabelText("ช่องข้อความ"));
    press("b");
    expect(go).not.toHaveBeenCalled();
    press("g", { ctrlKey: true }); press("b");
    press("/", { metaKey: true });
    expect(go).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(screen.getByLabelText("ค้นหาในหน้านี้"));
  });

  it("recognises typing targets and finds the page search", () => {
    render(<Page />);
    expect(isTypingTarget(screen.getByLabelText("ช่องข้อความ"))).toBe(true);
    expect(isTypingTarget(screen.getByRole("button", { name: "before" }))).toBe(false);
    expect(findPageSearch()).toBe(screen.getByLabelText("ค้นหาในหน้านี้"));
  });
});
