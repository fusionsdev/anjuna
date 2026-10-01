// Static-export smoke: render a minimal contract-compliant page with react-dom/server, exactly
// as a vinext / Next.js `output: 'export'` build would, and write it to dist/example/index.html.
// No scripts are emitted; the brand Worker rewrites [data-kw] and fills script#cfg at request time.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { KeywordSlot } from '../src/KeywordSlot.js';

const AMOUNTS = [350, 500, 750, 1000, 1500, 1750, 2000, 3000, 3250, 4500, 5000];

function Page() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Example Brand | Check Your Options</title>
        <script type="application/json" id="cfg" dangerouslySetInnerHTML={{ __html: '{}' }} />
      </head>
      <body>
        <main>
          <h1>
            <KeywordSlot default="Funding Options" /> | Check Your Options in Minutes
          </h1>
          <form method="get" action="/go" data-cta="">
            <select name="requested_amount" required defaultValue="1000">
              {AMOUNTS.map((a) => (
                <option key={a} value={String(a)}>
                  ${a.toLocaleString('en-US')}
                </option>
              ))}
            </select>
            <input name="zip" inputMode="numeric" pattern="[0-9]{5}" minLength={5} maxLength={5} required />
            <button type="submit">Continue</button>
          </form>
        </main>
      </body>
    </html>
  );
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'example', 'index.html');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, '<!doctype html>' + renderToStaticMarkup(<Page />));
console.log(`wrote ${out}`);
