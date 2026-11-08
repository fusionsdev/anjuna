import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RowMenu, type RowMenuItem } from "../src/client/components/RowMenu";

const setup = (calls: string[], items?: RowMenuItem[]) => render(
  <RowMenu label="จัดการ (Actions)" items={items ?? [
    { key: "install", label: "ติดตั้ง (Install)", group: "deploy", onSelect: () => { calls.push("install"); } },
    { key: "rollback", label: "ย้อนกลับ (Rollback)", group: "deploy", onSelect: () => { calls.push("rollback"); } },
    { key: "duplicate", label: "ทำสำเนา (Duplicate)", group: "other", tone: undefined, onSelect: () => { calls.push("duplicate"); } },
  ]} />,
);
const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "จัดการ (Actions)" }));
const menu = () => screen.getByRole("menu");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("RowMenu", () => {
  it("opens on click and closes on Escape and outside click", () => {
    setup([]);
    expect(screen.queryByRole("menu")).toBeNull();
    openMenu();
    expect(within(menu()).getAllByRole("menuitem")).toHaveLength(3);
    fireEvent.keyDown(menu(), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    openMenu();
    expect(menu()).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("arrow keys move focus between items", () => {
    setup([]);
    openMenu();
    const items = within(menu()).getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu(), { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[2]);
  });

  it("selecting an item calls it and closes the menu", () => {
    const calls: string[] = [];
    setup(calls);
    openMenu();
    fireEvent.click(within(menu()).getAllByRole("menuitem")[1]!);
    expect(calls).toEqual(["rollback"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a disabled item stays in the list with its reason, takes focus, and does nothing when chosen", () => {
    const calls: string[] = [];
    setup(calls, [
      { key: "rollback", label: "ย้อนกลับ", group: "deploy", disabled: true, reason: "เฉพาะเจ้าของย้อนกลับแบรนด์ได้", onSelect: () => { calls.push("rollback"); } },
      { key: "duplicate", label: "ทำสำเนา", group: "other", onSelect: () => { calls.push("duplicate"); } },
    ]);
    openMenu();
    const [rollback, duplicate] = within(menu()).getAllByRole("menuitem");
    expect(rollback!.getAttribute("aria-disabled")).toBe("true");
    expect(rollback!.getAttribute("title")).toBe("เฉพาะเจ้าของย้อนกลับแบรนด์ได้");
    expect(duplicate!.getAttribute("aria-disabled")).toBeNull();
    expect(duplicate!.getAttribute("title")).toBeNull();
    // Focusable: the first item takes focus on open and the arrow keys reach it.
    expect(document.activeElement).toBe(rollback);
    fireEvent.keyDown(menu(), { key: "ArrowDown" });
    fireEvent.keyDown(menu(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(rollback);
    fireEvent.click(rollback!);
    expect(calls).toEqual([]);
    expect(screen.queryByRole("menu")).not.toBeNull();
    fireEvent.click(duplicate!);
    expect(calls).toEqual(["duplicate"]);
  });

  it("renders nothing for an empty list", () => {
    setup([], []);
    expect(screen.queryByRole("button", { name: "จัดการ (Actions)" })).toBeNull();
  });

  it("aria-expanded is false when closed and true when open", () => {
    setup([]);
    const button = screen.getByRole("button", { name: "จัดการ (Actions)" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    openMenu();
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("closes when Tab leaves the menu and when focus moves outside it", () => {
    render(<><RowMenu label="จัดการ (Actions)" items={[{ key: "a", label: "A", onSelect: () => undefined }]} /><button type="button">after</button></>);
    openMenu();
    fireEvent.keyDown(menu(), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "จัดการ (Actions)" }));
    openMenu();
    const item = within(menu()).getByRole("menuitem");
    fireEvent.blur(item, { relatedTarget: screen.getByRole("button", { name: "after" }) });
    expect(screen.queryByRole("menu")).toBeNull();
    openMenu();
    fireEvent.blur(within(menu()).getByRole("menuitem"), { relatedTarget: screen.getByRole("button", { name: "จัดการ (Actions)" }) });
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  // jsdom has no layout: stub the button rect, the viewport and the list size.
  const stubLayout = (rect: { top: number; bottom: number }, innerHeight: number, listHeight: number) => {
    vi.stubGlobal("innerHeight", innerHeight);
    vi.spyOn(HTMLButtonElement.prototype, "getBoundingClientRect").mockReturnValue(
      { ...rect, left: 100, right: 160, width: 60, height: rect.bottom - rect.top, x: 100, y: rect.top, toJSON: () => ({}) } as DOMRect);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "menu" ? listHeight : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "menu" ? 120 : 0;
    });
  };

  it("places the fixed list below the button when it fits", () => {
    stubLayout({ top: 100, bottom: 130 }, 800, 150);
    setup([]);
    openMenu();
    expect(menu().style.position).toBe("fixed");
    expect(menu().style.top).toBe("134px");
  });

  it("flips above the button when it does not fit below but fits above", () => {
    stubLayout({ top: 600, bottom: 630 }, 700, 150);
    setup([]);
    openMenu();
    expect(menu().style.position).toBe("fixed");
    expect(menu().style.top).toBe("446px");
  });

  it("clamps to the viewport and scrolls inside when neither side fits, and stays open on a scroll inside the list", () => {
    stubLayout({ top: 150, bottom: 180 }, 300, 400);
    setup([]);
    openMenu();
    const top = parseFloat(menu().style.top);
    expect(top).toBeGreaterThanOrEqual(8);
    const maxHeight = parseFloat(menu().style.maxHeight);
    expect(maxHeight).toBeGreaterThan(0);
    expect(top + maxHeight).toBeLessThanOrEqual(300 - 8);
    expect(menu().style.overflowY).toBe("auto");
    fireEvent.scroll(menu());
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.scroll(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("focuses with preventScroll on open, on arrow keys and when returning to the button", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    setup([]);
    openMenu();
    expect(focus).toHaveBeenCalled();
    expect(focus.mock.calls.every((call) => (call[0] as FocusOptions | undefined)?.preventScroll === true)).toBe(true);
    focus.mockClear();
    fireEvent.keyDown(menu(), { key: "ArrowDown" });
    fireEvent.keyDown(menu(), { key: "Escape" });
    expect(focus.mock.calls.length).toBe(2);
    expect(focus.mock.calls.every((call) => (call[0] as FocusOptions | undefined)?.preventScroll === true)).toBe(true);
  });

  it("keeps the right edge inside the 8 px margin when the list grows after placement", () => {
    stubLayout({ top: 100, bottom: 130 }, 800, 150);
    vi.stubGlobal("innerWidth", 375);
    // 120 px wide until the list is placed (fixed with a left set), 200 px after (the shrink-to-fit width grew).
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") !== "menu") return 0;
      return this.style.position === "fixed" && this.style.left !== "" ? 200 : 120;
    });
    vi.spyOn(HTMLButtonElement.prototype, "getBoundingClientRect").mockReturnValue(
      { top: 100, bottom: 130, left: 320, right: 370, width: 50, height: 30, x: 320, y: 100, toJSON: () => ({}) } as DOMRect);
    setup([]);
    openMenu();
    const left = parseFloat(menu().style.left);
    expect(left + 200).toBeLessThanOrEqual(375 - 8);
    expect(menu().style.maxWidth).toContain("100vw");
  });

  it("scrolls only the list so a keyboard-focused item stays in view", () => {
    stubLayout({ top: 150, bottom: 180 }, 300, 400);
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    setup([]);
    openMenu();
    const list = menu();
    const items = within(list).getAllByRole("menuitem");
    // 3 items of 40 px in a 80 px clamped list.
    items.forEach((el, i) => {
      Object.defineProperty(el, "offsetTop", { configurable: true, value: i * 40 });
      Object.defineProperty(el, "offsetHeight", { configurable: true, value: 40 });
    });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 80 });
    fireEvent.keyDown(list, { key: "End" });
    expect(document.activeElement).toBe(items[2]);
    expect(list.scrollTop).toBe(40);
    fireEvent.keyDown(list, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    expect(list.scrollTop).toBe(0);
    expect(screen.queryByRole("menu")).not.toBeNull();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("stays open on a document scroll event that leaves the scroll position unchanged", () => {
    stubLayout({ top: 100, bottom: 130 }, 800, 150);
    setup([]);
    openMenu();
    fireEvent.scroll(document);
    expect(screen.queryByRole("menu")).not.toBeNull();
    fireEvent.scroll(window);
    expect(screen.queryByRole("menu")).not.toBeNull();
  });

  it("closes on a window scroll and on resize", () => {
    stubLayout({ top: 100, bottom: 130 }, 800, 150);
    setup([]);
    openMenu();
    vi.stubGlobal("scrollY", 40);
    fireEvent.scroll(window);
    expect(screen.queryByRole("menu")).toBeNull();
    openMenu();
    fireEvent.resize(window);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
