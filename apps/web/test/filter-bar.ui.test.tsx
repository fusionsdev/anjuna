import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FilterBar } from "../src/client/components/FilterBar";

afterEach(cleanup);

const original = window.matchMedia;
const stub = (matches: boolean) => {
  window.matchMedia = ((query: string) => ({
    matches, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
};
const restore = () => { window.matchMedia = original; };

const controls = <label>แบรนด์ (Brand)<input type="text" aria-label="แบรนด์ (Brand)" /></label>;

describe("FilterBar", () => {
  it("renders children inline when wide", () => {
    stub(false);
    try {
      render(<FilterBar label="ตัวกรอง (Filters)" activeCount={0}>{controls}</FilterBar>);
      expect(screen.getByLabelText("แบรนด์ (Brand)").closest("label")!.textContent).toContain("แบรนด์");
      expect(screen.queryByRole("button", { name: /ตัวกรอง \(Filters\)/ })).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      restore();
    }
  });

  it("renders a Filters button with the active count when narrow", () => {
    stub(true);
    try {
      render(<FilterBar label="ตัวกรอง (Filters)" activeCount={2}>{controls}</FilterBar>);
      expect(screen.getByRole("button", { name: /ตัวกรอง \(Filters\).*2/ })).toBeTruthy();
      expect(screen.queryByLabelText("แบรนด์ (Brand)")).toBeNull();
    } finally {
      restore();
    }
  });

  it("the Filters button opens a modal with the controls and Done closes it", () => {
    stub(true);
    try {
      render(<FilterBar label="ตัวกรอง (Filters)" activeCount={1}>{controls}</FilterBar>);
      fireEvent.click(screen.getByRole("button", { name: /ตัวกรอง \(Filters\)/ }));
      const dialog = screen.getByRole("dialog", { name: "ตัวกรอง (Filters)" });
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(dialog.className).toContain("modal-wrap");
      expect(within(dialog).getByLabelText("แบรนด์ (Brand)")).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "เสร็จ (Done)" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByLabelText("แบรนด์ (Brand)")).toBeNull();
    } finally {
      restore();
    }
  });

  it("opening the filter modal moves focus inside and Tab stays inside", () => {
    stub(true);
    try {
      render(<FilterBar label="ตัวกรอง (Filters)" activeCount={0}>{controls}</FilterBar>);
      fireEvent.click(screen.getByRole("button", { name: /ตัวกรอง \(Filters\)/ }));
      const dialog = screen.getByRole("dialog", { name: "ตัวกรอง (Filters)" });
      expect(dialog.contains(document.activeElement)).toBe(true);
      const input = within(dialog).getByLabelText("แบรนด์ (Brand)");
      const done = within(dialog).getByRole("button", { name: "เสร็จ (Done)" });
      done.focus();
      fireEvent.keyDown(done, { key: "Tab" });
      expect(document.activeElement).toBe(input);
      fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(done);
    } finally {
      restore();
    }
  });

  it("closing the filter modal returns focus to the Filters button", () => {
    stub(true);
    try {
      render(<FilterBar label="ตัวกรอง (Filters)" activeCount={0}>{controls}</FilterBar>);
      const filters = screen.getByRole("button", { name: /ตัวกรอง \(Filters\)/ });
      fireEvent.click(filters);
      const dialog = screen.getByRole("dialog", { name: "ตัวกรอง (Filters)" });
      fireEvent.click(within(dialog).getByRole("button", { name: "เสร็จ (Done)" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(filters);
      fireEvent.click(filters);
      expect(screen.getByRole("dialog")).toBeTruthy();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(filters);
    } finally {
      restore();
    }
  });

  it("Escape closes the filter modal", () => {
    stub(true);
    try {
      render(<FilterBar label="ตัวกรอง (Filters)" activeCount={0}>{controls}</FilterBar>);
      fireEvent.click(screen.getByRole("button", { name: /ตัวกรอง \(Filters\)/ }));
      expect(screen.getByRole("dialog")).toBeTruthy();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      restore();
    }
  });
});
