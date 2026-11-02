// The two indicators from the user's TradingView layout, calculated by the app
// from Massive candles so they can be drawn immediately and handed to Stocky.
//
// Smoothed HA (confirmed from the indicator's Inputs tab): HA Price Input Smoothing
// Length 12, Exponential; ALMA sigma 6 / offset 0.85 (ALMA only); double-smoothing
// enabled, length 3, Exponential; wicks shown; bullish yellow, bearish purple.
// Inputs "12, Exponential, 6, 0.85, 3, Exponential, 6, 0.85":
//   stage 1: EMA(12) of open/high/low/close   (6 / 0.85 are ALMA sigma/offset,
//   unused with Exponential), Heikin-Ashi on those, then stage 2: EMA(3) of the
//   HA open/high/low/close. This is the standard "Smoothed Heiken Ashi" recipe.
//
// Ultra RSI [DW], inputs "close, 12, EMA, Standard, Default, 0.85, 6, 0.666,
//   0.0645, 75, 25, 0.75": approximated as an RSI of close whose gains/losses are
//   averaged with EMA(12) instead of Wilder's RMA, centre 50, levels 75 / 25.
//   (0.85/6 are ALMA and 0.666/0.0645 KAMA parameters, unused with EMA.)
//   The exact DW formula isn't available here; Stocky is asked to flag it if its
//   configured version would read materially differently.

export const SETTINGS = {
  smoothedHA: { length1: 12, type1: "EMA", length2: 3, type2: "EMA" },
  ultraRsi: { source: "close", length: 12, type: "EMA", overbought: 75, oversold: 25, centre: 50 },
};

// TradingView-style EMA: seeded with the first value.
export function ema(values, length) {
  const a = 2 / (length + 1);
  const out = new Array(values.length);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    prev = prev === null ? v : a * v + (1 - a) * prev;
    out[i] = prev;
  }
  return out;
}

// [{t,o,h,l,c}] -> smoothed Heikin-Ashi candles [{t,o,h,l,c}].
export function smoothedHA(bars, { length1 = 12, length2 = 3 } = SETTINGS.smoothedHA) {
  if (!bars?.length) return [];
  const o = ema(bars.map((b) => b.o), length1);
  const h = ema(bars.map((b) => b.h), length1);
  const l = ema(bars.map((b) => b.l), length1);
  const c = ema(bars.map((b) => b.c), length1);
  const haO = [], haH = [], haL = [], haC = [];
  for (let i = 0; i < bars.length; i++) {
    const close = (o[i] + h[i] + l[i] + c[i]) / 4;
    const open = i === 0 ? (o[i] + c[i]) / 2 : (haO[i - 1] + haC[i - 1]) / 2;
    haO.push(open);
    haC.push(close);
    haH.push(Math.max(h[i], open, close));
    haL.push(Math.min(l[i], open, close));
  }
  const so = ema(haO, length2), sh = ema(haH, length2), sl = ema(haL, length2), sc = ema(haC, length2);
  return bars.map((b, i) => ({
    t: b.t,
    o: so[i],
    h: Math.max(sh[i], so[i], sc[i]),
    l: Math.min(sl[i], so[i], sc[i]),
    c: sc[i],
  }));
}

// [{t,c}] -> [{t,v}] RSI with EMA-averaged gains/losses. First `length` bars are warm-up and dropped.
export function ultraRsi(bars, { length = 12 } = SETTINGS.ultraRsi) {
  if (!bars || bars.length < length + 2) return [];
  const gains = [0], losses = [0];
  for (let i = 1; i < bars.length; i++) {
    const ch = bars[i].c - bars[i - 1].c;
    gains.push(Math.max(ch, 0));
    losses.push(Math.max(-ch, 0));
  }
  const up = ema(gains, length);
  const dn = ema(losses, length);
  const out = [];
  for (let i = length; i < bars.length; i++) {
    const v = dn[i] === 0 ? (up[i] === 0 ? 50 : 100) : 100 - 100 / (1 + up[i] / dn[i]);
    out.push({ t: bars[i].t, v });
  }
  return out;
}

// Both indicators for one timeframe.
export function computeIndicators(bars) {
  return { ha: smoothedHA(bars), ursi: ultraRsi(bars) };
}
