// StockVizor — RSI Bear Cross Backtest (OPTION 1 REFINED — v2)
// Deploy as: backtest-rsi-bear-cross
//
// CHANGES FROM v1 (Option B — which lost ~1% per signal):
//   • Universe: top 500 by dollar volume (was 1000)  ← large-cap focus
//   • Price filter: ≥ $15 (was ≥ $5)                ← kills microcap noise
//   • ADX filter: ≥ 25 (was ≥ 18)                   ← stronger trend confirmation
//   • Added filter: price below SMA(200)             ← long-term bear regime, not just short-term
//   • Exit Rule D: stop -3%, target +8%              ← tighter risk, larger reward
//
// FULL STRATEGY (Option 1 refined):
//   ✓ RSI(7) crosses below RSI(14): yesterday rsi7 ≥ rsi14 AND today rsi7 < rsi14
//   ✓ Both RSI(7) and RSI(14) currently below 50
//   ✓ Price below SMA(50) AND below SMA(200)
//   ✓ RSI(14) was above 65 anywhere in last 20 bars (failed-rally context)
//   ✓ ADX(14) ≥ 25
//   ✓ Price ≥ $15
//
// EXIT RULES:
//   A. 5-day hold       — exit at close of bar+5
//   B. 10-day hold      — exit at close of bar+10
//   C. RSI cross-back   — exit when RSI(7) crosses back above RSI(14), max 30 bars
//   D. Stop/Target/Time — -3% stop, +8% target, 10-bar time stop
//
// SLIPPAGE: 0.05% each side.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const POLYGON_BASE = 'https://api.polygon.io';
const POLYGON_KEY  = Deno.env.get('POLYGON_API_KEY') ?? '';
const SUPABASE_URL = 'https://hkamukkkkpqhdpcradau.supabase.co';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const MAX_RUNTIME_MS    = 130_000;
const PER_TICKER_DELAY  = 70;        // Polygon-friendly throttle
const FETCH_TIMEOUT_MS  = 12_000;
const SLIPPAGE          = 0.0005;    // 0.05% each side
const PERIOD_YEARS      = 3;
const UNIVERSE_TARGET   = 500;       // Option 1: 500 large caps (was 1000)
const STRATEGY_ID       = 'rsi_bear_cross_b_v2';  // Option 1 refined
// Filters
const FILT_MIN_PRICE    = 15;        // Option 1: $15 (was $5)
const FILT_MIN_ADX      = 25;        // Option 1: 25 (was 18)
// Stop/Target rule
const STOP_PCT          = 0.03;      // Option 1: 3% (was 5%)
const TARGET_PCT        = 0.08;      // Option 1: 8% (was 5%)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ────────────────────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────────────────────
Deno.serve(async (_req: Request) => {
  const startedAt = Date.now();
  const log = (msg: string) =>
    console.log(`[bt] +${Math.round((Date.now() - startedAt) / 1000)}s · ${msg}`);

  if (!POLYGON_KEY)  return errResp('POLYGON_API_KEY not set', 500);
  if (!SUPABASE_KEY) return errResp('SUPABASE_SERVICE_ROLE_KEY not set', 500);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // ── Find or create the active backtest run ─────────────────────────────────
  let run: any;
  {
    const { data: running } = await supabase
      .from('backtest_runs')
      .select('*')
      .eq('strategy', STRATEGY_ID)
      .eq('status', 'running')
      .order('started_at', { ascending: false })
      .limit(1);

    if (running && running.length) {
      run = running[0];
      log(`resuming run ${run.run_id.slice(0, 8)} at index ${run.ticker_index}/${run.total_tickers}`);
    } else {
      // Build the universe — top N liquid tickers from ta_cache
      log('no active run — selecting universe and creating new run');
      const universe = await selectUniverse(supabase, UNIVERSE_TARGET);
      if (!universe.length) {
        return errResp('Universe selection returned no tickers', 500);
      }
      const created = await supabase
        .from('backtest_runs')
        .insert({
          strategy:       STRATEGY_ID,
          universe_size:  universe.length,
          period_years:   PERIOD_YEARS,
          ticker_list:    universe,
          ticker_index:   0,
          total_tickers:  universe.length,
          status:         'running',
          notes:          `Option 1 refined: price≥$${FILT_MIN_PRICE} ADX≥${FILT_MIN_ADX} +SMA200 stop=-${STOP_PCT*100}% tgt=+${TARGET_PCT*100}%. ${PERIOD_YEARS}y backtest.`,
        })
        .select()
        .single();
      if (created.error) return errResp(`Insert run failed: ${created.error.message}`, 500);
      run = created.data;
      log(`created run ${run.run_id.slice(0, 8)} with ${universe.length} tickers`);
    }
  }

  await supabase.from('backtest_runs')
    .update({ last_invocation: new Date().toISOString() })
    .eq('run_id', run.run_id);

  // ── Already done? ─────────────────────────────────────────────────────────
  if (run.ticker_index >= run.total_tickers) {
    if (run.status !== 'complete') {
      await supabase.from('backtest_runs')
        .update({ status: 'complete', finished_at: new Date().toISOString() })
        .eq('run_id', run.run_id);
    }
    return jsonResp({ ok: true, status: 'complete', run_id: run.run_id });
  }

  // ── Process tickers in batch ──────────────────────────────────────────────
  const tickers: string[] = run.ticker_list;
  const today = new Date();
  const fromObj = new Date(today);
  fromObj.setDate(fromObj.getDate() - Math.round(PERIOD_YEARS * 365 * 1.05)); // small buffer
  const fromDate = isoDate(fromObj);
  const toDate   = isoDate(today);

  let i = run.ticker_index;
  let processedThisRun = 0;
  let failedThisRun    = 0;
  let signalsThisRun   = 0;
  const insertBuf: any[] = [];

  while (i < tickers.length) {
    if (Date.now() - startedAt > MAX_RUNTIME_MS - 18_000) {
      log(`time budget — flushing at ticker ${i}/${tickers.length}`);
      break;
    }

    const tk = tickers[i];
    try {
      const bars = await fetchBars(tk, fromDate, toDate);
      if (!bars || bars.length < 100) {
        // Need at least ~100 bars (50 for SMA50 warmup + ~50 for signals)
        failedThisRun++;
      } else {
        const sigs = scanSignals(tk, bars);
        for (const s of sigs) insertBuf.push({ ...s, run_id: run.run_id });
        signalsThisRun += sigs.length;
        processedThisRun++;
      }
    } catch {
      failedThisRun++;
    }

    i++;

    // Flush every 50 tickers to keep insertBuf manageable
    if (insertBuf.length >= 200) {
      await flushSignals(supabase, insertBuf);
    }

    await sleep(PER_TICKER_DELAY);
  }

  // Final flush
  await flushSignals(supabase, insertBuf);

  // Update run progress
  const isComplete = i >= tickers.length;
  await supabase.from('backtest_runs')
    .update({
      ticker_index:  i,
      total_signals: run.total_signals + signalsThisRun,
      total_failed:  run.total_failed + failedThisRun,
      status:        isComplete ? 'complete' : 'running',
      finished_at:   isComplete ? new Date().toISOString() : null,
    })
    .eq('run_id', run.run_id);

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  log(`processed=${processedThisRun} failed=${failedThisRun} signals=${signalsThisRun} totalIdx=${i}/${tickers.length} elapsed=${elapsed}s ${isComplete ? 'COMPLETE' : ''}`);

  return jsonResp({
    ok:           true,
    run_id:       run.run_id,
    ticker_index: i,
    total:        tickers.length,
    pct:          Math.round((i / tickers.length) * 1000) / 10,
    processed_this_run: processedThisRun,
    signals_this_run:   signalsThisRun,
    elapsed_sec:  elapsed,
    status:       isComplete ? 'complete' : 'running',
  });
});

// ────────────────────────────────────────────────────────────────────────────
// UNIVERSE SELECTION — top N tickers by recent dollar volume from ta_cache
// ────────────────────────────────────────────────────────────────────────────
async function selectUniverse(supabase: any, target: number): Promise<string[]> {
  // Get latest trading_date
  const { data: dateRows } = await supabase
    .from('ta_cache')
    .select('trading_date')
    .order('trading_date', { ascending: false })
    .limit(1);
  const dt = dateRows?.[0]?.trading_date;
  if (!dt) return [];

  // Pull liquid tickers, sort client-side by dollar volume.
  // Option 1: price >= $15, avg_vol20 >= 1M (large-cap focus)
  const { data: rows } = await supabase
    .from('ta_cache')
    .select('ticker,price,avg_vol20,sector')
    .eq('trading_date', dt)
    .gte('price', FILT_MIN_PRICE)
    .gte('avg_vol20', 1_000_000)
    .limit(5000);

  if (!rows || !rows.length) return [];

  const ranked = rows
    .filter((r: any) => r.sector && r.sector !== 'ETF')
    .map((r: any) => ({ ticker: r.ticker, dv: (+r.price) * (+r.avg_vol20) }))
    .sort((a: any, b: any) => b.dv - a.dv)
    .slice(0, target)
    .map((r: any) => r.ticker);

  return ranked;
}

// ────────────────────────────────────────────────────────────────────────────
// POLYGON FETCH (per-ticker daily bars)
// ────────────────────────────────────────────────────────────────────────────
async function fetchBars(ticker: string, fromDate: string, toDate: string) {
  const url =
    `${POLYGON_BASE}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/` +
    `${fromDate}/${toDate}?adjusted=true&sort=asc&limit=2000&apiKey=${POLYGON_KEY}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (r.status === 429) {
      await sleep(8000);
      const r2 = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!r2.ok) return null;
      const j2 = await r2.json();
      return mapBars(j2?.results);
    }
    if (!r.ok) return null;
    const j = await r.json();
    return mapBars(j?.results);
  } catch {
    return null;
  }
}

function mapBars(raw: any[] | undefined) {
  if (!Array.isArray(raw) || !raw.length) return null;
  return raw.map((b: any) => ({
    t: new Date(b.t).toISOString().slice(0, 10),
    o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v || 0),
  }));
}

// ────────────────────────────────────────────────────────────────────────────
// INDICATOR COMPUTATION
// ────────────────────────────────────────────────────────────────────────────

// Wilder's RSI — returns array same length as closes, NaN until period+1
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

function computeSMA(closes: number[], period: number): number[] {
  const n = closes.length;
  const out = new Array(n).fill(NaN);
  if (n < period) return out;
  let s = 0;
  for (let i = 0; i < period; i++) s += closes[i];
  out[period - 1] = s / period;
  for (let i = period; i < n; i++) {
    s += closes[i] - closes[i - period];
    out[i] = s / period;
  }
  return out;
}

// ADX(14) series — returns array same length as closes, NaN for warmup
function computeADX(highs: number[], lows: number[], closes: number[], period: number): number[] {
  const n = closes.length;
  const out = new Array(n).fill(NaN);
  if (n < period * 2 + 1) return out;
  const tr: number[] = [], pdm: number[] = [], mdm: number[] = [];
  for (let i = 1; i < n; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i]  - closes[i - 1]);
    tr.push(Math.max(hl, hc, lc));
    const up = highs[i] - highs[i - 1];
    const dn = lows[i - 1] - lows[i];
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  let atr  = tr.slice(0, period).reduce((s, v) => s + v, 0);
  let aPdm = pdm.slice(0, period).reduce((s, v) => s + v, 0);
  let aMdm = mdm.slice(0, period).reduce((s, v) => s + v, 0);
  const dxArr: number[] = [];
  for (let i = period; i < tr.length; i++) {
    atr  = atr  - atr  / period + tr[i];
    aPdm = aPdm - aPdm / period + pdm[i];
    aMdm = aMdm - aMdm / period + mdm[i];
    const pdi = atr > 0 ? aPdm / atr * 100 : 0;
    const mdi = atr > 0 ? aMdm / atr * 100 : 0;
    const ds  = pdi + mdi;
    const dx  = ds > 0 ? Math.abs(pdi - mdi) / ds * 100 : 0;
    dxArr.push(dx);
  }
  if (dxArr.length < period) return out;
  // First ADX = simple average of first period DX values
  let adxVal = dxArr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  // Position of first ADX in original array: 1 + period (skip TR[0]) + period (DX warmup) - 1
  const firstAdxIdx = period * 2;
  out[firstAdxIdx] = adxVal;
  for (let i = period; i < dxArr.length; i++) {
    adxVal = (adxVal * (period - 1) + dxArr[i]) / period;
    out[firstAdxIdx + (i - period) + 1] = adxVal;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// STRATEGY SCAN — Option B (tight RSI Bear Cross)
// ────────────────────────────────────────────────────────────────────────────
function scanSignals(ticker: string, bars: any[]): any[] {
  const n = bars.length;
  const opens  = bars.map(b => b.o);
  const highs  = bars.map(b => b.h);
  const lows   = bars.map(b => b.l);
  const closes = bars.map(b => b.c);

  const rsi7   = computeRSI(closes, 7);
  const rsi14  = computeRSI(closes, 14);
  const sma50  = computeSMA(closes, 50);
  const sma200 = computeSMA(closes, 200);  // Option 1: long-term regime filter
  const adx14  = computeADX(highs, lows, closes, 14);

  const signals: any[] = [];
  // Need 200 bars for SMA(200) warmup + 1 prior bar for cross detection
  for (let i = 201; i < n; i++) {
    const r7  = rsi7[i],  r7p = rsi7[i - 1];
    const r14 = rsi14[i], r14p = rsi14[i - 1];
    const s50 = sma50[i];
    const s200 = sma200[i];
    const ad  = adx14[i];
    const c   = closes[i];

    if (!isFinite(r7) || !isFinite(r14) || !isFinite(s50) || !isFinite(s200) || !isFinite(ad)) continue;
    if (!isFinite(r7p) || !isFinite(r14p)) continue;

    // Filter 1: RSI(7) crossed below RSI(14) today
    if (!(r7p >= r14p && r7 < r14)) continue;
    // Filter 2: Both currently below 50
    if (r7 >= 50 || r14 >= 50) continue;
    // Filter 3a: Price below SMA(50)
    if (c >= s50) continue;
    // Filter 3b (Option 1 NEW): Price below SMA(200) — long-term bear regime
    if (c >= s200) continue;
    // Filter 4: RSI(14) was above 65 in last 20 bars (failed-rally context)
    let hadPeak = false;
    for (let k = Math.max(0, i - 19); k <= i; k++) {
      if (rsi14[k] > 65) { hadPeak = true; break; }
    }
    if (!hadPeak) continue;
    // Filter 5: ADX ≥ 25 (Option 1 tightened from 18)
    if (ad < FILT_MIN_ADX) continue;
    // Filter 6: Price ≥ $15 (Option 1 tightened from $5)
    if (c < FILT_MIN_PRICE) continue;

    // Signal fires — compute exits under all 4 rules
    const entry = c * (1 - SLIPPAGE);  // short sell, executed slightly below close
    const exits = computeExits(bars, rsi7, rsi14, i, entry);

    signals.push({
      ticker,
      signal_date:    bars[i].t,
      entry_price:    round4(entry),
      rsi7:           round4(r7),
      rsi14:          round4(r14),
      sma50:          round4(s50),
      adx14:          round4(ad),
      ret_5d:         exits.ret_5d != null         ? round4(exits.ret_5d)         : null,
      exit_5d_price:  exits.exit_5d_price != null  ? round4(exits.exit_5d_price)  : null,
      ret_10d:        exits.ret_10d != null        ? round4(exits.ret_10d)        : null,
      exit_10d_price: exits.exit_10d_price != null ? round4(exits.exit_10d_price) : null,
      ret_xb:         exits.ret_xb != null         ? round4(exits.ret_xb)         : null,
      exit_xb_price:  exits.exit_xb_price != null  ? round4(exits.exit_xb_price)  : null,
      exit_xb_bars:   exits.exit_xb_bars,
      ret_st:         exits.ret_st != null         ? round4(exits.ret_st)         : null,
      exit_st_price:  exits.exit_st_price != null  ? round4(exits.exit_st_price)  : null,
      exit_st_bars:   exits.exit_st_bars,
      exit_st_reason: exits.exit_st_reason,
    });
  }

  return signals;
}

// ────────────────────────────────────────────────────────────────────────────
// EXIT COMPUTATION — 4 rules per signal
// For SHORT trades: pct return = (entry - exit) / entry × 100
// Positive = winner (price dropped), Negative = loser (price rose)
// ────────────────────────────────────────────────────────────────────────────
function computeExits(bars: any[], rsi7: number[], rsi14: number[], idx: number, entry: number) {
  const n = bars.length;
  const result: any = {
    ret_5d: null,         exit_5d_price:  null,
    ret_10d: null,        exit_10d_price: null,
    ret_xb: null,         exit_xb_price:  null, exit_xb_bars: null,
    ret_st: null,         exit_st_price:  null, exit_st_bars: null, exit_st_reason: null,
  };

  // ── Rule 1: 5-day hold ──
  if (idx + 5 < n) {
    const exit = bars[idx + 5].c * (1 + SLIPPAGE);  // cover at slightly higher price
    result.exit_5d_price = exit;
    result.ret_5d = ((entry - exit) / entry) * 100;
  }

  // ── Rule 2: 10-day hold ──
  if (idx + 10 < n) {
    const exit = bars[idx + 10].c * (1 + SLIPPAGE);
    result.exit_10d_price = exit;
    result.ret_10d = ((entry - exit) / entry) * 100;
  }

  // ── Rule 3: RSI cross-back (max 30 bars) ──
  let xbIdx: number | null = null;
  for (let j = idx + 1; j <= Math.min(idx + 30, n - 1); j++) {
    if (rsi7[j - 1] < rsi14[j - 1] && rsi7[j] >= rsi14[j]) {
      xbIdx = j; break;
    }
  }
  if (xbIdx == null) xbIdx = Math.min(idx + 30, n - 1);
  if (xbIdx > idx) {
    const exit = bars[xbIdx].c * (1 + SLIPPAGE);
    result.exit_xb_price = exit;
    result.ret_xb = ((entry - exit) / entry) * 100;
    result.exit_xb_bars = xbIdx - idx;
  }

  // ── Rule 4 (Option 1): Stop -3% / Target +8% / Time 10 bars ──
  // For shorts: stop fires if price RISES 3% above entry (small loss)
  //            target fires if price FALLS 8% below entry (large profit)
  // This reshapes the asymmetric-payout: smaller losses, bigger wins.
  const stopPx   = entry * (1 + STOP_PCT);
  const targetPx = entry * (1 - TARGET_PCT);
  let stIdx: number | null = null;
  let stPx: number | null  = null;
  let stReason: string | null = null;
  for (let j = idx + 1; j <= Math.min(idx + 10, n - 1); j++) {
    if (bars[j].h >= stopPx) { stIdx = j; stPx = stopPx; stReason = 'stop'; break; }
    if (bars[j].l <= targetPx) { stIdx = j; stPx = targetPx; stReason = 'target'; break; }
  }
  if (stIdx == null && idx + 10 < n) {
    stIdx = idx + 10; stPx = bars[idx + 10].c * (1 + SLIPPAGE); stReason = 'time';
  }
  if (stIdx != null && stPx != null) {
    result.exit_st_price  = stPx;
    result.exit_st_bars   = stIdx - idx;
    result.exit_st_reason = stReason;
    result.ret_st = ((entry - stPx) / entry) * 100;
  }

  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────────────────
async function flushSignals(supabase: any, buf: any[]) {
  if (!buf.length) return;
  const CHUNK = 200;
  for (let i = 0; i < buf.length; i += CHUNK) {
    const slice = buf.slice(i, i + CHUNK);
    const { error } = await supabase.from('backtest_signals').insert(slice);
    if (error) console.error('[bt] insert err:', error.message);
  }
  buf.length = 0;
}

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function round4(v: number): number { return Math.round(v * 10000) / 10000; }
function jsonResp(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}
function errResp(msg: string, status = 500) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status, headers: { 'content-type': 'application/json' },
  });
}
