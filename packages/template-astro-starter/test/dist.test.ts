import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// These tests read the built static output. Turborepo runs `build` before `test`
// for this package (see turbo.json); standalone, run `bun run build` first.
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const AMOUNTS = ['350', '500', '750', '1000', '1500', '1750', '2000', '3000', '3250', '4500', '5000'];

function htmlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return htmlFiles(p);
    return p.endsWith('.html') ? [p] : [];
  });
}

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

let index = '';

beforeAll(() => {
  if (!existsSync(join(dist, 'index.html'))) {
    throw new Error('dist/index.html missing: run `bun run build` in packages/template-astro-starter first');
  }
  index = readFileSync(join(dist, 'index.html'), 'utf8');
});

describe('astro starter static output', () => {
  it('builds index and every legal page to static dist/', () => {
    for (const page of ['index.html', 'privacy/index.html', 'terms/index.html', 'do-not-sell/index.html', 'disclosures/index.html']) {
      expect(existsSync(join(dist, page)), page).toBe(true);
    }
  });

  it('H1 contains exactly one <span data-kw> with the fallback text', () => {
    const h1s = index.match(/<h1[^>]*>[\s\S]*?<\/h1>/g) ?? [];
    expect(h1s).toHaveLength(1);
    const h1 = h1s[0]!;
    expect(h1).toContain('<span data-kw>');
    expect(h1).toMatch(/<span data-kw>Funding Options<\/span>/);
    expect(index.match(/data-kw/g)).toHaveLength(1);
  });

  it('CTA form posts with GET to /go and is marked data-cta', () => {
    const forms = index.match(/<form[^>]*>/g) ?? [];
    expect(forms).toHaveLength(1);
    const form = forms[0]!;
    expect(form).toMatch(/action="\/go"/);
    expect(form).toMatch(/method="get"/);
    expect(form).toMatch(/\sdata-cta[\s>=]/);
  });

  it('CTA collects only requested_amount and a 5-digit zip', () => {
    const names = [...index.matchAll(/<(?:input|select|textarea)\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]);
    expect(names.sort()).toEqual(['requested_amount', 'zip']);
    const options = [...index.matchAll(/<option[^>]*value="(\d+)"/g)].map((m) => m[1]);
    expect(options).toEqual(AMOUNTS);
    expect(index).toMatch(/<input[^>]*name="zip"[^>]*pattern="\[0-9\]\{5\}"/);
  });

  it('links every legal page and renders a disclosure', () => {
    for (const href of ['/privacy/', '/terms/', '/do-not-sell/', '/disclosures/']) {
      expect(index).toContain(`href="${href}"`);
    }
    expect(index).toContain('data-disclosure');
  });

  it('contains no scripts, analytics, PII inputs, banned wording or platform identifiers', () => {
    for (const file of allFiles(dist)) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/personal\s+loans?/i);
      expect(text, file).not.toMatch(/anjuna|aurum/i);
      if (!file.endsWith('.html')) continue;
      expect(text, file).not.toMatch(/<script\b(?![^>]*type="application\/json")/i);
      expect(text, file).not.toMatch(/gtag|googletagmanager|posthog|sentry|google-analytics/i);
      expect(text, file).not.toMatch(/name="(?:first_?name|last_?name|email|phone|ssn|dob|address|street)"/i);
      expect(text, file).not.toMatch(/type="(?:email|tel|password)"/i);
    }
    expect(htmlFiles(dist).length).toBeGreaterThanOrEqual(5);
  });
});
