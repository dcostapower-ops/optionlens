import { DEFAULTS } from './selector.js';

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

// EARNINGS_OVERRIDES="TSLA:2027-01-27,AAPL:2026-11-02" — wins over the web lookup.
function parseOverrides(raw) {
  const out = {};
  for (const pair of (raw || '').split(',')) {
    const [sym, date] = pair.split(':').map(s => s?.trim());
    if (sym && /^\d{4}-\d{2}-\d{2}$/.test(date || '')) out[sym.toUpperCase()] = date;
  }
  return out;
}

export function loadConfig(env) {
  return {
    universe: (env.UNIVERSE || 'NVDA')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    strikeRange: num(env.STRIKE_RANGE, 0.5),
    concurrency: num(env.FETCH_CONCURRENCY, 4),
    earningsOverrides: parseOverrides(env.EARNINGS_OVERRIDES),
    selector: {
      minDte: num(env.MIN_DTE, DEFAULTS.minDte),
      maxDte: num(env.MAX_DTE, DEFAULTS.maxDte),
      deltaMin: num(env.DELTA_MIN, DEFAULTS.deltaMin),
      deltaMax: num(env.DELTA_MAX, DEFAULTS.deltaMax),
      minOpenInterest: num(env.MIN_OPEN_INTEREST, DEFAULTS.minOpenInterest),
      minVolume: num(env.MIN_VOLUME, DEFAULTS.minVolume),
      maxSpreadPct: num(env.MAX_SPREAD_PCT, DEFAULTS.maxSpreadPct),
      liquidityPool: num(env.LIQUIDITY_POOL, DEFAULTS.liquidityPool),
      ivPool: num(env.IV_POOL, DEFAULTS.ivPool),
      rowsPerSide: num(env.ROWS_PER_SIDE, DEFAULTS.rowsPerSide),
      highlight: DEFAULTS.highlight,
    },
  };
}
