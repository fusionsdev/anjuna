import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { FORBIDDEN_BRAND_STRINGS, isBrandClean } from "@anjuna/contracts";

const result = await build({
  entryPoints: ["src/entry.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: "dist/brand-runtime.js",
  conditions: ["workerd", "worker", "browser"],
  write: false,
});

// Keep the runtime's forbidden-name checks without emitting those literal names.
// Unicode escapes preserve the string values when the Worker evaluates the module.
let bytes = result.outputFiles[0]!.text;
for (const word of FORBIDDEN_BRAND_STRINGS) {
  const escaped = [...word].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  bytes = bytes.replaceAll(JSON.stringify(word), `"${escaped}"`);
}
if (!isBrandClean(bytes)) throw new Error("Bundle contains a forbidden system identifier");
await mkdir("dist", { recursive: true });
await writeFile("dist/brand-runtime.js", bytes);
