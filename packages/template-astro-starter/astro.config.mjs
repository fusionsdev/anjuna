// @ts-check
import { defineConfig } from 'astro/config';

// Template contract: static output only. Every page is emitted as <route>/index.html
// so the brand Worker can serve it from its static assets.
export default defineConfig({
  output: 'static',
  trailingSlash: 'ignore',
  build: { format: 'directory', inlineStylesheets: 'always' },
  devToolbar: { enabled: false },
});
