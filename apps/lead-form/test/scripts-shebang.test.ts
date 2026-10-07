import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPTS = join(__dirname, "..", "scripts");

describe("scripts imported by tests", () => {
  it("do not start with a shebang (Vite 7 ssrTransform breaks on CRLF shebangs)", () => {
    for (const name of readdirSync(SCRIPTS).filter((file) => file.endsWith(".mjs"))) {
      expect(readFileSync(join(SCRIPTS, name), "utf8").startsWith("#!"), name).toBe(false);
    }
  });
});
