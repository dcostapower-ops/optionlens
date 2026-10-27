import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The Supabase edge function ships copies of the shared selection code.
for (const f of ['selector', 'market-hours', 'earnings']) {
  test(`supabase copy of ${f}.js matches the worker source`, () => {
    const src = readFileSync(new URL(`../src/${f}.js`, import.meta.url), 'utf8');
    const copy = readFileSync(new URL(`../../../supabase/functions/option-buy-picks/lib/${f}.js`, import.meta.url), 'utf8');
    assert.equal(copy.slice(copy.indexOf('\n') + 1), src);
  });
}

test('StockVizor /picks page matches the worker dashboard apart from the Supabase feed config', () => {
  const strip = s => s.replace(/<meta name="picks-supabase-(url|key)" content="[^"]*">/g, '');
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const site = readFileSync(new URL('../../../public/picks.html', import.meta.url), 'utf8');
  assert.equal(strip(site), strip(page));
  assert.match(site, /picks-supabase-url" content="https:\/\//);
});
