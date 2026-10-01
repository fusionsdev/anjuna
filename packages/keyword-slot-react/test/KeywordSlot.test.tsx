import { act } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeywordSlot, readCfgKeyword } from '../src/KeywordSlot.js';

// Tell React this environment supports act().
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Heading() {
  return (
    <h1>
      <KeywordSlot default="Funding Options" /> | Check Your Options
    </h1>
  );
}

function setCfg(json: string | null) {
  document.getElementById('cfg')?.remove();
  if (json === null) return;
  const el = document.createElement('script');
  el.type = 'application/json';
  el.id = 'cfg';
  el.textContent = json;
  document.head.appendChild(el);
}

afterEach(() => {
  document.body.innerHTML = '';
  setCfg(null);
  vi.restoreAllMocks();
});

describe('readCfgKeyword', () => {
  it('reads cfg.keyword from script#cfg', () => {
    setCfg('{"keyword":"Fast Cash Loans","zip":"10001"}');
    expect(readCfgKeyword()).toBe('Fast Cash Loans');
  });

  it('returns null for missing element, empty keyword, null keyword or bad JSON', () => {
    expect(readCfgKeyword()).toBeNull();
    setCfg('{}');
    expect(readCfgKeyword()).toBeNull();
    setCfg('{"keyword":null}');
    expect(readCfgKeyword()).toBeNull();
    setCfg('{"keyword":"   "}');
    expect(readCfgKeyword()).toBeNull();
    setCfg('{not json');
    expect(readCfgKeyword()).toBeNull();
  });
});

describe('KeywordSlot', () => {
  it('server/static render emits <span data-kw> with the fallback inside the H1', () => {
    const html = renderToString(<Heading />);
    expect(html).toMatch(/^<h1><span data-kw="">Funding Options<\/span>/);
  });

  it('hydrates Worker-rewritten HTML without a hydration mismatch and keeps the keyword', async () => {
    // Static export HTML, after the brand Worker rewrote [data-kw] and filled script#cfg.
    const serverHtml = renderToString(<Heading />).replace('>Funding Options<', '>Fast Cash Loans<');
    setCfg('{"keyword":"Fast Cash Loans"}');
    const container = document.createElement('div');
    container.innerHTML = serverHtml;
    document.body.appendChild(container);
    const span = container.querySelector('[data-kw]')!;

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recoverable: unknown[] = [];
    await act(async () => {
      hydrateRoot(container, <Heading />, { onRecoverableError: (e) => recoverable.push(e) });
    });

    expect(recoverable).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
    // Same DOM node (not re-created by a client fallback render) and the keyword stays.
    expect(container.querySelector('[data-kw]')).toBe(span);
    expect(span.textContent).toBe('Fast Cash Loans');
  });

  it('hydrates untouched HTML (no keyword) without mismatch and keeps the fallback', async () => {
    const serverHtml = renderToString(<Heading />);
    setCfg('{}');
    const container = document.createElement('div');
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recoverable: unknown[] = [];
    await act(async () => {
      hydrateRoot(container, <Heading />, { onRecoverableError: (e) => recoverable.push(e) });
    });

    expect(recoverable).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
    expect(container.querySelector('[data-kw]')!.textContent).toBe('Funding Options');
  });

  it('client-only SPA render shows cfg.keyword on first paint', async () => {
    setCfg('{"keyword":"Bad Credit Options"}');
    const container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      createRoot(container).render(<Heading />);
    });
    expect(container.querySelector('h1 > span[data-kw]')!.textContent).toBe('Bad Credit Options');
  });

  it('renders keyword as text, never as HTML', async () => {
    setCfg(JSON.stringify({ keyword: '<img src=x onerror=alert(1)>' }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      createRoot(container).render(<Heading />);
    });
    const span = container.querySelector('[data-kw]')!;
    expect(span.children).toHaveLength(0);
    expect(span.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
