import { build } from "esbuild";

// Server-side Worker script for the factory (`runtime/brand-runtime.js`). It is uploaded as the
// brand Worker's module and is never served to visitors; brand-byte checks apply to responses.
await build({
  entryPoints: ["src/entry.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: "dist/brand-runtime.js",
  conditions: ["workerd", "worker", "browser"],
});
