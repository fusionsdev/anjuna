// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Reads the build output. Turborepo runs `build` before `test` for this package (turbo.json).
const dist = (p: string) => join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', p);

describe('keyword-slot-react static output', () => {
  it('emits the library to dist/lib', () => {
    expect(existsSync(dist('lib/index.js'))).toBe(true);
    expect(existsSync(dist('lib/index.d.ts'))).toBe(true);
  });

  it('static export example has <span data-kw> inside the H1, a cfg slot and a CTA to /go', () => {
    const html = readFileSync(dist('example/index.html'), 'utf8');
    const h1 = html.match(/<h1[^>]*>[\s\S]*?<\/h1>/)?.[0] ?? '';
    expect(h1).toMatch(/<span data-kw="">Funding Options<\/span>/);
    expect(html).toContain('<script type="application/json" id="cfg">{}</script>');
    const form = html.match(/<form[^>]*>/)?.[0] ?? '';
    expect(form).toContain('method="get"');
    expect(form).toContain('action="/go"');
    expect(form).toContain('data-cta=""');
    expect(html).not.toMatch(/<script\b(?![^>]*type="application\/json")/);
    expect(html).not.toMatch(/personal\s+loans?/i);
  });
});
