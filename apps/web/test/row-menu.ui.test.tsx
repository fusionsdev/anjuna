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

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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

  it("renders nothing for an empty list", () => {
    setup([], []);
    expect(screen.queryByRole("button", { name: "จัดการ (Actions)" })).toBeNull();
  });
});
