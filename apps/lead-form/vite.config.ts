import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// FO-3: fixed, neutral internal base path. The brand Worker serves /_f/index.html at each brand's
// formRoute and maps /_f/assets/* straight through, so the bundle is identical for every brand.
export default defineConfig({
  base: "/_f/",
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
