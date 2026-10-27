// Strike-selection funnel for naked calls and naked puts.
//
//   Rule 1   expiry >= minDte calendar days from the trigger date
//   Rule 2a  liquidity: highest volume + open interest, ranked both inside
//            each expiry chain and across all eligible chains
//   Rule 2b  cheapest IV among the 2a pool
//   Rule 2c  delta closest to the target (inside the band) among 2b
//   Rule 2d  most competitive premium among 2c: annualised bid yield on the
//            strike, discounted by the bid/ask spread
//
// Pure functions only: no I/O, so the funnel is unit-testable.

import { daysBetween } from './market-hours.js';

export const DEFAULTS = {
  minDte: 45,
  liquidityPool: 20, // 2a: contracts kept after liquidity ranking
  ivPool: 10,        // 2b: lowest-IV contracts kept from the 2a pool
  deltaPool: 6,      // 2c: contracts kept after delta ranking
  deltaTarget: 0.25, // |delta| a seller typically aims for (~1 SD OTM)
  deltaMin: 0.15,
  deltaMax: 0.35,
  rowsPerSide: 5,    // finalists shown per stock per side
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

export function isEligible(c, minDte) {
  return c &&
    c.dte >= minDte &&
    c.bid > 0 && c.ask >= c.bid &&
    c.iv > 0 &&
    c.delta != null && c.delta !== 0 &&
    c.openInterest > 0;
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

// 2a — liquidity score = mean of volume and OI percentile, inside the
// contract's own expiry chain and across all chains.
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

export function premiumScore(c) {
  const mid = (c.bid + c.ask) / 2;
  const spreadPct = mid > 0 ? (c.ask - c.bid) / mid : 1;
  const annualYield = (c.bid / c.strike) * (365 / c.dte);
  return { mid, spreadPct, annualYield, premium: annualYield * (1 - Math.min(spreadPct, 0.5)) };
}

// Runs the funnel for one side ('call' | 'put') of one underlying.
export function selectSide(contracts, type, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const eligible = contracts.filter(c => c.type === type && isEligible(c, o.minDte));
  if (!eligible.length) return [];

  // 2a
  const poolA = scoreLiquidity(eligible)
    .sort((a, b) => b.liquidity - a.liquidity || b.openInterest - a.openInterest)
    .slice(0, o.liquidityPool);

  // 2b
  const poolB = [...poolA].sort((a, b) => a.iv - b.iv).slice(0, o.ivPool);

  // 2c — prefer in-band deltas; top up with the nearest out-of-band ones so
  // the dashboard always has `highlight` rows when the chain allows it.
  const dist = c => Math.abs(Math.abs(c.delta) - o.deltaTarget);
  const inBand = c => Math.abs(c.delta) >= o.deltaMin && Math.abs(c.delta) <= o.deltaMax;
  const byDelta = [...poolB].sort((a, b) => dist(a) - dist(b));
  let poolC = byDelta.filter(inBand).slice(0, o.deltaPool);
  if (poolC.length < o.highlight) {
    const extra = byDelta.filter(c => !inBand(c)).slice(0, o.highlight - poolC.length);
    poolC = poolC.concat(extra);
  }

  // 2d
  return poolC
    .map(c => ({ ...c, ...premiumScore(c), deltaInBand: inBand(c) }))
    .sort((a, b) => b.premium - a.premium)
    .slice(0, o.rowsPerSide)
    .map((c, i) => ({ ...c, rank: i + 1, highlight: i < o.highlight }));
}

export function selectForUnderlying(contracts, opts = {}) {
  return { calls: selectSide(contracts, 'call', opts), puts: selectSide(contracts, 'put', opts) };
}
