import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Fixed, neutral internal base path: the brand Worker maps each brand's formRoute onto /_f/.
export default defineConfig({
  base: "/_f/",
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
});
