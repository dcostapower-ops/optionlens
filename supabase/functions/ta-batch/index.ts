// OptionLens TA Batch Job — Supabase Edge Function v24-tdf
// Deploy as function name: ta-batch
// v24-tdf (2026-05-06): Adds VizHeat TDF (Trend Duration Forecast) to price bars phase.
//   - Replaces old pctOfRange VizHeat with ChartPrime HMA(50) algorithm
//   - New ta_cache columns: tdf_direction, tdf_progress_pct, tdf_zone,
//     tdf_bars_remaining_bracket, tdf_probable_length, tdf_trend_count
//   - Extends bar history from 30→200 trading days for HMA-50 warmup + phase history
//   - Requires SQL: ALTER TABLE ta_cache ADD COLUMN tdf_* (see ta-cache-tdf-columns.sql)
// v23.1 (2026-05-03): Removes Layer A (running-guard) — zombie rows blocked all invocations.
//   Layer B (pg_try_advisory_lock) retained as the real overlap protection.
//   - Layer A: running-guard (checks batch_run for non-stale active runs)
//   - Layer B: pg_try_advisory_lock (non-blocking, race-window backstop)
//   - Diagnostics: structured [overlap-check]/[lock]/[overlap-WARN] logs
//   - Companion: cron 'ta-batch-continue' to be rescheduled at */10 (was */2)
//   - Requires SQL: public.try_acquire_batch_lock + public.release_batch_lock
// v22-vizwatch: Adds support/resistance/pivot/fib computation to ta_cache (Phase 3)
// v21-test4b: sleep(70)/sleep(70) for empirical rate-limit testing
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const POLYGON_BASE = 'https://api.polygon.io';
const POLYGON_KEY = Deno.env.get('POLYGON_API_KEY') ?? '';
const SUPABASE_URL = 'https://hkamukkkkpqhdpcradau.supabase.co';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
// ── FALLBACK TICKERS ──
const FALLBACK_TICKERS = [
  'AAPL',
  'MSFT',
  'AMZN',
  'GOOG',
  'GOOGL',
  'META',
  'TSLA',
  'NVDA',
  'AMD',
  'INTC',
  'AVGO',
  'QCOM',
  'TXN',
  'MU',
  'AMAT',
  'LRCX',
  'KLAC',
  'ORCL',
  'CRM',
  'NOW',
  'SNOW',
  'DDOG',
  'ZS',
  'NET',
  'CRWD',
  'PANW',
  'PLTR',
  'SHOP',
  'COIN',
  'HOOD',
  'NFLX',
  'DIS',
  'CMCSA',
  'AMZN',
  'JPM',
  'BAC',
  'GS',
  'MS',
  'WFC',
  'C',
  'V',
  'MA',
  'BLK',
  'SCHW',
  'JNJ',
  'LLY',
  'PFE',
  'MRK',
  'ABBV',
  'UNH',
  'HD',
  'LOW',
  'NKE',
  'MCD',
  'SBUX',
  'WMT',
  'COST',
  'PG',
  'KO',
  'PEP',
  'XOM',
  'CVX',
  'COP',
  'BA',
  'CAT',
  'GE',
  'RTX',
  'LMT',
  'HON',
  'UPS',
  'SPY',
  'QQQ',
  'IWM',
  'DIA',
  'XLF',
  'XLE',
  'XLK',
  'XLV',
  'GLD',
  'TLT',
  'SMH',
  'SOXX',
  'TQQQ',
  'SQQQ',
  'ARKK'
];
// ── INDICATORS ──
const INDICATORS = [
  {
    key: 'rsi',
    label: 'RSI(14)',
    url: (tk)=>`${POLYGON_BASE}/v1/indicators/rsi/${tk}?timespan=day&window=14&series_type=close&order=desc&limit=1&apiKey=${POLYGON_KEY}`,
    parse: (d)=>d?.results?.values?.[0]?.value ?? null
  },
  {
    key: 'macd_h',
    label: 'MACD',
    url: (tk)=>`${POLYGON_BASE}/v1/indicators/macd/${tk}?timespan=day&short_window=12&long_window=26&signal_window=9&series_type=close&order=desc&limit=1&apiKey=${POLYGON_KEY}`,
    parse: (d)=>d?.results?.values?.[0]?.histogram ?? null
  },
  {
    key: 'ema9',
    label: 'EMA(9)',
    url: (tk)=>`${POLYGON_BASE}/v1/indicators/ema/${tk}?timespan=day&window=9&series_type=close&order=desc&limit=1&apiKey=${POLYGON_KEY}`,
    parse: (d)=>d?.results?.values?.[0]?.value ?? null
  },
  {
    key: 'ema20',
    label: 'EMA(20)',
    url: (tk)=>`${POLYGON_BASE}/v1/indicators/ema/${tk}?timespan=day&window=20&series_type=close&order=desc&limit=1&apiKey=${POLYGON_KEY}`,
    parse: (d)=>d?.results?.values?.[0]?.value ?? null
  },
  {
    key: 'ema50',
    label: 'EMA(50)',
    url: (tk)=>`${POLYGON_BASE}/v1/indicators/ema/${tk}?timespan=day&window=50&series_type=close&order=desc&limit=1&apiKey=${POLYGON_KEY}`,
    parse: (d)=>d?.results?.values?.[0]?.value ?? null
  },
  {
    key: 'sma50',
    label: 'SMA(50)',
    url: (tk)=>`${POLYGON_BASE}/v1/indicators/sma/${tk}?timespan=day&window=50&series_type=close&order=desc&limit=1&apiKey=${POLYGON_KEY}`,
    parse: (d)=>d?.results?.values?.[0]?.value ?? null
  },
  {
    key: 'sma200',
    label: 'SMA(200)',
    url: (tk)=>`${POLYGON_BASE}/v1/indicators/sma/${tk}?timespan=day&window=200&series_type=close&order=desc&limit=1&apiKey=${POLYGON_KEY}`,
    parse: (d)=>d?.results?.values?.[0]?.value ?? null
  }
];
let BATCH_SIZE = 25;  // parallel fetch — 25 concurrent Polygon calls per batch (paid plan)
let WINDOW_MS = 5000;
const MAX_RUNTIME = 115000;
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000 // 2 hours — if no progress, consider stale
;
// ── OVERLAP PROTECTION CONSTANTS (added v23) ─────────────────────────────────
const ACTIVE_RUN_WINDOW_MS = 5 * 60 * 1000; // 5 min — younger than this = "active"
const OVERLAP_TELEMETRY_INTERVAL = 100; // every N work iterations, sanity-check
const sleep = (ms)=>new Promise((res)=>setTimeout(res, ms));
const US_HOLIDAYS = new Set([
  '2025-01-01',
  '2025-01-20',
  '2025-02-17',
  '2025-04-18',
  '2025-05-26',
  '2025-06-19',
  '2025-07-04',
  '2025-09-01',
  '2025-11-27',
  '2025-12-25',
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
  '2027-01-01',
  '2027-01-18',
  '2027-02-15',
  '2027-04-02',
  '2027-05-31',
  '2027-06-19',
  '2027-07-05',
  '2027-09-06',
  '2027-11-25',
  '2027-12-24'
]);
function isTrading(d) {
  const dow = new Date(d + 'T12:00:00').getDay();
  return dow >= 1 && dow <= 5 && !US_HOLIDAYS.has(d);
}
function lastTradingDate() {
  const etStr = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York'
  });
  const et = new Date(etStr);
  const etDate = et.toISOString().slice(0, 10);
  const hhmm = et.getHours() * 100 + et.getMinutes();
  // Only adopt today as the trading date after 17:00 ET (1 hour after market close).
  // Before 17:00, Polygon EOD bars for today are not yet available — using today
  // would write yesterday's last-known prices into today's ta_cache row and then
  // mark the batch complete, blocking the correct post-close run from executing.
  if (isTrading(etDate) && hhmm >= 1700) return etDate;
  const d = new Date(et);
  for(let i = 0; i < 14; i++){
    d.setDate(d.getDate() - 1);
    const ds = d.toISOString().slice(0, 10);
    if (isTrading(ds)) return ds;
  }
  return etDate;
}
async function polygonFetch(url) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(12000)
    });
    if (r.status === 429) return {
      _429: true
    };
    if (!r.ok) return null;
    return await r.json();
  } catch  {
    return null;
  }
}
// ── LOAD TICKER UNIVERSE FROM SUPABASE ──
async function loadTickerUniverse(supabase) {
  try {
    const { data, error } = await supabase.from('app_config').select('value').eq('key', 'ta_ticker_universe').limit(1);
    if (error || !data?.length) {
      console.warn('[batch] No ta_ticker_universe in app_config — using fallback list');
      return [
        ...new Set(FALLBACK_TICKERS)
      ];
    }
    const raw = data[0].value;
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(arr) && arr.length > 0) {
      console.log(`[batch] Loaded ${arr.length} tickers from app_config.ta_ticker_universe`);
      return [
        ...new Set(arr)
      ];
    }
    console.warn('[batch] ta_ticker_universe empty or invalid — using fallback');
    return [
      ...new Set(FALLBACK_TICKERS)
    ];
  } catch (e) {
    console.error('[batch] Error loading universe:', e.message);
    return [
      ...new Set(FALLBACK_TICKERS)
    ];
  }
}
// ── LOAD SECTOR MAP FROM SUPABASE ──
let SECTOR_MAP = {};
async function loadSectorMap(supabase) {
  try {
    const { data, error } = await supabase.from('app_config').select('value').eq('key', 'ticker_sectors').limit(1);
    if (error || !data?.length) {
      console.warn('[batch] No ticker_sectors in app_config');
      return;
    }
    const raw = data[0].value;
    SECTOR_MAP = typeof raw === 'string' ? JSON.parse(raw) : raw;
    console.log(`[batch] Loaded sector map: ${Object.keys(SECTOR_MAP).length} tickers`);
  } catch (e) {
    console.error('[batch] Error loading sectors:', e.message);
  }
}
// ── STALE RUN DETECTION & AUTO-RESET ────────────────────────────────────────
async function detectAndResetStaleRuns(supabase, tradingDate) {
  const { data: states } = await supabase.from('batch_state').select('*').eq('status', 'running');
  if (states?.length) {
    for (const s of states){
      const lastUpdate = s.last_updated ? new Date(s.last_updated).getTime() : 0;
      const ageMs = Date.now() - lastUpdate;
      if (ageMs > STALE_THRESHOLD_MS) {
        console.warn(`[batch] ⚠ STALE RUN DETECTED: date=${s.trading_date}, last_updated=${s.last_updated} (${Math.round(ageMs / 60000)}min ago)`);
        await supabase.from('batch_state').delete().eq('trading_date', s.trading_date);
        console.log(`[batch] 🔄 Reset batch_state for ${s.trading_date}`);
        await supabase.from('batch_run').update({
          status: 'stale_reset',
          completed_at: new Date().toISOString()
        }).eq('trading_date', s.trading_date).eq('status', 'running');
        console.log(`[batch] 🔄 Marked batch_run for ${s.trading_date} as stale_reset`);
        if (s.trading_date !== tradingDate) {
          console.log(`[batch] Clearing stale ta_cache for ${s.trading_date} (not today)`);
          await supabase.from('ta_cache').delete().eq('trading_date', s.trading_date);
        }
      }
    }
  }
  const { data: runs } = await supabase.from('batch_run').select('*').eq('status', 'running');
  if (runs?.length) {
    for (const r of runs){
      const startedAt = r.started_at ? new Date(r.started_at).getTime() : 0;
      const ageMs = Date.now() - startedAt;
      if (ageMs > STALE_THRESHOLD_MS) {
        console.warn(`[batch] ⚠ Stale batch_run: date=${r.trading_date}, started ${Math.round(ageMs / 60000)}min ago — marking stale`);
        await supabase.from('batch_run').update({
          status: 'stale_reset',
          completed_at: new Date().toISOString()
        }).eq('trading_date', r.trading_date);
      }
    }
  }
}
// ── OVERLAP PROTECTION HELPERS (added v23) ──────────────────────────────────
// 32-bit hash of trading_date string → stable lock key per date
function hashTradingDate(tradingDate) {
  let h = 5381;
  const s = `ta-batch:${tradingDate}`;
  for(let i = 0; i < s.length; i++){
    h = (h << 5) + h + s.charCodeAt(i) | 0;
  }
  return Math.abs(h);
}
// Find any non-stale running batch_run for this trading_date (excluding our own).
// "Non-stale" = started within ACTIVE_RUN_WINDOW_MS (5 min). Returns null if none.
async function findActiveRun(supabase, tradingDate, myRunId) {
  const cutoff = new Date(Date.now() - ACTIVE_RUN_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from('batch_run')
    .select('id, started_at, status, tickers_done, indicators_done')
    .eq('trading_date', tradingDate)
    .eq('status', 'running')
    .gt('started_at', cutoff)
    .order('started_at', { ascending: false });
  if (error) {
    console.warn(`[overlap-check] query error: ${error.message}`);
    return null;
  }
  const others = (data || []).filter((r)=>r.id !== myRunId);
  if (others.length === 0) return null;
  const other = others[0];
  return {
    ...other,
    age_seconds: Math.round((Date.now() - new Date(other.started_at).getTime()) / 1000),
    parallel_count: others.length
  };
}
// Non-blocking advisory lock via public.try_acquire_batch_lock RPC.
// Returns { acquired, lockKey, error? }.
async function tryAcquireBatchLock(supabase, tradingDate) {
  const lockKey = hashTradingDate(tradingDate);
  const { data, error } = await supabase.rpc('try_acquire_batch_lock', { lock_key: lockKey });
  if (error) {
    console.warn(`[lock] try_acquire RPC error: ${error.message}`);
    return { acquired: false, lockKey, error: error.message };
  }
  return { acquired: data === true, lockKey };
}
async function releaseBatchLock(supabase, lockKey) {
  const { data, error } = await supabase.rpc('release_batch_lock', { lock_key: lockKey });
  if (error) {
    console.warn(`[lock] release RPC error: ${error.message}`);
    return false;
  }
  return data === true;
}
// ── TDF: Trend Duration Forecast ─────────────────────────────────────────────
// Port of ChartPrime Pine Script algorithm:
//   HMA(50) direction via ta.rising/falling(3)
//   Probable length = rolling median of last 20 completed same-direction phases
//   Progress % = trend_count / probable_length × 100  (capped 150%)
//   Requires ~200 bars of history for enough completed phases for a stable median
// Backtest (106K bars): Green zone (+0.99%, 54.3% win) vs Red (+0.30%, 50.3%)
//   Strong setups: Green 39.8%+ win rate vs Orange 29.3%
const TDF_HMA_PERIOD = 50;
const TDF_HALF       = Math.floor(TDF_HMA_PERIOD / 2);        // 25
const TDF_SQRT       = Math.round(Math.sqrt(TDF_HMA_PERIOD)); // 7
const TDF_TREND_LEN  = 3;   // consecutive HMA bars required for direction signal
const TDF_SAMPLES    = 20;  // rolling window for median phase-duration estimate
const TDF_MIN_BARS   = TDF_HMA_PERIOD + TDF_SQRT + TDF_TREND_LEN; // ≥60 bars needed

function tdfWmaAt(arr, endIdx, period) {
  let num = 0, den = 0;
  for (let k = 0; k < period; k++) { const w = period - k; num += arr[endIdx - k] * w; den += w; }
  return num / den;
}

function computeTdfHma(closesAsc) {
  const n = closesAsc.length;
  // Step 1: raw[i] = 2×WMA(half)[i] − WMA(period)[i]  (valid for i ≥ period−1)
  const raw = new Array(n).fill(null);
  for (let i = TDF_HMA_PERIOD - 1; i < n; i++) {
    raw[i] = 2 * tdfWmaAt(closesAsc, i, TDF_HALF) - tdfWmaAt(closesAsc, i, TDF_HMA_PERIOD);
  }
  // Step 2: HMA[i] = WMA(raw, sqrt(period))[i]  (valid for i ≥ period + sqrt − 2)
  const hma = new Array(n).fill(null);
  for (let i = TDF_HMA_PERIOD + TDF_SQRT - 2; i < n; i++) {
    let num = 0, den = 0;
    for (let k = 0; k < TDF_SQRT; k++) { const w = TDF_SQRT - k; num += raw[i - k] * w; den += w; }
    hma[i] = num / den;
  }
  return hma;
}

function tdfIsRising(hma, i) {
  if (i < TDF_TREND_LEN) return false;
  for (let k = 0; k < TDF_TREND_LEN; k++) {
    if (hma[i - k] == null || hma[i - k - 1] == null) return false;
    if (hma[i - k] <= hma[i - k - 1]) return false;
  }
  return true;
}

function tdfIsFalling(hma, i) {
  if (i < TDF_TREND_LEN) return false;
  for (let k = 0; k < TDF_TREND_LEN; k++) {
    if (hma[i - k] == null || hma[i - k - 1] == null) return false;
    if (hma[i - k] >= hma[i - k - 1]) return false;
  }
  return true;
}

function tdfMedian(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// Returns TDF state for today (last bar in closesAsc), or null if insufficient data.
function computeTDF(closesAsc) {
  const n = closesAsc.length;
  if (n < TDF_MIN_BARS) return null;

  const hma = computeTdfHma(closesAsc);
  const completedLong  = [];
  const completedShort = [];
  let dir   = null;  // 'long' | 'short' | null
  let count = 0;

  for (let i = 0; i < n; i++) {
    const rising  = tdfIsRising(hma, i);
    const falling = tdfIsFalling(hma, i);

    if (rising) {
      if      (dir === 'short') { if (count > 0) completedShort.push(count); dir = 'long';  count = 1; }
      else if (dir === 'long')  { count++; }
      else                      { dir = 'long'; count = 1; }
    } else if (falling) {
      if      (dir === 'long')  { if (count > 0) completedLong.push(count);  dir = 'short'; count = 1; }
      else if (dir === 'short') { count++; }
      else                      { dir = 'short'; count = 1; }
    } else {
      if (dir !== null) count++;  // neutral bar: hold direction, keep counting
    }
  }

  if (dir === null) return null;

  const history = dir === 'long' ? completedLong : completedShort;
  const recent  = history.slice(-TDF_SAMPLES);
  if (recent.length < 2) return null;  // not enough phase history

  // Probable length: median of recent completed phases, clamped 8-60 bars
  let pl = tdfMedian(recent);
  pl = Math.max(8, Math.min(60, pl));

  const progressPct = Math.min(count / pl * 100, 150);

  let zone;
  if      (progressPct < 25)  zone = 'green';
  else if (progressPct < 50)  zone = 'yellow';
  else if (progressPct < 75)  zone = 'orange';
  else if (progressPct < 100) zone = 'red';
  else if (progressPct < 125) zone = 'ext_slight';
  else if (progressPct < 150) zone = 'ext_moderate';
  else                         zone = 'ext_large';

  const barsLeft = Math.max(0, Math.round(pl - count));
  let bracket;
  if      (zone.startsWith('ext')) bracket = 'running long';
  else if (barsLeft >= 20)         bracket = '20+ bars';
  else if (barsLeft >= 10)         bracket = '10-20 bars';
  else if (barsLeft >= 5)          bracket = '5-10 bars';
  else if (barsLeft >= 1)          bracket = 'closing out';
  else                              bracket = 'may reverse';

  return {
    tdf_direction:              dir,
    tdf_progress_pct:           Math.round(progressPct * 10) / 10,
    tdf_zone:                   zone,
    tdf_bars_remaining_bracket: bracket,
    tdf_probable_length:        Math.round(pl * 10) / 10,
    tdf_trend_count:            count,
  };
}

// ── SIGNAL LAYER HELPERS ──────────────────────────────────────────────────────
// Computes regime, RSI divergence, and MACD depth from 200-bar price history.
// All inputs come from Phase 1 bar data — no extra Polygon API calls needed.

/** EMA of a numeric array (oldest→newest). k = 2/(span+1) */
function calcEmaArr(src: number[], span: number): number[] {
  const k = 2 / (span + 1);
  const out = new Array(src.length).fill(NaN);
  // Seed with first non-NaN
  let seed = 0;
  while (seed < src.length && isNaN(src[seed])) seed++;
  if (seed >= src.length) return out;
  out[seed] = src[seed];
  for (let i = seed + 1; i < src.length; i++) {
    out[i] = isNaN(src[i]) ? NaN : src[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/**
 * RSI(14) history using Wilder smoothing (oldest→newest).
 * Returns array same length as closesAsc; NaN for early bars.
 */
function calcRsiHistory(closesAsc: number[], period = 14): number[] {
  const n = closesAsc.length;
  const out = new Array(n).fill(NaN);
  if (n < period + 1) return out;
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= period; i++) {
    const d = closesAsc[i] - closesAsc[i - 1];
    if (d > 0) avgG += d; else avgL -= d;
  }
  avgG /= period; avgL /= period;
  out[period] = avgL > 0 ? 100 - 100 / (1 + avgG / avgL) : 100;
  for (let i = period + 1; i < n; i++) {
    const d = closesAsc[i] - closesAsc[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgL > 0 ? 100 - 100 / (1 + avgG / avgL) : 100;
  }
  return out;
}

/**
 * MACD histogram history (oldest→newest).
 * Returns array same length as closesAsc; NaN for early bars.
 */
function calcMacdHistHistory(closesAsc: number[], fast = 12, slow = 26, sig = 9): number[] {
  const n = closesAsc.length;
  if (n < slow + sig) return new Array(n).fill(NaN);
  const emaF = calcEmaArr(closesAsc, fast);
  const emaS = calcEmaArr(closesAsc, slow);
  const macdLine = emaF.map((v, i) => (isNaN(v) || isNaN(emaS[i])) ? NaN : v - emaS[i]);
  const sigLine  = calcEmaArr(macdLine, sig);
  return macdLine.map((v, i) => (isNaN(v) || isNaN(sigLine[i])) ? NaN : v - sigLine[i]);
}

/**
 * Classify regime from 4 current-bar indicators.
 * Thresholds match regime_extended.py validation on SMA20/SMA50 basis.
 */
function classifyRegime(
  rsi: number, pctSma20: number, pctSma50: number
): string {
  if (rsi >= 78 && pctSma20 >= 12.0)  return 'OB+ Bull';
  if (rsi >= 70 && pctSma20 >= 5.0)   return 'OB Bull';
  if (rsi <= 22 && pctSma50 <= -15.0) return 'OB+ Bear';
  if (rsi <= 30 && pctSma50 <= -7.0)  return 'OB Bear';
  if (pctSma50 <= -7.0 || (pctSma50 < 0 && rsi < 40)) return 'Normal Bear';
  if (pctSma20 >= 5.0  || (pctSma20 > 0 && rsi > 60)) return 'Normal Bull';
  return 'Neutral';
}

/**
 * Detect RSI divergences over a lookback window.
 * bear_div_age > 0: RSI lower high while price higher high (→ short signal)
 * bull_div_age > 0: RSI higher low while price lower low  (→ long signal)
 * Age = bars elapsed since the most recent divergence pivot (1-indexed).
 * Returns 0 for both if no divergence found.
 */
function detectDivergence(
  closesAsc: number[],
  rsiArr:    number[],
  opts = { lookback: 80, pivotWin: 5, minSep: 8, maxSep: 70, minRsiDiff: 2.0 }
): { bull_div_age: number; bear_div_age: number } {
  const { lookback, pivotWin, minSep, maxSep, minRsiDiff } = opts;
  const n = closesAsc.length;
  const start = Math.max(0, n - lookback);

  // Slice to lookback window (valid RSI bars only)
  const rsiSlice: number[]   = [];
  const closeSlice: number[] = [];
  for (let i = start; i < n; i++) {
    if (!isNaN(rsiArr[i])) { rsiSlice.push(rsiArr[i]); closeSlice.push(closesAsc[i]); }
  }
  const m = rsiSlice.length;
  if (m < pivotWin * 2 + 2) return { bull_div_age: 0, bear_div_age: 0 };

  const isPivHigh = (arr: number[], i: number) => {
    if (i < pivotWin || i >= arr.length - pivotWin) return false;
    for (let j = i - pivotWin; j <= i + pivotWin; j++) {
      if (j !== i && arr[j] >= arr[i]) return false;
    }
    return true;
  };
  const isPivLow = (arr: number[], i: number) => {
    if (i < pivotWin || i >= arr.length - pivotWin) return false;
    for (let j = i - pivotWin; j <= i + pivotWin; j++) {
      if (j !== i && arr[j] <= arr[i]) return false;
    }
    return true;
  };

  // ── Bear divergence: RSI lower high, price higher high ──────────────────────
  let bearDivAge = 0;
  const rsiHighs: number[] = [];
  for (let i = 0; i < m; i++) if (isPivHigh(rsiSlice, i)) rsiHighs.push(i);
  if (rsiHighs.length >= 2) {
    const last = rsiHighs[rsiHighs.length - 1];
    for (let k = rsiHighs.length - 2; k >= 0; k--) {
      const prev = rsiHighs[k];
      const sep  = last - prev;
      if (sep < minSep || sep > maxSep) continue;
      if (rsiSlice[last] < rsiSlice[prev] - minRsiDiff &&
          closeSlice[last] >= closeSlice[prev]) {
        bearDivAge = m - last; // bars ago (1 = fired on most-recent pivot bar)
        break;
      }
    }
  }

  // ── Bull divergence: RSI higher low, price lower low ────────────────────────
  let bullDivAge = 0;
  const rsiLows: number[] = [];
  for (let i = 0; i < m; i++) if (isPivLow(rsiSlice, i)) rsiLows.push(i);
  if (rsiLows.length >= 2) {
    const last = rsiLows[rsiLows.length - 1];
    for (let k = rsiLows.length - 2; k >= 0; k--) {
      const prev = rsiLows[k];
      const sep  = last - prev;
      if (sep < minSep || sep > maxSep) continue;
      if (rsiSlice[last] > rsiSlice[prev] + minRsiDiff &&
          closeSlice[last] <= closeSlice[prev]) {
        bullDivAge = m - last;
        break;
      }
    }
  }

  return { bull_div_age: bullDivAge, bear_div_age: bearDivAge };
}

// ── SMART CANDLE STATE ────────────────────────────────────────────────────────
// Ports BUY/SELL logic from s.html Smart Candle Signal Engine v2.1.
// BUY:  peak→trough swing >5 bars, RSI(14) touches ≤46 in segment → fires at trough
// SELL: 3 consecutive red candles starting 6+ bars after trough (1 per BUY)
// State as of the most-recent bar:
//   FRESH  — last BUY 0-5 bars ago, no SELL since   → STRONG BUY screener tier
//   ACTIVE — last BUY 6-15 bars ago, no SELL since  → BUY screener tier
//   WATCH  — last BUY 16-30 bars ago, no SELL since → WEAK BUY screener tier
//   NEUTRAL — no recent BUY, or cycle complete (SELL fired)
// SELL signals are structurally unreliable (TA-only, secular bull market) so they
// collapse to NEUTRAL rather than being exposed in screener output.
function computeSmartCandleState(barsAsc: {o:number,h:number,l:number,c:number}[]):
    { sc_state: string; sc_bars_since_b: number | null; sc_sell_raw: boolean } {

  const n = barsAsc.length;
  const closes = barsAsc.map((b) => b.c);
  const highs   = barsAsc.map((b) => b.h);
  const lows    = barsAsc.map((b) => b.l);
  const opens   = barsAsc.map((b) => b.o);

  // ── Raw sell: 3 consecutive red candles in last 10 bars, no B prerequisite ──
  // Tested in parallel with sc_state='SELL' (which requires a prior B) to compare.
  let scSellRaw = false;
  if (n >= 3) {
    const rawEnd = n - 1;
    let rawRed = 0;
    for (let j = Math.max(0, rawEnd - 9); j <= rawEnd; j++) {
      const isRed = closes[j] < opens[j];
      if (!isRed) { rawRed = 0; continue; }
      const gapDn = j > 0 && (highs[j] < closes[j-1] || highs[j] < lows[j-1]);
      rawRed = gapDn ? 1 : rawRed + 1;
      if (rawRed >= 3) { scSellRaw = true; break; }
    }
  }

  const NEUTRAL = { sc_state: 'NEUTRAL', sc_bars_since_b: null, sc_sell_raw: scSellRaw };
  if (n < 20) return NEUTRAL;

  // ── Pivot detection (forward-only, exact port) ──────────────────────────────
  const PIVOT_WIN = 5, MIN_GAP = 8;
  const rawPivots: {idx:number,type:string}[] = [];
  for (let i = PIVOT_WIN; i < n - PIVOT_WIN; i++) {
    let isH = true, isL = true;
    for (let j = i + 1; j <= i + PIVOT_WIN; j++) {
      if (highs[j] >= highs[i]) isH = false;
      if (lows[j]  <= lows[i])  isL = false;
    }
    if (!isH && !isL) continue;
    const ns = Math.max(0, i - 10);
    let avgR = 0;
    for (let k = ns; k <= i; k++) avgR += highs[k] - lows[k];
    avgR /= (i - ns + 1);
    if (avgR === 0) continue;
    let ss = Math.max(0, i - PIVOT_WIN);
    for (let k = i - 1; k > ss; k--) {
      if (k >= 1 && highs[k] < lows[k - 1]) { ss = k; break; }
    }
    let swSz = 0;
    if (i > ss) {
      if (isH) { let mn = lows[ss]; for (let k = ss; k < i; k++) if (lows[k] < mn) mn = lows[k]; swSz = highs[i] - mn; }
      else      { let mx = highs[ss]; for (let k = ss; k < i; k++) if (highs[k] > mx) mx = highs[k]; swSz = mx - lows[i]; }
    }
    if (swSz < avgR * 1.2) continue;
    if (isH) rawPivots.push({ idx: i, type: 'high' });
    if (isL) rawPivots.push({ idx: i, type: 'low' });
  }
  rawPivots.sort((a, b) => a.idx - b.idx);
  const pivots: {idx:number,type:string}[] = [];
  for (const p of rawPivots) {
    if (!pivots.length || p.idx - pivots[pivots.length - 1].idx >= MIN_GAP) pivots.push(p);
  }
  const fPivots = pivots.map((p) => ({ idx: p.idx, type: p.type === 'high' ? 'peak' : 'trough' }));

  // ── RSI(14) ─────────────────────────────────────────────────────────────────
  const rsi = new Array(n).fill(50);
  for (let i = 14; i < n; i++) {
    let ag = 0, al = 0;
    for (let j = i - 13; j <= i; j++) { const d = closes[j] - closes[j-1]; if (d > 0) ag += d; else al -= d; }
    ag /= 14; al /= 14;
    rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }

  // ── BUY events ──────────────────────────────────────────────────────────────
  const bSig = new Array(n).fill(false);
  const sSig = new Array(n).fill(false);
  const bTroughs: number[] = [];
  for (let p = 0; p < fPivots.length - 1; p++) {
    const fr = fPivots[p], to = fPivots[p + 1];
    if (fr.type !== 'peak' || to.type !== 'trough') continue;
    if (to.idx - fr.idx <= 5) continue;
    let minR = 100;
    for (let i = fr.idx; i <= to.idx; i++) if (rsi[i] < minR) minR = rsi[i];
    if (minR <= 46) { bSig[to.idx] = true; bTroughs.push(to.idx); }
  }

  // ── SELL events ─────────────────────────────────────────────────────────────
  // No cap — scan all bars from each B trough to end of history.
  // Matches s.html (j < allBars.length) and validated backtest (range(scan_start, n)).
  for (const bIdx of bTroughs) {
    let red = 0;
    for (let j = bIdx + PIVOT_WIN + 1; j < n; j++) {
      const isRed = closes[j] < opens[j];
      if (!isRed) { red = 0; continue; }
      const gapDn = j > 0 && (highs[j] < closes[j-1] || highs[j] < lows[j-1]);
      red = gapDn ? 1 : red + 1;
      if (red >= 3) { sSig[j] = true; break; }
    }
  }

  // ── State as of the last bar ─────────────────────────────────────────────────
  // Find most-recent B first, then check if S came after it.
  // sc_bars_since_b is preserved for SELL state so screener can show entry context.
  const cur = n - 1;

  // Most-recent B in last 40 bars (wider window so SELL can reference its B)
  let lastB = -1;
  for (let i = Math.max(0, cur - 40); i <= cur; i++) if (bSig[i]) lastB = i;
  if (lastB === -1) return NEUTRAL;

  // Did S fire AFTER the most-recent B?
  // Return SELL and preserve how long ago the B was so screener has entry context.
  for (let i = lastB + 1; i <= cur; i++) {
    if (sSig[i]) return { sc_state: 'SELL', sc_bars_since_b: cur - lastB, sc_sell_raw: scSellRaw };
  }

  // No S after last B → buy tier by age (only count B within 30 bars for buy tiers)
  const age = cur - lastB;
  if (age > 30) return NEUTRAL;
  const state = age <= 5 ? 'FRESH' : age <= 15 ? 'ACTIVE' : 'WATCH';
  return { sc_state: state, sc_bars_since_b: age, sc_sell_raw: scSellRaw };
}

// ── PRICE BARS (per-ticker aggregate) + ADX(14) + STOCHASTIC(14,3) + TDF ─────
// v24-tdf: Resumable Phase 1.
//   WHY: With 224 tickers × 70ms sleep + API latency ≈ 95-130s per run,
//   any Polygon 429 retry (+30s) can exceed MAX_RUNTIME with no safety valve.
//   FIX: Merged fetch+compute loops so each ticker is processed immediately.
//   Time budget checked per ticker — if exceeded, collected rows are UPSERTed
//   and the function returns {done:false, processedIdx} so the next cron
//   invocation resumes from where it left off (via batch_state.ticker_index).
//   batch_state.ticker_index dual-purpose:
//     price_bars_done=false → Phase 1 resume index
//     price_bars_done=true  → Phase 2 resume index (reset to 0 after Phase 1)
async function fetchPriceBars(supabase, tradingDate, TICKERS, startIdx = 0, startMs = Date.now()) {
  // ─── computePivotFib: ported from screener.html
  // bars are passed as ASC (oldest first), as in the screener
  // Returns {tg1, tg2, support, resistance, pivot_pp, pivot_r1, pivot_r2, pivot_s1, pivot_s2, fib_levels, swing_high, swing_low}
  function computePivotFib(barsAsc, price, bbUpper, bbLower) {
    if (!barsAsc || barsAsc.length < 5) return null;
    const n = barsAsc.length;
    const yest = barsAsc[n - 2] || barsAsc[n - 1];
    const H = yest.h, L = yest.l, C = yest.c;
    const PP = (H + L + C) / 3;
    const R1 = +(2 * PP - L).toFixed(4);
    const R2 = +(PP + (H - L)).toFixed(4);
    const S1 = +(2 * PP - H).toFixed(4);
    const S2 = +(PP - (H - L)).toFixed(4);
    // 50-day swing (or available days if fewer)
    const swingBars = barsAsc.slice(-Math.min(50, n));
    const swingH = Math.max(...swingBars.map((b) => b.h));
    const swingL = Math.min(...swingBars.map((b) => b.l));
    const swingRange = swingH - swingL;
    const fibLevels = {
      r0: +swingH.toFixed(4),
      r236: +(swingH - swingRange * 0.236).toFixed(4),
      r382: +(swingH - swingRange * 0.382).toFixed(4),
      r500: +(swingH - swingRange * 0.500).toFixed(4),
      r618: +(swingH - swingRange * 0.618).toFixed(4),
      r786: +(swingH - swingRange * 0.786).toFixed(4),
      r100: +swingL.toFixed(4),
      ext127: +(swingH + swingRange * 0.272).toFixed(4),
      ext162: +(swingH + swingRange * 0.618).toFixed(4),
    };
    // Direction: simple trend from swing position. >50% of range = uptrending; <50% = downtrending
    const pctOfRange = swingRange > 0 ? (price - swingL) / swingRange : 0.5;
    const goingUp = pctOfRange > 0.55;
    const goingDn = pctOfRange < 0.45;
    let tg1 = null, tg2 = null, support = null, resistance = null;
    if (goingUp) {
      const candidates = [R1, R2, fibLevels.r236, fibLevels.r0, fibLevels.ext127]
        .filter((v) => v && v > price * 1.005).sort((a, b) => a - b);
      tg1 = candidates[0] || null;
      tg2 = candidates[1] || null;
      const supCandidates = [S1, S2, fibLevels.r618, fibLevels.r786, bbLower]
        .filter((v) => v && v < price * 0.998).sort((a, b) => b - a);
      support = supCandidates[0] || null;
      resistance = tg1;
    } else if (goingDn) {
      const candidates = [S1, S2, fibLevels.r618, fibLevels.r786, fibLevels.r100]
        .filter((v) => v && v < price * 0.995).sort((a, b) => b - a);
      tg1 = candidates[0] || null;
      tg2 = candidates[1] || null;
      const resCandidates = [R1, R2, fibLevels.r382, fibLevels.r236, bbUpper]
        .filter((v) => v && v > price * 1.002).sort((a, b) => a - b);
      resistance = resCandidates[0] || null;
      support = tg1;
    } else {
      // Neutral
      tg1 = R1 || null;
      support = S1 || null;
      resistance = R1 || null;
    }
    return {
      tg1,
      tg2,
      support,
      resistance,
      pivot_pp: +PP.toFixed(4),
      pivot_r1: R1,
      pivot_r2: R2,
      pivot_s1: S1,
      pivot_s2: S2,
      fib_levels: fibLevels,
      swing_high_50d: +swingH.toFixed(4),
      swing_low_50d: +swingL.toFixed(4),
    };
  }
  // ── Per-ticker aggregate fetch (resumable, merged fetch+compute loop) ────────
  // WHY: grouped/daily returns ALL ~8,000 US stocks per call → WORKER_RESOURCE_LIMIT.
  //   Per-ticker range: 1 call per ticker, only the bars we need → tiny footprint.
  // RESUMABLE: time budget checked per ticker. If budget exceeded mid-loop,
  //   collected rows are UPSERTed and {done:false, processedIdx} is returned so
  //   the next cron invocation resumes from processedIdx via batch_state.ticker_index.
  const fromObj = new Date(tradingDate + 'T12:00:00');
  // 370 calendar days ≈ 252+ trading days — extended to support 52-week high/low
  // computation in addition to the existing 200-bar TDF/signal-layer needs.
  fromObj.setDate(fromObj.getDate() - 370);
  const fromDate = fromObj.toISOString().slice(0, 10);
  const remaining = TICKERS.length - startIdx;
  console.log(`[batch:bars] ${startIdx > 0 ? `resuming from ${startIdx}` : 'start'} — ${fromDate}→${tradingDate}, ${remaining}/${TICKERS.length} tickers remaining`);

  // Helper: UPSERT the rows collected so far (in chunks of 50)
  async function flushRows(rows) {
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 50) {
      const result = await supabase.from('ta_cache').upsert(rows.slice(i, i + 50), { onConflict: 'ticker,trading_date' });
      if (result?.error) console.error('[batch:bars] upsert error:', result.error.message);
    }
  }

  const rows = [];

  for (let t = startIdx; t < TICKERS.length; t++) {
    // ── Time budget: exit 20s before MAX_RUNTIME so we have time to UPSERT + update state
    if (Date.now() - startMs > MAX_RUNTIME - 20000) {
      console.log(`[batch:bars] time budget hit at ticker ${t}/${TICKERS.length} (${Math.round((Date.now()-startMs)/1000)}s elapsed) — flushing ${rows.length} rows`);
      await flushRows(rows);
      return { done: false, processedIdx: t };
    }

    const tk = TICKERS[t];
    let bars = null;

    try {
      const url = `${POLYGON_BASE}/v2/aggs/ticker/${encodeURIComponent(tk)}/range/1/day/${fromDate}/${tradingDate}?adjusted=true&sort=desc&limit=260&apiKey=${POLYGON_KEY}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (r.status === 429) {
        // Only retry if we have enough time budget remaining (30s wait + this ticker's processing)
        if (Date.now() - startMs + 32000 < MAX_RUNTIME - 20000) {
          console.warn(`[batch:bars] 429 for ${tk} — waiting 30s`);
          await sleep(30000);
          const r2 = await fetch(url, { signal: AbortSignal.timeout(15000) });
          if (r2.ok) { const d2 = await r2.json(); if (d2?.results?.length > 0) bars = d2.results; }
        } else {
          console.warn(`[batch:bars] 429 for ${tk} — no time budget for retry, skipping`);
        }
      } else if (r.ok) {
        const data = await r.json();
        if (data?.results?.length > 0) bars = data.results; // DESC: [0]=today
      }
    } catch (e) {
      console.warn(`[batch:bars] fetch error ${tk}:`, e.message);
    }
    await sleep(70);

    if (!bars || !bars.length) continue;

    // ── Compute TA metrics immediately for this ticker (no separate pass needed)
    const closes = bars.map((b) => b.c);
    const highs   = bars.map((b) => b.h);
    const lows    = bars.map((b) => b.l);
    const price   = closes[0];
    const n       = bars.length;

    // atr14: average true range over the most-recent 14 bars (bars[] is DESC)
    const atr14Bars = Math.min(14, n);
    const atr14 = bars.slice(0, atr14Bars).reduce((s, b) => s + (b.h - b.l), 0) / atr14Bars;
    // mom5: 5-trading-day momentum — closes[0]=today, closes[5]=5 days ago (DESC order)
    const mom5    = n >= 6 ? (closes[0] - closes[5]) / closes[5] * 100 : 0;
    const mean5   = closes.slice(0, Math.min(5, n)).reduce((a, b) => a + b, 0) / Math.min(5, n);
    const std5    = Math.sqrt(closes.slice(0, Math.min(5, n)).reduce((a, b) => a + (b - mean5) ** 2, 0) / Math.min(5, n)) || atr14;
    const bollPos = 4 * std5 > 0 ? Math.min(100, Math.max(0, (price - (mean5 - 2 * std5)) / (4 * std5) * 100)) : 50;

    // prev_close + daily change — bars[1] is yesterday's bar (DESC order)
    const prev_close = n >= 2 ? closes[1] : null;
    const change_abs = prev_close != null ? Math.round((price - prev_close) * 100) / 100 : null;
    const change_pct = prev_close != null ? Math.round((price - prev_close) / prev_close * 10000) / 100 : null;

    // avg_vol20: 20-day average volume; vol_ratio: today vs average
    const vol20Bars = Math.min(20, n);
    const avg_vol20 = bars.slice(0, vol20Bars).reduce((s: number, b: any) => s + (b.v || 0), 0) / vol20Bars;
    const vol_ratio = avg_vol20 > 0 ? Math.round(bars[0].v / avg_vol20 * 100) / 100 : null;

    let stoch_k = null;
    if (n >= 14) {
      const h14 = Math.max(...highs.slice(0, 14));
      const l14 = Math.min(...lows.slice(0, 14));
      const range14 = h14 - l14;
      stoch_k = range14 > 0 ? (price - l14) / range14 * 100 : 50;
      stoch_k = Math.round(stoch_k * 100) / 100;
    }

    let adx14 = null;
    if (n >= 28) {
      const c = [...closes].reverse();
      const h = [...highs].reverse();
      const l = [...lows].reverse();
      const len = c.length;
      const tr = [], pdm = [], mdm = [];
      for (let i = 1; i < len; i++) {
        const hl = h[i] - l[i];
        const hc = Math.abs(h[i] - c[i - 1]);
        const lc = Math.abs(l[i] - c[i - 1]);
        tr.push(Math.max(hl, hc, lc));
        const up = h[i] - h[i - 1];
        const dn = l[i - 1] - l[i];
        pdm.push(up > dn && up > 0 ? up : 0);
        mdm.push(dn > up && dn > 0 ? dn : 0);
      }
      if (tr.length >= 27) {
        let atr  = tr.slice(0, 14).reduce((s, v) => s + v, 0);
        let aPdm = pdm.slice(0, 14).reduce((s, v) => s + v, 0);
        let aMdm = mdm.slice(0, 14).reduce((s, v) => s + v, 0);
        const dxArr = [];
        for (let i = 14; i < tr.length; i++) {
          atr  = atr  - atr  / 14 + tr[i];
          aPdm = aPdm - aPdm / 14 + pdm[i];
          aMdm = aMdm - aMdm / 14 + mdm[i];
          const pdi = atr > 0 ? aPdm / atr * 100 : 0;
          const mdi = atr > 0 ? aMdm / atr * 100 : 0;
          const diSum = pdi + mdi;
          const dx = diSum > 0 ? Math.abs(pdi - mdi) / diSum * 100 : 0;
          dxArr.push(dx);
        }
        if (dxArr.length >= 14) {
          let adxVal = dxArr.slice(0, 14).reduce((s, v) => s + v, 0) / 14;
          for (let i = 14; i < dxArr.length; i++) adxVal = (adxVal * 13 + dxArr[i]) / 14;
          adx14 = Math.round(adxVal * 100) / 100;
        }
      }
    }

    const row: any = {
      ticker: tk, trading_date: tradingDate,
      price, atr14, boll_pos: bollPos, mom5, vol: bars[0].v || 0,
    };
    if (stoch_k !== null)  row.stoch_k    = stoch_k;
    if (adx14   !== null)  row.adx14      = adx14;
    if (SECTOR_MAP[tk])    row.sector     = SECTOR_MAP[tk];
    if (prev_close !== null) row.prev_close = prev_close;
    if (change_abs !== null) row.change_abs = change_abs;
    if (change_pct !== null) row.change_pct = change_pct;
    if (avg_vol20 > 0)       row.avg_vol20  = Math.round(avg_vol20);
    if (vol_ratio !== null)  row.vol_ratio  = vol_ratio;

    // ─── Support/Resistance/Pivot/Fib
    try {
      const barsAsc = [...bars].reverse();
      const bbUpper = mean5 + 2 * std5;
      const bbLower = mean5 - 2 * std5;
      const sr = computePivotFib(barsAsc, price, bbUpper, bbLower);
      if (sr) {
        row.tg1 = sr.tg1; row.tg2 = sr.tg2;
        row.support = sr.support; row.resistance = sr.resistance;
        row.pivot_pp = sr.pivot_pp; row.pivot_r1 = sr.pivot_r1; row.pivot_r2 = sr.pivot_r2;
        row.pivot_s1 = sr.pivot_s1; row.pivot_s2 = sr.pivot_s2;
        row.fib_levels = sr.fib_levels;
        row.swing_high_50d = sr.swing_high_50d; row.swing_low_50d = sr.swing_low_50d;
        row.sr_computed_at = new Date().toISOString();
      }
    } catch (e) {
      console.warn(`[batch:bars] S/R compute failed for ${tk}:`, e.message);
    }

    // ─── TDF: Trend Duration Forecast (VizHeat replacement)
    // closesAsc = oldest→newest; bars[] is DESC (newest first), so reverse it
    try {
      const closesAsc = [...closes].reverse();
      const tdf = computeTDF(closesAsc);
      if (tdf) {
        row.tdf_direction              = tdf.tdf_direction;
        row.tdf_progress_pct           = tdf.tdf_progress_pct;
        row.tdf_zone                   = tdf.tdf_zone;
        row.tdf_bars_remaining_bracket = tdf.tdf_bars_remaining_bracket;
        row.tdf_probable_length        = tdf.tdf_probable_length;
        row.tdf_trend_count            = tdf.tdf_trend_count;
      }
    } catch (e) {
      console.warn(`[batch:bars] TDF compute failed for ${tk}:`, e.message);
    }

    // ─── Smart Candle State (VizSignal)
    // Always set defaults so sc_state can never be silently NULL, even if
    // computeSmartCandleState throws. The catch logs full stack so we can
    // diagnose any consistent failure mode.
    row.sc_state    = 'NEUTRAL';
    row.sc_sell_raw = false;
    try {
      // Guard: need a non-empty bar array with valid OHLC values
      if (!Array.isArray(bars) || bars.length < 3) {
        // n<20 already returns NEUTRAL inside the function, but skip the heavy
        // pivot computation for sub-3-bar arrays (function would noop anyway)
      } else if (typeof bars[0]?.o !== 'number' || typeof bars[0]?.h !== 'number' ||
                 typeof bars[0]?.l !== 'number' || typeof bars[0]?.c !== 'number') {
        console.warn(`[batch:bars] SC skipped for ${tk}: bar[0] missing OHLC numbers`);
      } else {
        const scBarsAsc = [...bars].reverse() as {o:number,h:number,l:number,c:number}[];
        const sc = computeSmartCandleState(scBarsAsc);
        row.sc_state    = sc.sc_state;
        row.sc_sell_raw = sc.sc_sell_raw;
        if (sc.sc_bars_since_b !== null) row.sc_bars_since_b = sc.sc_bars_since_b;
      }
    } catch (e: any) {
      // Loud + structured logging so we can diagnose by ticker name pattern
      console.error(`[batch:bars] SC state THREW for ${tk}: ${e?.message ?? e}`,
                    `\n  bars.length=${bars?.length} bars[0]=${JSON.stringify(bars?.[0])}`,
                    `\n  stack: ${e?.stack ?? '(no stack)'}`);
      // Defaults already set above — row.sc_state stays 'NEUTRAL' so no NULL leak
    }

    // ─── SMA20 / SMA50 / SMA200 computed from Phase 1 bars (Phase 2 Polygon fetch is
    //     the last two indicators and may not complete before timeout).
    //     bars[] is DESC (bars[0]=today), so slice(0,N) = most-recent N closes.
    const latestClose = closes[0];
    if (n >= 20) {
      row.sma20 = Math.round(closes.slice(0, 20).reduce((s: number, v: number) => s + v, 0) / 20 * 10000) / 10000;
      // pct_sma20: % price is above/below SMA20 (positive = above, negative = below)
      if (latestClose && row.sma20) row.pct_sma20 = Math.round(((latestClose - row.sma20) / row.sma20) * 100 * 100) / 100;
    }
    if (n >= 50) {
      row.sma50  = Math.round(closes.slice(0, 50).reduce((s: number, v: number) => s + v, 0) / 50 * 10000) / 10000;
      // pct_sma50: % price is above/below SMA50 (positive = above, negative = below)
      if (latestClose && row.sma50) row.pct_sma50 = Math.round(((latestClose - row.sma50) / row.sma50) * 100 * 100) / 100;
    }
    if (n >= 200) row.sma200 = Math.round(closes.slice(0, 200).reduce((s: number, v: number) => s + v, 0) / 200 * 10000) / 10000;

    // ─── 52-Week High/Low — computed from the same DESC bar window. ─────────
    // Uses up to 252 trading days (full 52-week window). Falls back gracefully
    // if fewer bars are available (e.g. newer tickers).
    //
    // SANITY GUARD: Polygon's `adjusted=true` flag occasionally misses reverse
    // splits on illiquid microcaps, leaving pre-split prices in the historical
    // bars. If h52 > 50× latestClose, the bar series is suspect — we leave the
    // 52w fields NULL rather than poison the VCP / 52w-high screeners.
    if (n >= 60) {
      const win = Math.min(252, n);
      const slicedH = highs.slice(0, win);
      const slicedL = lows.slice(0, win);
      const h52 = Math.max(...slicedH);
      const l52 = Math.min(...slicedL);
      const dataLooksClean =
        latestClose != null && latestClose > 0 &&
        h52 > 0 && l52 > 0 &&
        h52 <= latestClose * 50;       // reject implied 98%+ drawdown as suspicious
      if (dataLooksClean) {
        row.high52 = Math.round(h52 * 10000) / 10000;
        row.low52  = Math.round(l52 * 10000) / 10000;
        // pct_from_52h: percent below 52-week high. 0 = at high, -10 = 10% below.
        row.pct_from_52h = Math.round(((latestClose - h52) / h52) * 100 * 100) / 100;
      }
    }

    // ─── Signal Layer: Regime + MACD Depth + RSI Divergence ──────────────────
    // All computed from Phase 1 bar data (200 bars). No extra Polygon calls.
    // closes[] is DESC (closes[0]=today) — reverse to ASC for time-series funcs.
    try {
      const closesAsc = [...closes].reverse(); // oldest→newest
      const nAsc      = closesAsc.length;

      // ── RSI(14) history ────────────────────────────────────────────────────
      const rsiArr  = calcRsiHistory(closesAsc);
      const localRsi = !isNaN(rsiArr[nAsc - 1]) ? Math.round(rsiArr[nAsc - 1] * 100) / 100 : null;

      // ── MACD histogram history ─────────────────────────────────────────────
      const macdArr  = calcMacdHistHistory(closesAsc);
      const localMacdH = !isNaN(macdArr[nAsc - 1]) ? Math.round(macdArr[nAsc - 1] * 10000) / 10000 : null;

      // ── Regime ────────────────────────────────────────────────────────────
      const pctSma20 = row.pct_sma20 ?? null;
      const pctSma50 = row.pct_sma50 ?? null;
      if (localRsi !== null && pctSma20 !== null && pctSma50 !== null) {
        row.regime = classifyRegime(localRsi, pctSma20, pctSma50);
      }

      // ── MACD 26-bar rolling crest + depth ─────────────────────────────────
      if (localMacdH !== null && nAsc >= 26) {
        const window26 = macdArr.slice(nAsc - 26).filter((v) => !isNaN(v));
        if (window26.length > 0) {
          const crest = Math.max(...window26);
          row.macd_crest18 = Math.round(crest * 10000) / 10000;
          row.macd_depth18 = Math.round((crest - localMacdH) * 10000) / 10000;
        }
      }

      // ── RSI Bull / Bear Divergence ────────────────────────────────────────
      if (nAsc >= 30) {
        const { bull_div_age, bear_div_age } = detectDivergence(closesAsc, rsiArr);
        row.bull_div_age = bull_div_age;
        row.bear_div_age = bear_div_age;
      }

      // ── Smart RSI signals (RSI7 and RSI5 Recovery-Cross) ─────────────────
      // smart_rsi7_signal: RSI(6) crosses above RSI(14) AND was oversold
      //   (RSI6 < 35) within last 3 bars AND RSI(6) > 35 now (no falling knife)
      // smart_rsi5_signal: same logic with RSI(5) as the fast line
      if (nAsc >= 20) {
        const i = nAsc - 1; // today index
        const rsi6Arr = calcRsiHistory(closesAsc, 6);
        const rsi5Arr = calcRsiHistory(closesAsc, 5);

        // RSI7 (fast=RSI6, slow=RSI14)
        if (!isNaN(rsi6Arr[i]) && !isNaN(rsi6Arr[i - 1]) &&
            !isNaN(rsiArr[i])  && !isNaN(rsiArr[i - 1])) {
          const crossed7        = rsi6Arr[i] > rsiArr[i] && rsi6Arr[i - 1] < rsiArr[i - 1];
          const recentOversold7 = [rsi6Arr[i], rsi6Arr[i - 1], rsi6Arr[i - 2]]
                                    .some(v => typeof v === 'number' && !isNaN(v) && v < 35);
          const noKnife7        = rsi6Arr[i] > 35;
          row.smart_rsi7_signal = crossed7 && recentOversold7 && noKnife7;
        }

        // RSI5 (fast=RSI5, slow=RSI14)
        if (!isNaN(rsi5Arr[i]) && !isNaN(rsi5Arr[i - 1]) &&
            !isNaN(rsiArr[i])  && !isNaN(rsiArr[i - 1])) {
          const crossed5        = rsi5Arr[i] > rsiArr[i] && rsi5Arr[i - 1] < rsiArr[i - 1];
          const recentOversold5 = [rsi5Arr[i], rsi5Arr[i - 1], rsi5Arr[i - 2]]
                                    .some(v => typeof v === 'number' && !isNaN(v) && v < 35);
          const noKnife5        = rsi5Arr[i] > 35;
          row.smart_rsi5_signal = crossed5 && recentOversold5 && noKnife5;
        }
      }
    } catch (e) {
      console.warn(`[batch:bars] signal layer failed for ${tk}:`, (e as Error).message);
    }

    rows.push(row);
  }

  // All tickers processed — UPSERT everything and return done
  if (!rows.length) {
    console.warn('[batch:bars] no rows to upsert (all tickers returned empty bars)');
    return { done: true, processedIdx: TICKERS.length };
  }
  await flushRows(rows);
  const adxCount    = rows.filter((r) => r.adx14      != null).length;
  const stochCount  = rows.filter((r) => r.stoch_k    != null).length;
  const tdfCount    = rows.filter((r) => r.tdf_zone   != null).length;
  const chgCount    = rows.filter((r) => r.change_pct != null).length;
  const volRatioCount = rows.filter((r) => r.vol_ratio != null).length;
  const scFresh  = rows.filter((r) => r.sc_state === 'FRESH').length;
  const scActive = rows.filter((r) => r.sc_state === 'ACTIVE').length;
  const scWatch  = rows.filter((r) => r.sc_state === 'WATCH').length;
  console.log(`[batch:bars] stored ${rows.length} tickers (ADX: ${adxCount}, Stoch: ${stochCount}, TDF: ${tdfCount}, chg_pct: ${chgCount}, vol_ratio: ${volRatioCount}, SC: FRESH=${scFresh} ACTIVE=${scActive} WATCH=${scWatch})`);
  return { done: true, processedIdx: TICKERS.length };
}
// ── CORS / RESPONSE HELPERS ──
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey',
  'Content-Type': 'application/json'
};
const json = (data, status = 200)=>new Response(JSON.stringify(data), {
    status,
    headers: CORS
  });

// ── BATCH EVENT LOGGER ───────────────────────────────────────────────────────
// Writes one row to batch_event_log whenever ta-batch terminates (any reason).
// The admin monitor reads this table to explain daily batch history.
async function logBatchEvent(
  supabase: any,
  tradingDate: string,
  eventType: string,   // 'complete' | 'partial' | 'waiting' | 'error' | 'skipped' | 'reset'
  reason: string,
  triggeredBy: string = 'cron',
  details: Record<string, unknown> = {}
) {
  try {
    await supabase.from('batch_event_log').insert({
      batch_name:   'ta-batch',
      trading_date: tradingDate,
      event_type:   eventType,
      reason,
      triggered_by: triggeredBy,
      details,
    });
  } catch (e) {
    console.warn('[batch] logBatchEvent failed (non-fatal):', e);
  }
}

// ── MAIN HANDLER ────────────────────────────────────────────────────────────
Deno.serve(async (_req)=>{
  if (_req.method === 'OPTIONS') return new Response(null, {
    headers: CORS
  });
  const startMs = Date.now();
  if (!SUPABASE_KEY) return json({
    status: 'error',
    error: 'SUPABASE_SERVICE_ROLE_KEY not set in Secrets'
  }, 500);
  if (!POLYGON_KEY) return json({
    status: 'error',
    error: 'POLYGON_API_KEY not set in Secrets'
  }, 500);
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  let mode = 'auto';
  let dateOverride = null;
  let triggeredBy = 'cron';
  try {
    const body = await _req.json();
    if (body?.mode)         mode        = body.mode;
    if (body?.date)         dateOverride = body.date;
    if (body?.triggered_by) triggeredBy = body.triggered_by;
  } catch  {}
  const TICKERS = await loadTickerUniverse(supabase);
  await loadSectorMap(supabase);
  console.log(`[batch] config: BATCH_SIZE=${BATCH_SIZE} WINDOW_MS=${WINDOW_MS} mode=${mode}`);
  const tradingDate = dateOverride || lastTradingDate();
  console.log(`[batch] invoked tradingDate=${tradingDate} tickers=${TICKERS.length}`);
  await detectAndResetStaleRuns(supabase, tradingDate);
  if (mode === 'reset') {
    console.log(`[batch] 🔄 MANUAL RESET for ${tradingDate}`);
    await supabase.from('batch_state').delete().eq('trading_date', tradingDate);
    await supabase.from('batch_run').update({
      status: 'manual_reset',
      completed_at: new Date().toISOString()
    }).eq('trading_date', tradingDate);
    await supabase.from('ta_cache').delete().eq('trading_date', tradingDate);
    await logBatchEvent(supabase, tradingDate, 'reset',
      'Batch manually reset — ta_cache cleared and batch_state deleted. Must re-run to repopulate.',
      'manual');
    return json({
      status: 'reset_complete',
      trading_date: tradingDate,
      message: 'Cleared batch_state, batch_run, and ta_cache for this date. Run again with mode=full to restart.'
    });
  }
  if (!isTrading(tradingDate)) {
    return json({
      status: 'skipped',
      reason: 'not_trading_day',
      trading_date: tradingDate
    });
  }
  // ═══════════════════════════════════════════════════════════════════
  // OVERLAP PROTECTION — Layer B only (advisory lock)
  // Layer A (batch_run running-guard) removed in v23.1:
  //   Reason: zombie rows with stale status='running' (from pre-v23 upsert pattern)
  //   permanently blocked all new invocations via Layer A. Layer B (advisory lock)
  //   provides the real overlap protection — it is atomic, race-free, and
  //   connection-bound (auto-releases if function crashes).
  //   Layer A may be re-added later once the zombie row source is identified.
  // ═══════════════════════════════════════════════════════════════════
  const myRunId = crypto.randomUUID();
  console.log(`[overlap-check] PROCEED my_run_id=${myRunId} trading_date=${tradingDate} mode=lock-only`);
  // ═══════════════════════════════════════════════════════════════════
  // OVERLAP PROTECTION — Layer B (advisory lock, non-blocking)
  // ═══════════════════════════════════════════════════════════════════
  const lockResult = await tryAcquireBatchLock(supabase, tradingDate);
  console.log(
    `[lock] try_acquire result=${lockResult.acquired ? 'acquired' : 'blocked'} ` +
    `lock_key=${lockResult.lockKey} my_run_id=${myRunId}` +
    (lockResult.error ? ` error=${lockResult.error}` : '')
  );
  if (!lockResult.acquired) {
    console.log(
      `[overlap-check] EXIT reason=lock_held my_run_id=${myRunId} ` +
      `lock_key=${lockResult.lockKey} (lock already held by another invocation)`
    );
    await logBatchEvent(supabase, tradingDate, 'skipped',
      'Blocked — another invocation already holds the advisory lock. No duplicate work done.',
      triggeredBy, { lock_key: lockResult.lockKey, my_run_id: myRunId });
    return json({
      status: 'skipped',
      reason: 'lock_held',
      trading_date: tradingDate,
      my_run_id: myRunId,
      lock_key: lockResult.lockKey
    });
  }
  // ═══════════════════════════════════════════════════════════════════
  // We have the lock. Insert our batch_run record with our specific UUID.
  // (Replaces the previous .upsert which silently overwrote rows on conflict.)
  // ═══════════════════════════════════════════════════════════════════
  try {
    const { error: insertErr } = await supabase.from('batch_run').insert({
      id: myRunId,
      trading_date: tradingDate,
      status: 'running',
      started_at: new Date().toISOString(),
      ticker_count: TICKERS.length
    });
    if (insertErr) console.warn(`[batch_run] insert warning: ${insertErr.message}`);
    const stateResult = await supabase.from('batch_state').select('*').eq('trading_date', tradingDate).limit(1);
    let state = stateResult?.data && stateResult.data.length > 0 ? stateResult.data[0] : null;
    if (!state) {
      const nsResult = await supabase.from('batch_state').insert({
        trading_date: tradingDate,
        indicator_index: 0,
        ticker_index: 0,
        status: 'running',
        price_bars_done: false
      }).select();
      const ns = nsResult?.data && nsResult.data.length > 0 ? nsResult.data[0] : null;
      state = ns ?? {
        trading_date: tradingDate,
        indicator_index: 0,
        ticker_index: 0,
        status: 'running',
        price_bars_done: false
      };
    }
    if (state.status === 'complete') {
      // Mark our run completed before returning
      await supabase.from('batch_run').update({
        status: 'complete',
        completed_at: new Date().toISOString()
      }).eq('id', myRunId);
      return json({
        status: 'already_complete',
        trading_date: tradingDate,
        tickers: TICKERS.length,
        my_run_id: myRunId
      });
    }
    let indIdx = state.indicator_index ?? 0;
    let tickerIdx = state.ticker_index ?? 0;
    let priceBarsDone = state.price_bars_done ?? false;
    let batchesFired = 0, totalFetched = 0, totalFailed = 0;
    let loopIterations = 0;
    // ── Phase 1: Price bars (resumable) ──────────────────────────────────────
    // batch_state.ticker_index dual-use:
    //   price_bars_done=false → Phase 1 resume index (next ticker to fetch)
    //   price_bars_done=true  → Phase 2 resume index (reset to 0 after Phase 1)
    if (!priceBarsDone) {
      const phase1StartIdx = tickerIdx; // 0 on first attempt, >0 if resuming
      const phase1 = await fetchPriceBars(supabase, tradingDate, TICKERS, phase1StartIdx, startMs);
      if (phase1.done) {
        // All tickers fetched + UPSERTed — advance to Phase 2
        priceBarsDone = true;
        tickerIdx = 0; // Reset for Phase 2 indicator loop
        await supabase.from('batch_state').update({
          price_bars_done: true,
          ticker_index: 0,
          last_updated: new Date().toISOString()
        }).eq('trading_date', tradingDate);
        batchesFired++;
      } else {
        // Time budget hit mid Phase 1 — save progress, exit cleanly.
        // Next cron invocation will resume from phase1.processedIdx.
        console.log(`[batch] Phase 1 partial: ${phase1.processedIdx}/${TICKERS.length} tickers done — resuming next cron run`);
        await supabase.from('batch_state').update({
          ticker_index: phase1.processedIdx,
          price_bars_done: false,
          last_updated: new Date().toISOString()
        }).eq('trading_date', tradingDate);
        await supabase.from('batch_run').update({
          status: 'partial',
          completed_at: new Date().toISOString(),
          tickers_done: phase1.processedIdx,
          indicators_done: 0
        }).eq('id', myRunId);
        await logBatchEvent(supabase, tradingDate, 'partial',
          `Budget hit during Phase 1 (price bar fetch) — resumed at ticker ${phase1.processedIdx}/${TICKERS.length}. Will continue next cron cycle.`,
          triggeredBy, { phase: 'price_bars', tickers_done: phase1.processedIdx, ticker_count: TICKERS.length });
        return json({
          status: 'partial',
          phase: 'price_bars',
          tickers_done: phase1.processedIdx,
          ticker_count: TICKERS.length,
          my_run_id: myRunId
        });
      }
    }
    // ── Phase 2: Individual indicators (resumable) ──
    while(indIdx < INDICATORS.length){
      const ind = INDICATORS[indIdx];
      while(tickerIdx < TICKERS.length){
        loopIterations++;
        // Diagnostic: every N iterations, check for parallel runs (defense-in-depth)
        // Should NEVER fire if A+B are working correctly. If it does, we have a bug.
        if (loopIterations % OVERLAP_TELEMETRY_INTERVAL === 0) {
          const sneaky = await findActiveRun(supabase, tradingDate, myRunId);
          if (sneaky) {
            console.error(
              `[overlap-WARN] DETECTED parallel run during execution! ` +
              `my_run_id=${myRunId} other_id=${sneaky.id} ` +
              `other_started=${sneaky.started_at} other_age_s=${sneaky.age_seconds} ` +
              `loop_iter=${loopIterations} (this should NOT happen — A+B failed)`
            );
          }
        }
        if (Date.now() - startMs > MAX_RUNTIME - 15000) {
          console.log(`[batch] budget reached ind=${ind.label} tk=${tickerIdx}/${TICKERS.length}`);
          await supabase.from('batch_state').update({
            indicator_index: indIdx,
            ticker_index: tickerIdx,
            price_bars_done: priceBarsDone,
            last_updated: new Date().toISOString(),
            status: 'running'
          }).eq('trading_date', tradingDate);
          // Mark our run as partial (not complete) so next invocation can resume
          await supabase.from('batch_run').update({
            status: 'partial',
            completed_at: new Date().toISOString(),
            tickers_done: tickerIdx,
            indicators_done: indIdx
          }).eq('id', myRunId);
          await logBatchEvent(supabase, tradingDate, 'partial',
            `Budget hit during Phase 2 (indicators) — stopped at indicator "${ind.label}" ticker ${tickerIdx}/${TICKERS.length}. Will continue next cron cycle.`,
            triggeredBy, { phase: 'indicators', indicator: ind.label, indicator_index: indIdx, ticker_index: tickerIdx, ticker_count: TICKERS.length, fetched: totalFetched });
          return json({
            status: 'partial',
            indicator: ind.label,
            indicator_index: indIdx,
            ticker_index: tickerIdx,
            ticker_count: TICKERS.length,
            fetched: totalFetched,
            my_run_id: myRunId
          });
        }
        const batch = TICKERS.slice(tickerIdx, tickerIdx + BATCH_SIZE);
        console.log(`[batch] ${ind.label} [${tickerIdx}..${tickerIdx + batch.length - 1}/${TICKERS.length}]`);

        // ── Parallel fetch — all BATCH_SIZE tickers concurrently (paid Polygon plan:
        //    unlimited calls, no per-call sleep needed). ~200ms per batch vs ~9s sequential.
        //    Phase 2 completes in ~8 cron runs (80 min) instead of ~350 runs (60 hrs).
        const settled = await Promise.allSettled(
          batch.map(tk => polygonFetch(ind.url(tk)))
        );
        const results = settled.map((res, i) => {
          const tk = batch[i];
          if (res.status === 'rejected') return { tk, val: null, rate_limited: false };
          const data = res.value as any;
          return {
            tk,
            val: data?._429 ? null : ind.parse(data),
            rate_limited: data?._429 === true,
          };
        });

        batchesFired++;
        if (results.every((r) => r.rate_limited)) {
          // All 429 — unexpected on paid plan; wait 30s and skip batch to avoid infinite loop
          console.warn(`[batch] full 429 at ticker ${tickerIdx} — waiting 30s then skipping batch`);
          await sleep(30000);
          tickerIdx += batch.length;
          continue;
        }
        for (const r of results){
          if (r.val !== null && !r.rate_limited) {
            totalFetched++;
          } else if (!r.rate_limited) {
            totalFailed++;
          }
        }
        const rows = results.filter((r)=>r.val !== null && !r.rate_limited).map((r)=>({
            ticker: r.tk,
            trading_date: tradingDate,
            [ind.key]: r.val
          }));
        if (rows.length > 0) {
          const _ur = await supabase.from('ta_cache').upsert(rows, {
            onConflict: 'ticker,trading_date'
          });
          if (_ur?.error) console.error('[batch] db error:', _ur.error.message);
        }
        tickerIdx += batch.length;
        if (batchesFired % 5 === 0) {
          await supabase.from('batch_state').update({
            last_updated: new Date().toISOString()
          }).eq('trading_date', tradingDate);
        }
      }
      console.log(`[batch] ✓ ${ind.label} complete for ${TICKERS.length} tickers`);
      indIdx++;
      tickerIdx = 0;
      await supabase.from('batch_state').update({
        indicator_index: indIdx,
        ticker_index: 0,
        price_bars_done: priceBarsDone,
        last_updated: new Date().toISOString()
      }).eq('trading_date', tradingDate);
    }
    console.log(`[batch] ALL DONE tickers=${TICKERS.length} fetched=${totalFetched} failed=${totalFailed}`);
    await supabase.from('batch_state').update({
      status: 'complete',
      last_updated: new Date().toISOString()
    }).eq('trading_date', tradingDate);
    await supabase.from('batch_run').update({
      status: 'complete',
      completed_at: new Date().toISOString(),
      tickers_done: TICKERS.length,
      indicators_done: INDICATORS.length
    }).eq('id', myRunId);

    await logBatchEvent(supabase, tradingDate, 'complete',
      `All ${TICKERS.length} tickers and ${INDICATORS.length} indicators computed successfully.`,
      triggeredBy, { tickers: TICKERS.length, fetched: totalFetched, failed: totalFailed, run_id: myRunId });

    // ── TRIGGER IV-BATCH ─────────────────────────────────────────────────────
    // ta-batch is the master; iv-batch is the slave. Fire iv-batch now that
    // ta_cache is ready. Fire-and-forget — do not block this response.
    const ivUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/iv-batch`;
    const ivKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    fetch(ivUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${ivKey}`, 'Content-Type': 'application/json' },
      body: '{}'
    }).then(r => r.json())
      .then(d => console.log(`[batch] iv-batch triggered → status=${d?.status ?? '?'}`))
      .catch(e => console.warn('[batch] iv-batch trigger failed (non-fatal):', e));

    return json({
      status: 'complete',
      trading_date: tradingDate,
      tickers: TICKERS.length,
      fetched: totalFetched,
      failed: totalFailed,
      my_run_id: myRunId
    });
  } finally {
    // ALWAYS release the lock, even if work errored out partway.
    // Belt-and-suspenders: lock would auto-release on connection close anyway.
    await releaseBatchLock(supabase, lockResult.lockKey);
    console.log(
      `[lock] released lock_key=${lockResult.lockKey} my_run_id=${myRunId} ` +
      `elapsed_ms=${Date.now() - startMs}`
    );
  }
});
