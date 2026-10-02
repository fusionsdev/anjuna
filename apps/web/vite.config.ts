import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The SPA builds to dist/client, which wrangler serves as the Worker's static assets.
export default defineConfig({
  root: "src/client",
  plugins: [react()],
  build: { outDir: "../../dist/client", emptyOutDir: true },
});
