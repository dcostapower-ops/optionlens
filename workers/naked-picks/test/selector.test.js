import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseContract, scoreLiquidity, selectSide } from '../src/selector.js';

const TRIGGER = '2026-10-27';

function snap({ type = 'put', expiry = '2026-12-18', strike, bid, ask, iv, delta, vol, oi }) {
  return {
    details: { ticker: `O:NVDA${expiry.replace(/-/g, '').slice(2)}${type[0].toUpperCase()}${strike}`, contract_type: type, expiration_date: expiry, strike_price: strike },
    last_quote: { bid, ask },
    implied_volatility: iv,
    greeks: { delta },
    day: { volume: vol },
    open_interest: oi,
    underlying_asset: { ticker: 'NVDA', price: 200 },
  };
}
const norm = rows => rows.map(r => normaliseContract(snap(r), TRIGGER));

test('rule 1: expiries under 45 days are excluded', () => {
  const rows = norm([
    { expiry: '2026-11-20', strike: 180, bid: 3, ask: 3.1, iv: 0.4, delta: -0.25, vol: 99999, oi: 99999 },
    { expiry: '2026-12-18', strike: 180, bid: 6, ask: 6.2, iv: 0.45, delta: -0.25, vol: 10, oi: 10 },
  ]);
  const out = selectSide(rows, 'put');
  assert.equal(out.length, 1);
  assert.equal(out[0].expiry, '2026-12-18');
  assert.ok(out[0].dte >= 45);
});

test('rule 1: exactly 45 days is allowed', () => {
  const rows = norm([{ expiry: '2026-12-11', strike: 180, bid: 6, ask: 6.2, iv: 0.45, delta: -0.25, vol: 10, oi: 10 }]);
  assert.equal(selectSide(rows, 'put').length, 1);
});

test('rule 2a: liquidity ranks within each chain and across chains', () => {
  const rows = norm([
    { expiry: '2026-12-18', strike: 170, bid: 1, ask: 1.1, iv: 0.4, delta: -0.2, vol: 100, oi: 1000 },
    { expiry: '2026-12-18', strike: 175, bid: 1, ask: 1.1, iv: 0.4, delta: -0.2, vol: 10, oi: 100 },
    { expiry: '2027-01-15', strike: 170, bid: 1, ask: 1.1, iv: 0.4, delta: -0.2, vol: 50, oi: 500 },
  ]);
  const scored = scoreLiquidity(rows).sort((a, b) => b.liquidity - a.liquidity);
  assert.equal(scored[0].strike, 170);
  assert.equal(scored[0].expiry, '2026-12-18');
  // Alone in its chain, the Jan contract tops its own chain and beats the Dec laggard.
  assert.equal(scored[1].expiry, '2027-01-15');
});

test('illiquid contracts never reach the shortlist when the pool is full', () => {
  const rows = norm([
    ...Array.from({ length: 4 }, (_, i) => ({ strike: 160 + i, bid: 2, ask: 2.1, iv: 0.5, delta: -0.25, vol: 1000 + i, oi: 5000 + i })),
    { strike: 150, bid: 9, ask: 9.1, iv: 0.2, delta: -0.25, vol: 1, oi: 1 },
  ]);
  const out = selectSide(rows, 'put', { liquidityPool: 4 });
  assert.ok(!out.some(r => r.strike === 150));
});

test('rule 2b: cheapest IV survives the IV cut', () => {
  const rows = norm([
    { strike: 160, bid: 2, ask: 2.1, iv: 0.60, delta: -0.25, vol: 900, oi: 900 },
    { strike: 161, bid: 2, ask: 2.1, iv: 0.40, delta: -0.25, vol: 800, oi: 800 },
    { strike: 162, bid: 2, ask: 2.1, iv: 0.50, delta: -0.25, vol: 700, oi: 700 },
  ]);
  const out = selectSide(rows, 'put', { ivPool: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].iv, 0.40);
});

test('rule 2c: in-band delta closest to target wins the delta cut', () => {
  const rows = norm([
    { strike: 160, bid: 2, ask: 2.1, iv: 0.4, delta: -0.05, vol: 900, oi: 900 },
    { strike: 170, bid: 2, ask: 2.1, iv: 0.4, delta: -0.24, vol: 900, oi: 900 },
    { strike: 185, bid: 2, ask: 2.1, iv: 0.4, delta: -0.45, vol: 900, oi: 900 },
  ]);
  const out = selectSide(rows, 'put', { deltaPool: 1, highlight: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].strike, 170);
  assert.equal(out[0].deltaInBand, true);
});

test('rule 2c: tops up with nearest out-of-band deltas to fill 3 rows', () => {
  const rows = norm([
    { strike: 170, bid: 2, ask: 2.1, iv: 0.4, delta: -0.25, vol: 900, oi: 900 },
    { strike: 160, bid: 1, ask: 1.1, iv: 0.4, delta: -0.10, vol: 900, oi: 900 },
    { strike: 150, bid: 0.5, ask: 0.6, iv: 0.4, delta: -0.02, vol: 900, oi: 900 },
  ]);
  const out = selectSide(rows, 'put');
  assert.equal(out.length, 3);
  assert.equal(out.filter(r => !r.deltaInBand).length, 2);
});

test('rule 2d: richer premium with tighter spread ranks first; top 3 highlighted', () => {
  const rows = norm([
    { strike: 170, bid: 4.0, ask: 4.1, iv: 0.40, delta: -0.25, vol: 900, oi: 900 },
    { strike: 171, bid: 4.0, ask: 6.0, iv: 0.40, delta: -0.25, vol: 900, oi: 900 },
    { strike: 172, bid: 3.0, ask: 3.1, iv: 0.40, delta: -0.25, vol: 900, oi: 900 },
    { strike: 173, bid: 2.0, ask: 2.1, iv: 0.40, delta: -0.25, vol: 900, oi: 900 },
  ]);
  const out = selectSide(rows, 'put');
  assert.deepEqual(out.map(r => r.strike), [170, 172, 171, 173]);
  assert.deepEqual(out.map(r => r.highlight), [true, true, true, false]);
  assert.deepEqual(out.map(r => r.rank), [1, 2, 3, 4]);
});

test('calls and puts are selected independently; bad quotes skipped', () => {
  const rows = norm([
    { type: 'call', strike: 230, bid: 3, ask: 3.1, iv: 0.4, delta: 0.25, vol: 500, oi: 500 },
    { type: 'call', strike: 240, bid: 0, ask: 0.1, iv: 0.4, delta: 0.20, vol: 500, oi: 500 },
    { type: 'put', strike: 170, bid: 3, ask: 3.1, iv: 0.4, delta: -0.25, vol: 500, oi: 500 },
  ]);
  assert.deepEqual(selectSide(rows, 'call').map(r => r.strike), [230]);
  assert.deepEqual(selectSide(rows, 'put').map(r => r.strike), [170]);
});
