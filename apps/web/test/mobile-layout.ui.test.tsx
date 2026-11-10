import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckHit } from "../src/client/components/CheckHit";
import { TemplatesScreen } from "../src/client/screens/Templates";

/**
 * jsdom has no layout, so these tests read the cascade instead: the real stylesheets are put in the document and the computed style of the
 * elements is read. jsdom applies an @media rule only when its media list is exactly "screen", so the 767px rules are rewritten to
 * "@media screen" for the mobile case and left out (as at desktop width) for the other. A card that clips text at 375px has a
 * min-width in the chain from the text to the card; the tests walk that chain. The real widths at 375px are measured in headless Chrome (see the PR).
 */
const read = (file: string) => readFileSync(join(__dirname, "../src/client", file), "utf8").replace(/\r\n/g, "\n");
const SHEETS = [read("styles.css"), read("screens/Templates.css")];
const mobile = (css: string) => css.replace(/@media \(max-width: 767px\)/g, "@media screen");
const useSheets = (asMobile: boolean) => {
  const style = document.createElement("style");
  style.setAttribute("data-test-sheet", "");
  style.textContent = SHEETS.map((css) => (asMobile ? mobile(css) : css)).join("\n");
  document.head.appendChild(style);
};

const LONG_NAME = "เทมเพลตสินเชื่อส่วนบุคคลฉบับยาวมากสำหรับตรวจการตัดคำที่หน้าจอสามร้อยเจ็ดสิบห้าพิกเซล";
const LONG_SENDER = "ผู้ส่งที่มีชื่อยาวมากมากมากมากมากมาก (partner-with-a-very-long-name-for-the-wrap-check)";
const template = {
  template_version_id: "tv-long", template_id: "tpl-with-a-very-long-template-identifier-that-has-no-break", name: LONG_NAME, version: 3, status: "awaiting_approval",
  submitted_by_label: LONG_SENDER, created_at: "2026-11-01T00:00:00.000Z", sealed_at: null, thumbnail_url: "/api/templates/tv-long/screenshots/desktop", brands_using: 0, archived: false, category_id: null, was_approved: false,
};
const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (input.startsWith("/api/templates")) return new Response(JSON.stringify({ templates: [template], categories: [] }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`Unexpected test HTTP request: ${input}`);
  }));
});
afterEach(() => {
  cleanup();
  document.head.querySelectorAll("[data-test-sheet]").forEach((node) => node.remove());
  vi.unstubAllGlobals();
});

const px = (value: string) => (value === "" || value === "auto" || value === "none" ? 0 : Number.parseFloat(value));
const widthOf = (element: Element, property: "min-width" | "width") => px(getComputedStyle(element).getPropertyValue(property));

describe("Templates name cell in a 375px card", () => {
  it("sees the 220px minimum at desktop width, so the test can tell the two cases apart", async () => {
    useSheets(false);
    render(<TemplatesScreen me={owner} />);
    const text = (await screen.findByText(LONG_NAME)).closest(".tpl-name-cell > div")!;
    expect(widthOf(text, "min-width")).toBe(220);
  });

  it("has no minimum width anywhere between the sender text and the card, so nothing is pushed out of it", async () => {
    useSheets(true);
    render(<TemplatesScreen me={owner} />);
    const name = await screen.findByText(LONG_NAME);
    const sender = screen.getByText(/ส่งโดย/, { selector: "small" });
    expect(sender.textContent).toContain(LONG_SENDER);
    for (const start of [name, sender]) {
      let node: Element | null = start;
      const chain: string[] = [];
      while (node && node.tagName !== "TR") {
        chain.push(`${node.tagName.toLowerCase()}.${node.className}=${widthOf(node, "min-width")}`);
        expect(widthOf(node, "min-width"), chain.join(" > ")).toBe(0);
        node = node.parentElement;
      }
      expect(node?.tagName).toBe("TR");
    }
  });

  it("wraps a long name, id and sender instead of clipping them, and keeps the 64px thumbnail", async () => {
    useSheets(true);
    render(<TemplatesScreen me={owner} />);
    const cell = (await screen.findByText(LONG_NAME)).closest(".tpl-name-cell")!;
    const textColumn = cell.querySelector(":scope > div")!;
    expect(getComputedStyle(textColumn).overflowWrap).toBe("anywhere");
    expect(getComputedStyle(textColumn).flexShrink).toBe("1");
    expect(getComputedStyle(cell.querySelector(".tpl-open")!).whiteSpace).toBe("normal");
    const small = textColumn.querySelector("small")!;
    expect(getComputedStyle(small).display).toBe("block");
    // The text is in the document and not hidden by the cell or the card.
    for (let node: Element | null = small; node && node.tagName !== "TR"; node = node.parentElement) {
      const style = getComputedStyle(node);
      expect(style.display, node.tagName).not.toBe("none");
      expect(style.visibility, node.tagName).not.toBe("hidden");
    }
    expect(getComputedStyle(cell.querySelector(".tpl-thumb")!).flexBasis).toBe("64px");
  });
});

describe("checkbox hit area", () => {
  it("is a label of at least 44 by 44 px around a box that stays small, in a stacked card and at desktop width", async () => {
    for (const asMobile of [true, false]) {
      document.head.querySelectorAll("[data-test-sheet]").forEach((node) => node.remove());
      useSheets(asMobile);
      const view = render(<TemplatesScreen me={owner} />);
      const box = await screen.findByRole("checkbox", { name: /^เลือก เทมเพลต/ });
      const hit = box.closest("label.check-hit")!;
      expect(hit, "the checkbox sits in a label").toBeTruthy();
      expect(widthOf(hit, "min-width")).toBeGreaterThanOrEqual(44);
      expect(px(getComputedStyle(hit).minHeight)).toBeGreaterThanOrEqual(44);
      expect(getComputedStyle(hit).display).toBe("inline-flex");
      if (asMobile) {
        // The glyph is 24px; the label around it is the 44px target.
        expect(px(getComputedStyle(box).width)).toBe(24);
        expect(px(getComputedStyle(box).height)).toBe(24);
      }
      view.unmount();
    }
  });

  it("toggles the box when the label around it is clicked, and keeps the accessible name on the input", () => {
    const seen: boolean[] = [];
    render(<CheckHit aria-label="เลือกแถวนี้" checked={false} onChange={(e) => seen.push(e.target.checked)} />);
    const box = screen.getByRole("checkbox", { name: "เลือกแถวนี้" });
    box.closest("label")!.click();
    expect(seen).toEqual([true]);
  });
});
