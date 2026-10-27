import test from 'node:test';
import assert from 'node:assert/strict';
import { bestAcross, eventFlags, normaliseContract, priceScore, rejectReason, DEFAULTS, selectSide } from '../src/selector.js';
import { parseNasdaqEarnings } from '../src/earnings.js';

const TRIGGER = '2026-10-27';
const SPOT = 200;

// Defaults describe a liquid, tight, in-band 0.70 call; override per test.
function c(o = {}) {
  const type = o.type ?? 'call';
  const expiry = o.expiry ?? '2026-12-18';
  const strike = o.strike ?? 180;
  const bid = o.bid ?? 25;
  return normaliseContract({
    details: { ticker: `O:NVDA${expiry}${type[0]}${strike}${o.tag ?? ''}`, contract_type: type, expiration_date: expiry, strike_price: strike },
    last_quote: { bid, ask: o.ask ?? +(bid * 1.02).toFixed(2) },
    implied_volatility: o.iv ?? 0.4,
    greeks: { delta: o.delta ?? (type === 'call' ? 0.7 : -0.7) },
    day: { volume: o.vol ?? 1000 },
    open_interest: o.oi ?? 5000,
    underlying_asset: { ticker: o.und ?? 'NVDA', price: o.spot ?? SPOT },
  }, TRIGGER);
}
const run = (rows, type = 'call', opts) => selectSide(rows, type, opts, {}, TRIGGER).rows;

test('rule 1: expiry window 45..365 days, both ends inclusive', () => {
  const o = DEFAULTS;
  assert.equal(rejectReason(c({ expiry: '2026-12-10' }), o), 'expiry'); // 44
  assert.equal(rejectReason(c({ expiry: '2026-12-11' }), o), null);     // 45
  assert.equal(rejectReason(c({ expiry: '2027-10-27' }), o), null);     // 365
  assert.equal(rejectReason(c({ expiry: '2027-10-28' }), o), 'expiry'); // 366
});

test('rule 2: calls need +0.65..+0.75, puts need -0.65..-0.75', () => {
  const o = DEFAULTS;
  assert.equal(rejectReason(c({ delta: 0.70 }), o), null);
  assert.equal(rejectReason(c({ delta: 0.60 }), o), 'delta');
  assert.equal(rejectReason(c({ delta: 0.80 }), o), 'delta');
  assert.equal(rejectReason(c({ type: 'put', strike: 220, delta: -0.70 }), o), null);
  assert.equal(rejectReason(c({ type: 'put', strike: 220, delta: -0.28 }), o), 'delta');
  assert.equal(rejectReason(c({ type: 'put', strike: 220, delta: 0.70 }), o), 'quote'); // wrong sign
});

test('rule 3: open interest, volume and spread thresholds', () => {
  const o = DEFAULTS;
  assert.equal(rejectReason(c({ oi: 499 }), o), 'liquidity');
  assert.equal(rejectReason(c({ vol: 49 }), o), 'liquidity');
  assert.equal(rejectReason(c({ bid: 25, ask: 26.3 }), o), 'spread'); // ~5.1%
  assert.equal(rejectReason(c({ bid: 25, ask: 26.2 }), o), null);     // ~4.7%
  assert.equal(rejectReason(c({ bid: 15, ask: 15.2 }), o), 'quote');  // ask below $20 intrinsic
});

test('rule 4: only the top liquidity pool goes forward', () => {
  const rows = [
    ...Array.from({ length: 4 }, (_, i) => c({ strike: 180 + i, vol: 5000 + i, oi: 20000 + i, bid: 25 - i })),
    c({ strike: 179, vol: 60, oi: 600, bid: 26, iv: 0.2 }),
  ];
  const out = run(rows, 'call', { liquidityPool: 4 });
  assert.ok(!out.some(r => r.strike === 179));
});

test('rule 5: lowest IV survives the IV cut', () => {
  const rows = [c({ strike: 180, iv: 0.55 }), c({ strike: 181, iv: 0.35 }), c({ strike: 182, iv: 0.45 })];
  const out = run(rows, 'call', { ivPool: 1 });
  assert.deepEqual(out.map(r => r.iv), [0.35]);
});

test('rule 6: time value = ask - intrinsic; cost per day as % of spot', () => {
  const s = priceScore(c({ strike: 180, bid: 25, ask: 25.5, expiry: '2026-12-11' }));
  assert.equal(s.timeValue, 5.5);                         // 25.5 - (200 - 180)
  assert.ok(Math.abs(s.costPerDayPct - 5.5 / 45 / 200) < 1e-12);
  const put = priceScore(c({ type: 'put', strike: 220, bid: 25, ask: 25.5 }));
  assert.equal(put.timeValue, 5.5);                       // 25.5 - (220 - 200)
});

test('rule 6: least time value per day ranks first; top 3 highlighted', () => {
  const rows = [
    c({ strike: 180, bid: 26, ask: 26.4, tag: 'a' }),                         // tv 6.4 / 52d
    c({ strike: 181, bid: 24, ask: 24.4, tag: 'b' }),                         // tv 5.4 / 52d
    c({ strike: 182, bid: 28, ask: 28.4, expiry: '2027-06-17', tag: 'c' }),   // tv 10.4 / 233d — cheapest per day
    c({ strike: 183, bid: 23, ask: 23.4, tag: 'd' }),                         // tv 6.4 / 52d
  ];
  const out = run(rows);
  assert.equal(out[0].expiry, '2027-06-17');
  assert.equal(out[1].strike, 181);
  assert.deepEqual(out.map(r => r.highlight), [true, true, true, false]);
  assert.deepEqual(out.map(r => r.rank), [1, 2, 3, 4]);
});

test('no padding: fewer than 3 qualified shows only those, with counts', () => {
  const res = selectSide([c(), c({ strike: 170, delta: 0.85 }), c({ strike: 175, oi: 10 })], 'call', {}, {}, TRIGGER);
  assert.equal(res.rows.length, 1);
  assert.equal(res.qualified, 1);
  assert.equal(res.scanned, 3);
});

test('rules 7/8: earnings flagged both sides, ex-dividend flagged on calls only', () => {
  const ev = { earningsDate: '2026-11-18', exDividendDate: '2026-12-04' };
  assert.deepEqual(eventFlags(c({ expiry: '2026-12-18' }), ev, TRIGGER), { earningsDate: '2026-11-18', exDividendDate: '2026-12-04' });
  assert.deepEqual(eventFlags(c({ type: 'put', expiry: '2026-12-18' }), ev, TRIGGER), { earningsDate: '2026-11-18', exDividendDate: null });
  assert.deepEqual(eventFlags(c({ expiry: '2026-12-18' }), { earningsDate: '2027-02-25' }, TRIGGER), { earningsDate: null, exDividendDate: null });
});

test('best across stocks uses the spot-normalised daily cost', () => {
  const stocks = [
    { underlying: 'NVDA', calls: [{ symbol: 'a', cost: 0.0006 }, { symbol: 'b', cost: 0.0004 }] },
    { underlying: 'AAPL', calls: [{ symbol: 'c', cost: 0.0005 }, { symbol: 'd', cost: 0.0009 }] },
  ];
  assert.deepEqual(bestAcross(stocks, 'calls').map(r => `${r.underlying}:${r.symbol}`), ['NVDA:b', 'AAPL:c', 'NVDA:a']);
});

test('Nasdaq earnings text parses to ISO date', () => {
  assert.deepEqual(parseNasdaqEarnings({ data: { reportText: 'NVIDIA ... is estimated to report earnings on  11/18/2026. ...' } }), { date: '2026-11-18', estimated: true });
  assert.deepEqual(parseNasdaqEarnings({ data: { reportText: 'Apple ... is expected* to report earnings on  11/02/2026 after market close.' } }), { date: '2026-11-02', estimated: false });
  assert.equal(parseNasdaqEarnings({ data: { reportText: "hasn't provided us with the upcoming earnings report date." } }), null);
});
