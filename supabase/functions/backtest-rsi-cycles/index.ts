// StockVizor — RSI Trough → Crest Cycle Backtest (single-ticker, intraday)
// Deploy as: backtest-rsi-cycles
//
// Default: MRVL, 4-hour bars, 4 years. All overridable via query params:
//   ?ticker=MRVL&tf=4hour&years=4&rsiLen=9&pivotWin=5
//
// Algorithm:
//   1. Fetch bars from Polygon
//   2. Compute Wilder's RSI(9)
//   3. Find local extrema with ±N bar confirmation:
//        trough: RSI[i] lowest in [i-N, i+N]
//        crest:  RSI[i] highest in [i-N, i+N]
//   4. Walk extrema in time order, pairing each trough → next crest
//   5. Insert one row per cycle into rsi_cycles_results
//
// NOTE: This uses look-ahead confirmation (a trough is only confirmed N bars
// later). Real-time entry would lag by N bars (~20 hours on 4h timeframe).
// This backtest reports the CLEAN pivot pricing — interpret accordingly.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const POLYGON_BASE = 'https://api.polygon.io';
const POLYGON_KEY  = Deno.env.get('POLYGON_API_KEY') ?? '';
const SUPABASE_URL = 'https://hkamukkkkpqhdpcradau.supabase.co';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

Deno.serve(async (req: Request) => {
  if (!POLYGON_KEY)  return errResp('POLYGON_API_KEY not set', 500);
  if (!SUPABASE_KEY) return errResp('SUPABASE_SERVICE_ROLE_KEY not set', 500);

  const url = new URL(req.url);
  const ticker   = (url.searchParams.get('ticker') || 'MRVL').toUpperCase();
  const tfRaw    = url.searchParams.get('tf') || '4hour';
  const years    = Math.max(1, Math.min(10, parseFloat(url.searchParams.get('years') || '4')));
  const rsiLen   = Math.max(2, Math.min(50, parseInt(url.searchParams.get('rsiLen') || '9', 10)));
  const pivotWin = Math.max(1, Math.min(20, parseInt(url.searchParams.get('pivotWin') || '5', 10)));
  const lookback = Math.max(1, Math.min(20, parseInt(url.searchParams.get('lb') || '3', 10)));
  // stop=10 means -10% stop-loss; stop=0 disables stop-loss
  const stopLossPct = Math.max(0, Math.min(50, parseFloat(url.searchParams.get('stop') || '10')));

  // Parse timeframe → Polygon range params
  const tf = parseTf(tfRaw);
  if (!tf) return errResp(`Unrecognized timeframe: ${tfRaw}. Use: 1hour, 2hour, 4hour, 1day`, 400);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Fetch bars ───────────────────────────────────────────────────────────
  const today = new Date();
  const fromObj = new Date(today);
  fromObj.setDate(fromObj.getDate() - Math.round(years * 365));
  const fromDate = isoDate(fromObj);
  const toDate   = isoDate(today);

  // Paginated fetch — Polygon caps hourly aggs at ~5000 bars per call regardless
  // of `limit` param; need to follow next_url for full window.
  let allRaw: any[] = [];
  let nextUrl: string | null =
    `${POLYGON_BASE}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${tf.mult}/${tf.span}/` +
    `${fromDate}/${toDate}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_KEY}`;
  let pages = 0;
  const MAX_PAGES = 30;
  while (nextUrl && pages < MAX_PAGES) {
    const r = await fetch(nextUrl, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) {
      if (allRaw.length === 0) return errResp(`Polygon ${r.status}: ${(await r.text()).slice(0, 200)}`, 502);
      break;  // partial data is better than nothing
    }
    const j = await r.json();
    if (Array.isArray(j?.results) && j.results.length > 0) {
      allRaw.push(...j.results);
    }
    nextUrl = j?.next_url ? `${j.next_url}&apiKey=${POLYGON_KEY}` : null;
    pages++;
    if (allRaw.length > 100_000) break;
  }
  console.log(`[rsi-cycles] fetched ${allRaw.length} bars across ${pages} page(s)`);

  if (allRaw.length < rsiLen + pivotWin * 2 + 5) {
    return errResp(`Insufficient data: ${allRaw.length} bars`, 400);
  }

  const bars = allRaw.map((b: any) => ({
    t: +b.t,
    iso: new Date(+b.t).toISOString(),
    o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v,
  }));

  // ── Compute RSI(9), RSI(14), AND OBV ─────────────────────────────────────
  const closes = bars.map(b => b.c);
  const vols   = bars.map(b => b.v || 0);
  const rsi   = computeRSI(closes, rsiLen);   // RSI(9) by default
  const rsi14 = computeRSI(closes, 14);

  // OBV = cumulative running sum of volume signed by close direction
  const obv = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    if      (closes[i] > closes[i - 1]) obv[i] = obv[i - 1] + vols[i];
    else if (closes[i] < closes[i - 1]) obv[i] = obv[i - 1] - vols[i];
    else                                obv[i] = obv[i - 1];
  }

  // OBV slope = 5-bar change in OBV
  const OBV_SLOPE_WIN = 5;
  const obvSlope = new Array(bars.length).fill(NaN);
  for (let i = OBV_SLOPE_WIN; i < bars.length; i++) {
    obvSlope[i] = obv[i] - obv[i - OBV_SLOPE_WIN];
  }

  // OBV slope TURNING POINT detection (Path A):
  //   Turning UP   = slope[i] > slope[i-1] AND slope[i-1] <= slope[i-2]
  //                  (current rose, previous was at or below 2-bars-back = was declining)
  //   Turning DOWN = slope[i] < slope[i-1] AND slope[i-1] >= slope[i-2]
  //                  (current fell, previous was at or above 2-bars-back = was rising)
  const obvSlopeTurningUp = (i: number) => {
    if (i < 7) return false;
    return obvSlope[i] > obvSlope[i - 1] && obvSlope[i - 1] <= obvSlope[i - 2];
  };
  const obvSlopeTurningDown = (i: number) => {
    if (i < 7) return false;
    return obvSlope[i] < obvSlope[i - 1] && obvSlope[i - 1] >= obvSlope[i - 2];
  };

  // ── Find extrema: Recovery-cross + OS/OB confirm + No-Falling-Knife ────
  // TROUGH (all 3 must hold on same bar):
  //   1. RSI(6) crossed ABOVE RSI(14) this bar (bullish recovery cross)
  //   2. RSI(6) touched < 35 within the last LOOKBACK bars (real oversold dip recently)
  //   3. RSI(6) > 35 at moment of cross (already cleared oversold — not falling knife)
  // CREST (all 3 must hold on same bar):
  //   1. RSI(6) crossed BELOW RSI(14) this bar (bearish exhaustion cross)
  //   2. RSI(6) touched > 65 within the last LOOKBACK bars (real overbought spike recently)
  //   3. RSI(6) < 65 at moment of cross (already pulled back from overbought — not parabolic)
  // Pass rsiLen=6 in URL for RSI(6) as the fast RSI.
  type Extreme = { idx: number; type: 'trough' | 'crest'; rsi: number; rsi14: number };
  const extrema: Extreme[] = [];
  const OVERSOLD   = 35;
  const OVERBOUGHT = 65;
  const LOOKBACK   = lookback;   // bars to scan for recent oversold/overbought touch
  for (let i = 16; i < bars.length; i++) {
    const rFast = rsi[i];
    const r14   = rsi14[i];
    const rFastPrev = rsi[i - 1];
    const r14Prev   = rsi14[i - 1];
    if (!isFinite(rFast) || !isFinite(r14)) continue;
    if (!isFinite(rFastPrev) || !isFinite(r14Prev)) continue;
    if (rFast <= 0) continue;  // safety

    // Recovery cross events on the FAST line (RSI6) relative to the SLOW line (RSI14)
    const fastCrossedAboveSlow = rFastPrev <= r14Prev && rFast > r14;  // bullish recovery
    const fastCrossedBelowSlow = rFastPrev >= r14Prev && rFast < r14;  // bearish exhaustion

    // Was RSI(6) oversold/overbought within the last LOOKBACK bars (current bar included)?
    let wasOversold = false;
    let wasOverbought = false;
    const start = Math.max(0, i - LOOKBACK);
    for (let k = start; k <= i; k++) {
      if (isFinite(rsi[k])) {
        if (rsi[k] < OVERSOLD)   wasOversold   = true;
        if (rsi[k] > OVERBOUGHT) wasOverbought = true;
      }
    }

    // Trough: cross-above + recent oversold + already cleared oversold (no falling knife)
    if (fastCrossedAboveSlow && wasOversold && rFast > OVERSOLD) {
      extrema.push({ idx: i, type: 'trough', rsi: rFast, rsi14: r14 });
    }
    // Crest: cross-below + recent overbought + already cleared overbought (no parabolic)
    else if (fastCrossedBelowSlow && wasOverbought && rFast < OVERBOUGHT) {
      extrema.push({ idx: i, type: 'crest', rsi: rFast, rsi14: r14 });
    }
  }

  // ── Pair consecutive trough → crest cycles ──────────────────────────────
  // Walk through extrema in chronological order. After each trough, take the
  // next crest in time as the cycle. Then look for the next trough after that
  // crest. This produces clean alternating cycles even if multiple of the same
  // type fire close together.
  type Cycle = {
    trough_idx: number; trough_rsi: number;
    crest_idx:  number; crest_rsi:  number;
  };
  const cycles: Cycle[] = [];
  let lookingFor: 'trough' | 'crest' = 'trough';
  let cur: any = null;
  for (const e of extrema) {
    if (e.type !== lookingFor) {
      // Skip until we find the type we want
      // BUT: if we're looking for trough and we see another crest, the
      // previous (unmatched) trough should not have been used. To keep
      // alternating clean, prefer the FIRST trough then FIRST crest.
      continue;
    }
    if (lookingFor === 'trough') {
      cur = { trough_idx: e.idx, trough_rsi: e.rsi };
      lookingFor = 'crest';
    } else {
      cur.crest_idx = e.idx;
      cur.crest_rsi = e.rsi;
      cycles.push(cur);
      cur = null;
      lookingFor = 'trough';
    }
  }

  // ── Build cycle records with prices and profit % (with optional stop-loss) ──
  // If stopLossPct > 0: walk bars from trough_idx+1 to crest_idx; if any bar's
  // LOW touches trough_price * (1 - stopLossPct/100), exit at the stop level
  // on that bar instead of the crest. Assume good fill at the stop price.
  const stopFrac = stopLossPct / 100;  // e.g., 0.10 for -10%
  const records = cycles.map(c => {
    const tBar = bars[c.trough_idx];
    const cBar = bars[c.crest_idx];
    const stopPrice = stopFrac > 0 ? tBar.c * (1 - stopFrac) : -Infinity;

    let exitIdx = c.crest_idx;
    let exitPrice = cBar.c;
    let exitDate = cBar.iso;
    let exitRsi = c.crest_rsi;
    let stopHit = false;

    if (stopFrac > 0) {
      for (let k = c.trough_idx + 1; k <= c.crest_idx; k++) {
        const b = bars[k];
        if (b.l <= stopPrice) {
          exitIdx = k;
          // Use stopPrice as fill (optimistic — assumes no gap-down through stop)
          exitPrice = stopPrice;
          exitDate = b.iso;
          // RSI at stop bar (may not exist — fall back to NaN→0)
          exitRsi = isFinite(rsi[k]) ? round2(rsi[k]) : 0;
          stopHit = true;
          break;
        }
      }
    }

    const profit = ((exitPrice - tBar.c) / tBar.c) * 100;
    return {
      ticker,
      timeframe:    tfRaw,
      trough_date:  tBar.iso,
      trough_price: round4(tBar.c),
      trough_rsi:   round2(c.trough_rsi),
      crest_date:   exitDate,
      crest_price:  round4(exitPrice),
      crest_rsi:    exitRsi,
      profit_pct:   round4(profit),
      bars_held:    exitIdx - c.trough_idx,
    };
  });

  // ── Wipe prior results for this (ticker, tf, rsiLen) and insert fresh ───
  await supabase.from('rsi_cycles_results')
    .delete()
    .eq('ticker', ticker)
    .eq('timeframe', tfRaw)
    .eq('rsi_length', rsiLen);

  // Insert in chunks
  const CHUNK = 200;
  for (let i = 0; i < records.length; i += CHUNK) {
    const slice = records.slice(i, i + CHUNK).map(r => ({ ...r, rsi_length: rsiLen, pivot_window: pivotWin }));
    const { error } = await supabase.from('rsi_cycles_results').insert(slice);
    if (error) console.error('[rsi_cycles] insert err:', error.message);
  }

  // ── Aggregate stats ─────────────────────────────────────────────────────
  let wins = 0, totalProfit = 0, bestProfit = -Infinity, worstProfit = Infinity;
  let bestRec: any = null, worstRec: any = null;
  for (const r of records) {
    if (r.profit_pct > 0) wins++;
    totalProfit += r.profit_pct;
    if (r.profit_pct > bestProfit)  { bestProfit  = r.profit_pct; bestRec  = r; }
    if (r.profit_pct < worstProfit) { worstProfit = r.profit_pct; worstRec = r; }
  }

  return jsonResp({
    ok: true,
    ticker, timeframe: tfRaw, rsiLen, pivotWin,
    period: `${fromDate} to ${toDate} (~${years}y)`,
    bars_loaded: bars.length,
    extrema_found: extrema.length,
    cycles_found: records.length,
    wins,
    win_rate_pct: records.length ? round2((wins / records.length) * 100) : 0,
    avg_profit_pct: records.length ? round2(totalProfit / records.length) : 0,
    total_profit_pct: round2(totalProfit),
    best_cycle:  bestRec,
    worst_cycle: worstRec,
    sample_first_3: records.slice(0, 3),
    sample_last_3:  records.slice(-3),
    note: 'Full results in table rsi_cycles_results. Pivots use ±5 bar look-ahead (real-time entry would lag).',
  });
});

// ────────────────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────────────────
function parseTf(s: string): { mult: number; span: string } | null {
  const map: Record<string, { mult: number; span: string }> = {
    '1hour': { mult: 1, span: 'hour' },
    '2hour': { mult: 2, span: 'hour' },
    '4hour': { mult: 4, span: 'hour' },
    '1day':  { mult: 1, span: 'day' },
    '15min': { mult: 15, span: 'minute' },
    '30min': { mult: 30, span: 'minute' },
  };
  return map[s.toLowerCase()] ?? null;
}

function computeRSI(closes: number[], period: number): number[] {
  const n = closes.length;
  const out = new Array(n).fill(NaN);
  if (n < period + 1) return out;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    ag = (ag * (period - 1) + g) / period;
    al = (al * (period - 1) + l) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function round4(v: number): number { return Math.round(v * 10000) / 10000; }
function round2(v: number): number { return Math.round(v * 100) / 100; }
function jsonResp(b: any, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
}
function errResp(msg: string, status = 500) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status, headers: { 'content-type': 'application/json' },
  });
}
