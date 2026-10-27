import { DEFAULTS } from './selector.js';

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export function loadConfig(env) {
  return {
    universe: (env.UNIVERSE || 'NVDA')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    strikeRange: num(env.STRIKE_RANGE, 0.5),
    concurrency: num(env.FETCH_CONCURRENCY, 4),
    selector: {
      minDte: num(env.MIN_DTE, DEFAULTS.minDte),
      liquidityPool: num(env.LIQUIDITY_POOL, DEFAULTS.liquidityPool),
      ivPool: num(env.IV_POOL, DEFAULTS.ivPool),
      deltaPool: num(env.DELTA_POOL, DEFAULTS.deltaPool),
      deltaTarget: num(env.DELTA_TARGET, DEFAULTS.deltaTarget),
      deltaMin: num(env.DELTA_MIN, DEFAULTS.deltaMin),
      deltaMax: num(env.DELTA_MAX, DEFAULTS.deltaMax),
      rowsPerSide: num(env.ROWS_PER_SIDE, DEFAULTS.rowsPerSide),
      highlight: DEFAULTS.highlight,
    },
  };
}
