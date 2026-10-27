// Strike-selection funnel for buying calls and puts (long, single-leg).
//
//   1  expiry between minDte and maxDte calendar days from the trigger date
//   2  |delta| inside [deltaMin, deltaMax] (calls +, puts −)
//   3  quality: open interest, today's volume, bid/ask spread
//   4  liquidity: volume + open interest, ranked inside each expiry chain and
//      across all chains — keep the top liquidityPool
//   5  lowest IV — keep the ivPool cheapest
//   6  best price: least time value paid per day held, as % of spot,
//      with a spread penalty (you pay the spread on entry and exit)
//   7/8 earnings and ex-dividend (calls) dates before expiry are flagged
//
// Pure functions only: no I/O, so the funnel is unit-testable.

import { daysBetween } from './market-hours.js';

export const DEFAULTS = {
  minDte: 45,
  maxDte: 365,
  deltaMin: 0.65,
  deltaMax: 0.75,
  minOpenInterest: 500,
  minVolume: 50,
  maxSpreadPct: 0.05,
  liquidityPool: 10,
  ivPool: 6,
  rowsPerSide: 5,
  highlight: 3,
};

// Normalise one Massive /v3/snapshot/options result into a flat row.
export function normaliseContract(r, triggerDate) {
  const d = r.details ?? {};
  const q = r.last_quote ?? {};
  const expiry = d.expiration_date;
  if (!expiry || d.strike_price == null) return null;
  return {
    symbol: d.ticker,
    underlying: r.underlying_asset?.ticker,
    spot: r.underlying_asset?.price ?? null,
    type: d.contract_type, // 'call' | 'put'
    expiry,
    dte: daysBetween(triggerDate, expiry),
    strike: d.strike_price,
    bid: q.bid ?? null,
    ask: q.ask ?? null,
    iv: r.implied_volatility ?? null,
    delta: r.greeks?.delta ?? null,
    volume: r.day?.volume ?? 0,
    openInterest: r.open_interest ?? 0,
  };
}

export function spreadPct(c) {
  const mid = (c.bid + c.ask) / 2;
  return mid > 0 ? (c.ask - c.bid) / mid : Infinity;
}

export function intrinsic(c) {
  if (c.spot == null) return null;
  return Math.max(0, c.type === 'call' ? c.spot - c.strike : c.strike - c.spot);
}

// Rules 1–3. Returns the reason a contract fails, or null if it passes.
export function rejectReason(c, o) {
  if (c.dte < o.minDte || c.dte > o.maxDte) return 'expiry';
  if (!(c.bid > 0) || !(c.ask >= c.bid) || !(c.iv > 0) || c.delta == null) return 'quote';
  if ((c.type === 'call') !== (c.delta > 0)) return 'quote';
  const d = Math.abs(c.delta);
  if (d < o.deltaMin || d > o.deltaMax) return 'delta';
  if (c.openInterest < o.minOpenInterest || c.volume < o.minVolume) return 'liquidity';
  if (spreadPct(c) > o.maxSpreadPct) return 'spread';
  const iv = intrinsic(c);
  if (iv != null && c.ask < iv) return 'quote'; // ask below intrinsic: stale quote
  return null;
}

// Percentile rank (0..1, ties share the average rank) of `key` within rows.
function percentileRanks(rows, key) {
  const out = new Map();
  if (rows.length === 1) { out.set(rows[0], 1); return out; }
  const sorted = [...rows].sort((a, b) => a[key] - b[key]);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1][key] === sorted[i][key]) j++;
    const pct = ((i + j) / 2) / (sorted.length - 1);
    for (let k = i; k <= j; k++) out.set(sorted[k], pct);
    i = j + 1;
  }
  return out;
}

// Rule 4 — mean of volume and OI percentile, inside the contract's own
// expiry chain and across all chains.
export function scoreLiquidity(rows) {
  const crossVol = percentileRanks(rows, 'volume');
  const crossOi = percentileRanks(rows, 'openInterest');
  const byExpiry = new Map();
  for (const r of rows) {
    if (!byExpiry.has(r.expiry)) byExpiry.set(r.expiry, []);
    byExpiry.get(r.expiry).push(r);
  }
  const chainVol = new Map();
  const chainOi = new Map();
  for (const chain of byExpiry.values()) {
    for (const [r, p] of percentileRanks(chain, 'volume')) chainVol.set(r, p);
    for (const [r, p] of percentileRanks(chain, 'openInterest')) chainOi.set(r, p);
  }
  return rows.map(r => ({
    ...r,
    liquidity: (crossVol.get(r) + crossOi.get(r) + chainVol.get(r) + chainOi.get(r)) / 4,
  }));
}

// Rule 6 — lower is better. Without a spot price, time value is unknown and
// the contract sorts after those that have one.
export function priceScore(c) {
  const sp = spreadPct(c);
  const iv = intrinsic(c);
  const timeValue = iv == null ? null : c.ask - iv;
  const costPerDayPct = timeValue == null ? null : timeValue / c.dte / c.spot;
  return { spreadPct: sp, timeValue, costPerDayPct, cost: costPerDayPct == null ? null : costPerDayPct * (1 + sp) };
}

// Rules 7/8 — dates are YYYY-MM-DD; a date on/before expiry is flagged.
export function eventFlags(c, events = {}, triggerDate) {
  const within = d => d && d >= triggerDate && d <= c.expiry;
  return {
    earningsDate: within(events.earningsDate) ? events.earningsDate : null,
    exDividendDate: c.type === 'call' && within(events.exDividendDate) ? events.exDividendDate : null,
  };
}

const byCost = (a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity) || a.iv - b.iv;

// Runs the funnel for one side ('call' | 'put') of one underlying.
export function selectSide(contracts, type, opts = {}, events = {}, triggerDate = '') {
  const o = { ...DEFAULTS, ...opts };
  const side = contracts.filter(c => c.type === type);
  const eligible = side.filter(c => rejectReason(c, o) === null);

  const poolLiquidity = scoreLiquidity(eligible)
    .sort((a, b) => b.liquidity - a.liquidity || b.openInterest - a.openInterest)
    .slice(0, o.liquidityPool);
  const poolIv = [...poolLiquidity].sort((a, b) => a.iv - b.iv).slice(0, o.ivPool);

  const rows = poolIv
    .map(c => ({ ...c, ...priceScore(c), ...eventFlags(c, events, triggerDate) }))
    .sort(byCost)
    .slice(0, o.rowsPerSide)
    .map((c, i) => ({ ...c, rank: i + 1, highlight: i < o.highlight }));

  return { rows, scanned: side.length, qualified: eligible.length };
}

export function selectForUnderlying(contracts, opts = {}, events = {}, triggerDate = '') {
  return {
    calls: selectSide(contracts, 'call', opts, events, triggerDate),
    puts: selectSide(contracts, 'put', opts, events, triggerDate),
  };
}

// Best `n` across all stocks for one side, using the same price ranking.
// costPerDayPct is normalised by spot, so it compares across underlyings.
export function bestAcross(stocks, sideKey, n = DEFAULTS.highlight) {
  return stocks
    .flatMap(s => (s[sideKey] ?? []).map(r => ({ ...r, underlying: s.underlying })))
    .sort(byCost)
    .slice(0, n);
}
