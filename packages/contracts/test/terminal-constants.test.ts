import { describe, expect, it } from "vitest";
import { TERMINAL_LINE_MAX, TERMINAL_OUTPUT_MAX } from "../src/adkit.js";
import * as allow from "../../../scripts/drain/adkit-allowlist.mjs";

describe("terminal limits", () => {
  it("contracts and the shared allowlist module agree", () => {
    expect(TERMINAL_LINE_MAX).toBe(allow.TERMINAL_LINE_MAX);
    expect(TERMINAL_OUTPUT_MAX).toBe(allow.TERMINAL_OUTPUT_MAX);
  });
});
