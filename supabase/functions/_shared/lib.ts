/**
 * StockVizor — Edge Function Shared Library
 * ==========================================
 * Import from any Edge Function with:
 *   import { ... } from '../_shared/lib.ts';
 *
 * SAFE TO ADD: existing functions do NOT import this file.
 * New functions (fingerprint-builder, screener-runner, etc.) use it from day one.
 * Existing functions can migrate to it incrementally — one function at a time,
 * zero risk, because the exported API exactly matches the inline copies.
 *
 * Sections:
 *   A. Environment & constants
 *   B. Supabase client
 *   C. HTTP response helpers
 *   D. CORS
 *   E. Date & market-calendar utilities
 *   F. Throttle & concurrency helpers
 *   G. Polygon API client
 *   H. Technical analysis (RSI, SMA, EMA, ATR, MACD, stddev, percentile)
 *   I. Function-run logging
 *   J. General math utilities
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Re-export SupabaseClient so callers don't need a separate import ─────────
export type { SupabaseClient };

// ═══════════════════════════════════════════════════════════════════════════════
// A. ENVIRONMENT & CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

export const POLYGON_BASE  = 'https://api.polygon.io';
export const SUPABASE_URL  = 'https://hkamukkkkpqhdpcradau.supabase.co';
export const WORKER_BASE   = 'https://stockvizor.com';

/**
 * Read the Polygon API key from env.
 * Accepts both POLYGON_API_KEY (standard) and POLYGON_KEY (legacy alias).
 */
export function getPolygonKey(): string {
  return Deno.env.get('POLYGON_API_KEY') ?? Deno.env.get('POLYGON_KEY') ?? '';
}

/** Read the Supabase service-role key from env. */
export function getSupabaseKey(): string {
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

/** Read the internal Worker batch-auth token from env (optional). */
export function getWorkerToken(): string {
  return Deno.env.get('WORKER_BATCH_TOKEN') ?? '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// B. SUPABASE CLIENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a Supabase service-role client.
 * Disables auto-refresh and session persistence — correct for Edge Functions.
 * Throws if SUPABASE_SERVICE_ROLE_KEY is not set (fail-fast at boot).
 */
export function makeSupabase(): SupabaseClient {
  const key = getSupabaseKey();
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return createClient(SUPABASE_URL, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// C. HTTP RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Return a JSON response with CORS headers included.
 * Usage: return jres({ ok: true, count: 42 });
 */
export function jres(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/**
 * Return a JSON error response.
 * Usage: return jerr('Polygon key not set');
 *        return jerr('Not found', 404);
 */
export function jerr(msg: string, status = 500): Response {
  return jres({ ok: false, error: msg }, status);
}

// ═══════════════════════════════════════════════════════════════════════════════
// D. CORS
// ═══════════════════════════════════════════════════════════════════════════════

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

/**
 * Handle a CORS preflight OPTIONS request.
 * Returns a Response if the request is OPTIONS, null otherwise.
 *
 * Usage at the top of Deno.serve:
 *   const cors = handleCors(req);
 *   if (cors) return cors;
 */
export function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// E. DATE & MARKET CALENDAR UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Format a Date as YYYY-MM-DD. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Return YYYY-MM-DD for N calendar days before `from` (default: today). */
export function daysAgo(n: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

/** Return YYYY-MM-DD for N trading days before `from` (skips weekends + holidays). */
export function tradingDaysAgo(n: number, from: Date = new Date()): string {
  const d = new Date(from);
  let remaining = n;
  while (remaining > 0) {
    d.setDate(d.getDate() - 1);
    if (isTradingDay(isoDate(d))) remaining--;
  }
  return isoDate(d);
}

/**
 * US market holidays through 2027.
 * Source: NYSE holiday schedule.
 * Update this list annually.
 */
export const US_MARKET_HOLIDAYS = new Set([
  // 2025
  '2025-01-01','2025-01-20','2025-02-17','2025-04-18',
  '2025-05-26','2025-06-19','2025-07-04','2025-09-01',
  '2025-11-27','2025-12-25',
  // 2026
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03',
  '2026-05-25','2026-06-19','2026-07-03','2026-09-07',
  '2026-11-26','2026-12-25',
  // 2027
  '2027-01-01','2027-01-18','2027-02-15','2027-04-02',
  '2027-05-31','2027-06-19','2027-07-05','2027-09-06',
  '2027-11-25','2027-12-24',
]);

/** True if `dateStr` (YYYY-MM-DD) is a weekday and not a US market holiday. */
export function isTradingDay(dateStr: string): boolean {
  const dow = new Date(dateStr + 'T12:00:00').getDay(); // 0=Sun, 6=Sat
  return dow >= 1 && dow <= 5 && !US_MARKET_HOLIDAYS.has(dateStr);
}

/**
 * Return the most recent completed trading date in ET timezone.
 * "Completed" means market close bars are available (after 17:00 ET).
 * Walks backwards up to 14 calendar days to skip weekends + holidays.
 */
export function lastTradingDate(): string {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et    = new Date(etStr);
  const today = isoDate(et);
  const hhmm  = et.getHours() * 100 + et.getMinutes();
  // Today is available only after 17:00 ET (post-close bar settlement)
  if (isTradingDay(today) && hhmm >= 1700) return today;
  const d = new Date(et);
  for (let i = 0; i < 14; i++) {
    d.setDate(d.getDate() - 1);
    const ds = isoDate(d);
    if (isTradingDay(ds)) return ds;
  }
  return today; // fallback (should never reach here)
}

/**
 * Return YYYY-MM-DD for the most recent trading date at or before `dateStr`.
 * Useful when a caller has a date string and needs to snap it to a valid trading day.
 */
export function snapToTradingDay(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  for (let i = 0; i < 14; i++) {
    const ds = isoDate(d);
    if (isTradingDay(ds)) return ds;
    d.setDate(d.getDate() - 1);
  }
  return dateStr;
}

// ═══════════════════════════════════════════════════════════════════════════════
// F. THROTTLE & CONCURRENCY HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Async sleep. Usage: await sleep(70); */
export const sleep = (ms: number): Promise<void> =>
  new Promise(res => setTimeout(res, ms));

/**
 * Process `items` in parallel batches of `batchSize`.
 * Inserts `delayMs` pause between batches (for rate-limit courtesy).
 * Returns all PromiseSettledResult entries in order.
 *
 * Usage:
 *   const results = await runInBatches(tickers, 25, ticker => enrichTicker(ticker), 200);
 *   const failed  = results.filter(r => r.status === 'rejected');
 */
export async function runInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
  delayMs = 0,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(fn));
    results.push(...settled);
    if (delayMs > 0 && i + batchSize < items.length) await sleep(delayMs);
  }
  return results;
}

/**
 * Fire-and-forget HTTP POST to self-chain a function (next chunk).
 * Swallows errors — the caller continues regardless.
 *
 * Uses EdgeRuntime.waitUntil() when available (Supabase Edge Functions)
 * to ensure the fetch promise is kept alive after the handler returns
 * its Response, preventing premature Deno runtime termination.
 *
 * Usage:
 *   fireAndForget(FN_URL + `?offset=${nextOffset}&limit=${limit}`, supabaseKey);
 */
export function fireAndForget(url: string, authKey: string): void {
  const p = fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authKey}`,
      'Content-Type': 'application/json',
    },
  }).catch(() => {});

  // Keep the Supabase/Deno edge-function event loop alive until the
  // background fetch resolves, even after the handler has returned a Response.
  try {
    const er = (globalThis as Record<string, unknown>).EdgeRuntime as
      { waitUntil?: (p: Promise<unknown>) => void } | undefined;
    if (er?.waitUntil) er.waitUntil(p);
  } catch { /* not in an EdgeRuntime environment — ignore */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// G. POLYGON API CLIENT
// ═══════════════════════════════════════════════════════════════════════════════

/** A single OHLCV bar returned by Polygon. */
export interface OHLCVBar {
  t:   number;  // open time (unix ms)
  o:   number;  // open
  h:   number;  // high
  l:   number;  // low
  c:   number;  // close
  v:   number;  // volume (shares)
  vw?: number;  // VWAP (when available)
  n?:  number;  // trade count (when available)
}

/** Options for fetchPolygonBars. */
export interface PolyBarsOptions {
  multiplier?: number;
  timespan?:   'minute' | 'hour' | 'day' | 'week' | 'month';
  adjusted?:   boolean;
  limit?:      number;   // bars per page (max 50000)
  maxPages?:   number;   // pagination cap
  timeoutMs?:  number;   // per-request timeout
}

/**
 * Fetch OHLCV bars from Polygon /v2/aggs with auto-pagination.
 * Returns null if no bars found or on network error.
 *
 * Usage (daily bars, 1-year):
 *   const bars = await fetchPolygonBars('AAPL', '2024-01-01', '2024-12-31');
 *
 * Usage (4-hour bars, 30 days):
 *   const bars = await fetchPolygonBars('AAPL', fromDate, toDate,
 *                                       { multiplier: 4, timespan: 'hour' });
 */
export async function fetchPolygonBars(
  ticker:   string,
  fromDate: string,
  toDate:   string,
  opts: PolyBarsOptions = {},
): Promise<OHLCVBar[] | null> {
  const {
    multiplier = 1,
    timespan   = 'day',
    adjusted   = true,
    limit      = 5000,
    maxPages   = 5,
    timeoutMs  = 15_000,
  } = opts;

  const key = getPolygonKey();
  if (!key) return null;

  const base = `${POLYGON_BASE}/v2/aggs/ticker/${encodeURIComponent(ticker)}`
             + `/range/${multiplier}/${timespan}/${fromDate}/${toDate}`;
  let nextUrl: string | null =
    `${base}?adjusted=${adjusted}&sort=asc&limit=${limit}&apiKey=${key}`;

  const allRaw: unknown[] = [];
  let pages = 0;

  while (nextUrl && pages < maxPages) {
    let r: Response;
    try {
      r = await fetch(nextUrl, { signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      break; // timeout or network error — return what we have
    }
    if (!r.ok) break;
    const j: any = await r.json();
    if (Array.isArray(j?.results) && j.results.length > 0) {
      allRaw.push(...j.results);
    }
    nextUrl = j?.next_url ? `${j.next_url}&apiKey=${key}` : null;
    pages++;
    if (allRaw.length > 50_000) break; // safety cap
  }

  if (allRaw.length === 0) return null;

  return (allRaw as any[]).map(b => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v,
    ...(b.vw != null ? { vw: +b.vw } : {}),
    ...(b.n  != null ? { n:  +b.n  } : {}),
  }));
}

/**
 * Fetch a single Polygon indicator endpoint (RSI, MACD, SMA, EMA, etc.)
 * and return the raw JSON. Returns null on error.
 *
 * Usage:
 *   const d = await fetchPolygonIndicator(url);
 *   const val = d?.results?.values?.[0]?.value ?? null;
 */
export async function fetchPolygonIndicator(
  url: string,
  timeoutMs = 12_000,
): Promise<any | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// H. TECHNICAL ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════
//
// All functions operate on plain number[] or OHLCVBar[].
// NaN is used for positions where the indicator is not yet defined
// (i.e., before the warm-up period).
//
// These implementations match the algorithms already in production
// (detect-smart-rsi-daily, v.html drawSmartRSI, ta-batch) so results
// are consistent across the stack.

// ── RSI ──────────────────────────────────────────────────────────────────────

/**
 * Wilder's smoothed RSI.
 * Output array is same length as closes; first `period` values are NaN.
 *
 * Matches the implementation in detect-smart-rsi-daily/index.ts.
 */
export function computeRSI(closes: number[], period: number): number[] {
  const n   = closes.length;
  const out = new Array<number>(n).fill(NaN);
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
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

// ── SMA / EMA ────────────────────────────────────────────────────────────────

/** Simple Moving Average. Output[i] is NaN for i < period - 1. */
export function computeSMA(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential Moving Average (standard multiplier k = 2/(period+1)).
 * Seeded with a simple average of the first `period` values.
 */
export function computeEMA(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k   = 2 / (period + 1);
  let   ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema    = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

// ── MACD ─────────────────────────────────────────────────────────────────────

export interface MACDResult {
  macd:      number[];  // fast EMA - slow EMA
  signal:    number[];  // EMA of macd
  histogram: number[];  // macd - signal
}

/**
 * Standard MACD (12, 26, 9).
 * All three output arrays are same length as closes; NaN before warm-up.
 */
export function computeMACD(
  closes:        number[],
  fastPeriod  = 12,
  slowPeriod  = 26,
  signalPeriod = 9,
): MACDResult {
  const fast   = computeEMA(closes, fastPeriod);
  const slow   = computeEMA(closes, slowPeriod);
  const macd   = closes.map((_, i) =>
    isNaN(fast[i]) || isNaN(slow[i]) ? NaN : fast[i] - slow[i],
  );
  // Signal EMA is over the valid MACD values only
  const macdValid = macd.filter(v => !isNaN(v));
  const signalRaw = computeEMA(macdValid, signalPeriod);
  // Map signal back to full-length array
  const signal: number[] = new Array<number>(closes.length).fill(NaN);
  let vi = 0;
  for (let i = 0; i < macd.length; i++) {
    if (!isNaN(macd[i])) { signal[i] = signalRaw[vi++]; }
  }
  const histogram = closes.map((_, i) =>
    isNaN(macd[i]) || isNaN(signal[i]) ? NaN : macd[i] - signal[i],
  );
  return { macd, signal, histogram };
}

// ── ATR ──────────────────────────────────────────────────────────────────────

/**
 * Average True Range using Wilder's smoothing.
 * First value at index `period - 1`; NaN before that.
 */
export function computeATR(bars: OHLCVBar[], period = 14): number[] {
  const n   = bars.length;
  const out = new Array<number>(n).fill(NaN);
  if (n < period) return out;

  // True ranges
  const trs: number[] = [bars[0].h - bars[0].l];
  for (let i = 1; i < n; i++) {
    const pc = bars[i - 1].c;
    trs.push(Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - pc),
      Math.abs(bars[i].l - pc),
    ));
  }

  // Seed with simple average
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = atr;
  for (let i = period; i < n; i++) {
    atr    = (atr * (period - 1) + trs[i]) / period;
    out[i] = atr;
  }
  return out;
}

/**
 * Compute daily ATR percentiles for a set of bars.
 * Returns an object with p10/p25/p50/p75/p90 of (high - low) / close.
 * Useful for building expected daily-range models.
 */
export function dailyRangePercentiles(bars: OHLCVBar[]): {
  p10: number; p25: number; p50: number; p75: number; p90: number;
} {
  const pcts = bars.map(b => (b.h - b.l) / b.c).filter(v => isFinite(v));
  pcts.sort((a, b) => a - b);
  const p = (pct: number) => {
    const idx = Math.round((pct / 100) * (pcts.length - 1));
    return pcts[Math.max(0, Math.min(pcts.length - 1, idx))];
  };
  return { p10: p(10), p25: p(25), p50: p(50), p75: p(75), p90: p(90) };
}

// ── STATISTICS ───────────────────────────────────────────────────────────────

/** Arithmetic mean. Returns NaN for empty array. */
export function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Population standard deviation. Returns 0 for fewer than 2 values. */
export function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length);
}

/**
 * Percentile value (0–100) from an array.
 * Array does NOT need to be pre-sorted.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(
    0,
    Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1))),
  );
  return sorted[idx];
}

/**
 * Pearson correlation coefficient between two equal-length arrays.
 * Returns NaN if arrays are different lengths or stddev is 0.
 */
export function correlation(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return NaN;
  const mx = mean(xs), my = mean(ys);
  const sx = stddev(xs), sy = stddev(ys);
  if (sx === 0 || sy === 0) return NaN;
  const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.length;
  return cov / (sx * sy);
}

/**
 * Linear regression slope and intercept over an array.
 * Useful for trend strength and direction estimation.
 */
export function linearRegression(values: number[]): { slope: number; intercept: number; r2: number } {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0, r2: 0 };
  const xs = values.map((_, i) => i);
  const mx = mean(xs), my = mean(values);
  const ssxy = xs.reduce((s, x, i) => s + (x - mx) * (values[i] - my), 0);
  const ssxx = xs.reduce((s, x)    => s + (x - mx) ** 2, 0);
  const slope     = ssxx === 0 ? 0 : ssxy / ssxx;
  const intercept = my - slope * mx;
  const predicted = xs.map(x => slope * x + intercept);
  const ssTot     = values.reduce((s, v) => s + (v - my) ** 2, 0);
  const ssRes     = values.reduce((s, v, i) => s + (v - predicted[i]) ** 2, 0);
  const r2        = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}

// ── GENERAL MATH ─────────────────────────────────────────────────────────────

/** Clamp `v` between `lo` and `hi`. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Round to `dp` decimal places. */
export function round(v: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Return true if `v` is a finite, non-NaN number. */
export function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v) && !isNaN(v);
}

// ═══════════════════════════════════════════════════════════════════════════════
// H-EXT. ADDITIONAL INDICATORS (for vizardis-daily-observations)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Added 2026-05-21. All follow the same conventions as Section H:
//   • Output arrays are same length as input; NaN before warm-up
//   • OHLCVBar[] inputs use b.h, b.l, b.c, b.v fields
//   • No external dependencies — pure TypeScript arithmetic

// ── Stochastic Oscillator (%K and %D) ───────────────────────────────────────

/**
 * Stochastic Oscillator (14, 3, 3) — smoothed %K and %D.
 * %K(raw) = (close - lowestLow) / (highestHigh - lowestLow) * 100
 * %K(smooth) = SMA(rawK, smoothK)
 * %D = SMA(%K, dPeriod)
 */
export function computeStochastic(
  bars:     OHLCVBar[],
  kPeriod   = 14,
  smoothK   = 3,
  dPeriod   = 3,
): { k: number[]; d: number[] } {
  const n   = bars.length;
  const rawK = new Array<number>(n).fill(NaN);

  for (let i = kPeriod - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (bars[j].h > hi) hi = bars[j].h;
      if (bars[j].l < lo) lo = bars[j].l;
    }
    rawK[i] = hi === lo ? 50 : (bars[i].c - lo) / (hi - lo) * 100;
  }

  const k = computeSMA(rawK.map(v => isNaN(v) ? 0 : v), smoothK);
  // Restore NaN for warm-up positions
  for (let i = 0; i < kPeriod + smoothK - 2; i++) k[i] = NaN;

  const d = computeSMA(k.map(v => isNaN(v) ? 0 : v), dPeriod);
  for (let i = 0; i < kPeriod + smoothK + dPeriod - 3; i++) d[i] = NaN;

  return { k, d };
}

// ── Williams %R ──────────────────────────────────────────────────────────────

/**
 * Williams %R: -100 to 0 (0 = most overbought, -100 = most oversold).
 * %R = (highestHigh - close) / (highestHigh - lowestLow) * -100
 */
export function computeWilliamsR(bars: OHLCVBar[], period = 14): number[] {
  const n   = bars.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (bars[j].h > hi) hi = bars[j].h;
      if (bars[j].l < lo) lo = bars[j].l;
    }
    out[i] = hi === lo ? -50 : (hi - bars[i].c) / (hi - lo) * -100;
  }
  return out;
}

// ── CCI (Commodity Channel Index) ────────────────────────────────────────────

/**
 * CCI(period) = (TP - SMA(TP, period)) / (0.015 × MeanDeviation)
 * where TP = (high + low + close) / 3
 */
export function computeCCI(bars: OHLCVBar[], period = 20): number[] {
  const n  = bars.length;
  const tp = bars.map(b => (b.h + b.l + b.c) / 3);
  const out = new Array<number>(n).fill(NaN);

  for (let i = period - 1; i < n; i++) {
    const slice  = tp.slice(i - period + 1, i + 1);
    const avg    = slice.reduce((s, v) => s + v, 0) / period;
    const md     = slice.reduce((s, v) => s + Math.abs(v - avg), 0) / period;
    out[i] = md === 0 ? 0 : (tp[i] - avg) / (0.015 * md);
  }
  return out;
}

// ── ROC (Rate of Change) ─────────────────────────────────────────────────────

/** ROC(period) = (close[i] / close[i-period] - 1) * 100 */
export function computeROC(closes: number[], period = 10): number[] {
  return closes.map((c, i) =>
    i < period || closes[i - period] === 0
      ? NaN
      : (c / closes[i - period] - 1) * 100,
  );
}

// ── PPO (Percentage Price Oscillator) ────────────────────────────────────────

/**
 * PPO = (fastEMA - slowEMA) / slowEMA * 100
 * Like MACD but expressed as % → cross-ticker comparable.
 */
export function computePPO(
  closes:     number[],
  fastPeriod  = 12,
  slowPeriod  = 26,
): number[] {
  const fast = computeEMA(closes, fastPeriod);
  const slow = computeEMA(closes, slowPeriod);
  return closes.map((_, i) =>
    isNaN(fast[i]) || isNaN(slow[i]) || slow[i] === 0
      ? NaN
      : (fast[i] - slow[i]) / slow[i] * 100,
  );
}

// ── ADX / DI+ / DI- (Wilder's DMI) ──────────────────────────────────────────

export interface DMIResult {
  adx:     number[];
  diPlus:  number[];
  diMinus: number[];
}

/**
 * Directional Movement Index using Wilder's smoothing.
 * ADX > 25 = trending; DI+ > DI- = bullish direction.
 */
export function computeDMI(bars: OHLCVBar[], period = 14): DMIResult {
  const n      = bars.length;
  const adx    = new Array<number>(n).fill(NaN);
  const diP    = new Array<number>(n).fill(NaN);
  const diM    = new Array<number>(n).fill(NaN);
  if (n < period + 1) return { adx, diPlus: diP, diMinus: diM };

  // Raw directional movement and true range
  const dmPlus:  number[] = [0];
  const dmMinus: number[] = [0];
  const trArr:   number[] = [bars[0].h - bars[0].l];

  for (let i = 1; i < n; i++) {
    const upMove   = bars[i].h - bars[i - 1].h;
    const downMove = bars[i - 1].l - bars[i].l;
    dmPlus.push(upMove > downMove && upMove > 0 ? upMove : 0);
    dmMinus.push(downMove > upMove && downMove > 0 ? downMove : 0);
    const pc = bars[i - 1].c;
    trArr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - pc), Math.abs(bars[i].l - pc)));
  }

  // Wilder smoothed sums
  let sDMP = dmPlus.slice(0, period).reduce((s, v) => s + v, 0);
  let sDMM = dmMinus.slice(0, period).reduce((s, v) => s + v, 0);
  let sTR  = trArr.slice(0, period).reduce((s, v) => s + v, 0);

  const dxArr: number[] = [];

  for (let i = period; i < n; i++) {
    sDMP = sDMP - sDMP / period + dmPlus[i];
    sDMM = sDMM - sDMM / period + dmMinus[i];
    sTR  = sTR  - sTR  / period + trArr[i];

    const dip = sTR === 0 ? 0 : sDMP / sTR * 100;
    const dim = sTR === 0 ? 0 : sDMM / sTR * 100;
    diP[i]  = dip;
    diM[i]  = dim;
    const dx = (dip + dim) === 0 ? 0 : Math.abs(dip - dim) / (dip + dim) * 100;
    dxArr.push(dx);

    // ADX = Wilder SMA of DX (available after 2×period bars)
    if (dxArr.length === period) {
      adx[i] = dxArr.reduce((s, v) => s + v, 0) / period;
    } else if (dxArr.length > period) {
      adx[i] = (adx[i - 1] * (period - 1) + dx) / period;
    }
  }

  return { adx, diPlus: diP, diMinus: diM };
}

// ── Aroon ─────────────────────────────────────────────────────────────────────

export interface AroonResult { up: number[]; down: number[] }

/**
 * Aroon Up/Down.
 * AroonUp   = (period - bars since highest high over period) / period × 100
 * AroonDown = (period - bars since lowest low over period)   / period × 100
 */
export function computeAroon(bars: OHLCVBar[], period = 25): AroonResult {
  const n    = bars.length;
  const up   = new Array<number>(n).fill(NaN);
  const down = new Array<number>(n).fill(NaN);

  for (let i = period; i < n; i++) {
    let hiIdx = i, loIdx = i;
    for (let j = i - period; j <= i; j++) {
      if (bars[j].h >= bars[hiIdx].h) hiIdx = j;
      if (bars[j].l <= bars[loIdx].l) loIdx = j;
    }
    up[i]   = (period - (i - hiIdx)) / period * 100;
    down[i] = (period - (i - loIdx)) / period * 100;
  }
  return { up, down };
}

// ── Bollinger Bands ───────────────────────────────────────────────────────────

export interface BollingerResult {
  upper:  number[];
  middle: number[];
  lower:  number[];
  width:  number[];   // (upper - lower) / middle * 100
  pctB:   number[];   // (close - lower) / (upper - lower); 0=lower, 1=upper
}

export function computeBollingerBands(
  closes:  number[],
  period   = 20,
  mult     = 2,
): BollingerResult {
  const n      = closes.length;
  const upper  = new Array<number>(n).fill(NaN);
  const middle = new Array<number>(n).fill(NaN);
  const lower  = new Array<number>(n).fill(NaN);
  const width  = new Array<number>(n).fill(NaN);
  const pctB   = new Array<number>(n).fill(NaN);

  for (let i = period - 1; i < n; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const avg   = slice.reduce((s, v) => s + v, 0) / period;
    const sd    = Math.sqrt(slice.reduce((s, v) => s + (v - avg) ** 2, 0) / period);
    const u     = avg + mult * sd;
    const l     = avg - mult * sd;
    upper[i]    = u;
    middle[i]   = avg;
    lower[i]    = l;
    width[i]    = avg === 0 ? NaN : (u - l) / avg * 100;
    pctB[i]     = (u - l) === 0 ? 0.5 : (closes[i] - l) / (u - l);
  }
  return { upper, middle, lower, width, pctB };
}

// ── OBV (On-Balance Volume) ───────────────────────────────────────────────────

/** OBV: cumulative sum; adds volume on up-close, subtracts on down-close. */
export function computeOBV(bars: OHLCVBar[]): number[] {
  const out = new Array<number>(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const dir = bars[i].c > bars[i - 1].c ? 1 : bars[i].c < bars[i - 1].c ? -1 : 0;
    out[i] = out[i - 1] + dir * bars[i].v;
  }
  return out;
}

// ── CMF (Chaikin Money Flow) ──────────────────────────────────────────────────

/**
 * CMF = 20-period sum( ((C-L)-(H-C))/(H-L) × V ) / 20-period sum(V)
 * Range: -1 to +1.  Positive = net buying pressure.
 */
export function computeCMF(bars: OHLCVBar[], period = 20): number[] {
  const n   = bars.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let mfvSum = 0, volSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const hl = bars[j].h - bars[j].l;
      const mf = hl === 0 ? 0 : ((bars[j].c - bars[j].l) - (bars[j].h - bars[j].c)) / hl;
      mfvSum += mf * bars[j].v;
      volSum += bars[j].v;
    }
    out[i] = volSum === 0 ? 0 : mfvSum / volSum;
  }
  return out;
}

// ── MFI (Money Flow Index) ────────────────────────────────────────────────────

/**
 * MFI = 100 - 100 / (1 + positive_money_flow / negative_money_flow)
 * Typical price = (H + L + C) / 3; money flow = TP × volume.
 */
export function computeMFI(bars: OHLCVBar[], period = 14): number[] {
  const n   = bars.length;
  const out = new Array<number>(n).fill(NaN);
  const tp  = bars.map(b => (b.h + b.l + b.c) / 3);

  for (let i = period; i < n; i++) {
    let posFlow = 0, negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const flow = tp[j] * bars[j].v;
      if (tp[j] > tp[j - 1])      posFlow += flow;
      else if (tp[j] < tp[j - 1]) negFlow += flow;
    }
    out[i] = negFlow === 0 ? 100 : 100 - 100 / (1 + posFlow / negFlow);
  }
  return out;
}

// ── A/D Line (Accumulation/Distribution) ─────────────────────────────────────

/**
 * A/D Line: cumulative Money Flow Volume.
 * CLV = ((C - L) - (H - C)) / (H - L); MFV = CLV × volume.
 */
export function computeADLine(bars: OHLCVBar[]): number[] {
  const out = new Array<number>(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const hl  = bars[i].h - bars[i].l;
    const clv = hl === 0 ? 0 : ((bars[i].c - bars[i].l) - (bars[i].h - bars[i].c)) / hl;
    out[i] = out[i - 1] + clv * bars[i].v;
  }
  return out;
}

// ── Rolling VWAP ──────────────────────────────────────────────────────────────

/**
 * Rolling VWAP over `period` bars.
 * VWAP = Σ(TP × volume) / Σ(volume)  over the rolling window.
 * Uses typical price (H+L+C)/3 or the bar's vw field if available.
 */
export function computeRollingVWAP(bars: OHLCVBar[], period = 20): number[] {
  const n   = bars.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let tpvSum = 0, volSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tp = bars[j].vw ?? (bars[j].h + bars[j].l + bars[j].c) / 3;
      tpvSum += tp * bars[j].v;
      volSum += bars[j].v;
    }
    out[i] = volSum === 0 ? NaN : tpvSum / volSum;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// H2. INSTITUTIONAL FLOW / ACCUMULATION-DISTRIBUTION INDICATORS
// ═══════════════════════════════════════════════════════════════════════════════
//
// These derived parameters capture the "smart money" footprint —
// the technical traces that institutional accumulation and distribution
// leave in price/volume data.  All functions take OHLCVBar arrays.

/**
 * SMA200 slope: % change of the 200-period SMA over the last `slopePeriod` bars.
 * Returns NaN for bars that don't have enough history.
 * Positive = rising 200-SMA (bullish structure), negative = falling.
 */
export function computeSMA200Slope(
  closes: number[],
  smaPeriod = 200,
  slopePeriod = 20,
): number[] {
  const sma  = computeSMA(closes, smaPeriod);
  const n    = closes.length;
  const out  = new Array<number>(n).fill(NaN);
  for (let i = smaPeriod + slopePeriod - 1; i < n; i++) {
    const prev = sma[i - slopePeriod];
    if (isNaN(prev) || prev === 0) continue;
    out[i] = (sma[i] - prev) / prev * 100;
  }
  return out;
}

/**
 * OBV divergence over `period` bars.
 * = OBV % change  −  price % change
 * Positive (OBV rising faster than price) → accumulation signal.
 * Negative (OBV falling while price holds) → distribution signal.
 */
export function computeOBVDivergence(bars: OHLCVBar[], period = 20): number[] {
  const obv  = computeOBV(bars);
  const n    = bars.length;
  const out  = new Array<number>(n).fill(NaN);
  for (let i = period; i < n; i++) {
    const obvBase   = obv[i - period];
    const priceBase = bars[i - period].c;
    if (obvBase === 0 || priceBase === 0) continue;
    const obvChg   = (obv[i] - obvBase) / Math.abs(obvBase) * 100;
    const priceChg = (bars[i].c - priceBase) / priceBase * 100;
    out[i] = obvChg - priceChg;
  }
  return out;
}

/**
 * A/D Line divergence over `period` bars.
 * Same concept as OBV divergence but uses the Accumulation/Distribution Line.
 */
export function computeADDivergence(bars: OHLCVBar[], period = 20): number[] {
  const adLine = computeADLine(bars);
  const n      = bars.length;
  const out    = new Array<number>(n).fill(NaN);
  for (let i = period; i < n; i++) {
    const adBase    = adLine[i - period];
    const priceBase = bars[i - period].c;
    if (adBase === 0 || priceBase === 0) continue;
    const adChg    = (adLine[i] - adBase) / Math.abs(adBase) * 100;
    const priceChg = (bars[i].c - priceBase) / priceBase * 100;
    out[i] = adChg - priceChg;
  }
  return out;
}

/**
 * Volume asymmetry over `period` bars.
 * = avg volume on up-close days  /  avg volume on down-close days.
 * > 1.1 → buying pressure (accumulation);  < 0.9 → selling pressure (distribution).
 * Returns 1.0 (neutral) when either group has no bars.
 */
export function computeVolumeAsymmetry(bars: OHLCVBar[], period = 20): number[] {
  const n   = bars.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = period; i < n; i++) {
    let upVol = 0, upCount = 0, dnVol = 0, dnCount = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (bars[j].c > bars[j - 1].c)      { upVol += bars[j].v; upCount++; }
      else if (bars[j].c < bars[j - 1].c) { dnVol += bars[j].v; dnCount++; }
    }
    const upAvg = upCount > 0 ? upVol / upCount : 0;
    const dnAvg = dnCount > 0 ? dnVol / dnCount : 0;
    out[i] = dnAvg === 0 ? 1 : upAvg / dnAvg;
  }
  return out;
}

/**
 * CMF trend direction: compares shorter-period CMF to longer-period CMF.
 * Returns  1 (rising / bullish flow trend),
 *         -1 (falling / bearish flow trend),
 *          0 (flat — within ±0.02 tolerance).
 */
export function computeCMFTrendDir(
  bars:        OHLCVBar[],
  shortPeriod = 10,
  longPeriod  = 20,
  tolerance   = 0.02,
): number[] {
  const cmfShort = computeCMF(bars, shortPeriod);
  const cmfLong  = computeCMF(bars, longPeriod);
  const n        = bars.length;
  const out      = new Array<number>(n).fill(0);
  for (let i = longPeriod - 1; i < n; i++) {
    const diff = cmfShort[i] - cmfLong[i];
    out[i] = diff > tolerance ? 1 : diff < -tolerance ? -1 : 0;
  }
  return out;
}

/**
 * Smart Money Score: composite accumulation/distribution index, −100 to +100.
 *
 * Weights:
 *   OBV divergence (normalised)  35 %
 *   CMF (scaled ×40)             25 %
 *   Volume asymmetry deviation   25 %
 *   A/D divergence (normalised)  15 %
 *
 * Positive = net accumulation;  Negative = net distribution.
 */
export function computeSmartMoneyScore(bars: OHLCVBar[], period = 20): number[] {
  const obvDiv  = computeOBVDivergence(bars, period);
  const cmfArr  = computeCMF(bars, period);
  const volAsym = computeVolumeAsymmetry(bars, period);
  const adDiv   = computeADDivergence(bars, period);
  const n       = bars.length;
  const out     = new Array<number>(n).fill(NaN);

  for (let i = period; i < n; i++) {
    if (isNaN(obvDiv[i]) || isNaN(cmfArr[i]) || isNaN(volAsym[i]) || isNaN(adDiv[i])) continue;

    // Clamp each component to ±1 before weighting
    const cObv  = Math.max(-1, Math.min(1, obvDiv[i]  / 20));  // ±20% → ±1
    const cCmf  = Math.max(-1, Math.min(1, cmfArr[i]  * 2));   // CMF ±0.5 → ±1
    const cVol  = Math.max(-1, Math.min(1, (volAsym[i] - 1) / 0.3)); // ±0.3 → ±1
    const cAd   = Math.max(-1, Math.min(1, adDiv[i]   / 20));

    out[i] = Math.round((cObv * 35 + cCmf * 25 + cVol * 25 + cAd * 15));
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// J. VIZARDIS ENGINE  — shared types, grading, evaluation, heuristic stats
// ═══════════════════════════════════════════════════════════════════════════════
//
// ALL Vizardis Edge Functions import from here.  No business logic lives inside
// individual Edge Function files — they are thin orchestrators that call these
// pure functions.
//
// Sections:
//   J1. Shared domain types
//   J2. Date helpers (Vizardis-specific)
//   J3. Math helpers
//   J4. Outcome grading (4-tier)
//   J5. Hypothesis trigger evaluation
//   J6. Heuristic statistics
//   J7. Context key resolver
//   J8. Confidence tier & score

// ── J1. Shared domain types ───────────────────────────────────────────────────

/** Minimal observation row used by evaluators and graders. */
export interface VizObsRow {
  ticker:           string;
  obs_date:         string;
  close:            number | null;
  sma_20:           number | null;
  sma_50:           number | null;
  sma_200:          number | null;
  rsi_14:           number | null;
  rsi_2:            number | null;
  macd_histogram:   number | null;
  volume_ratio:     number | null;
  pos_52w_pct:      number | null;
  roc_20:           number | null;
  roc_126:          number | null;
  day_return_pct:   number | null;
  vix_close:        number | null;
  spy_close:        number | null;
  [key: string]:    unknown;
}

/** State context row from vizardis_state_contexts. */
export interface VizContextRow {
  ticker:          string;
  obs_date:        string;
  ctx_stock:       string;
  ctx_index_stock: string;
  ctx_fund_stock:  string;
  ctx_index_fund:  string;
  ctx_all:         string;
}

/** Result of the 4-tier outcome grading. */
export interface VizGradeResult {
  return_pct:      number;
  spy_return_pct:  number | null;
  return_vs_spy:   number | null;
  sharpe:          number | null;
  tier1_pass:      boolean;
  tier2_pass:      boolean;
  tier3_pass:      boolean;
  tier4_pass:      boolean;
  grade:           'correct' | 'borderline' | 'incorrect';
}

/** A graded instance row (from vizardis_backtest_results or vizardis_predictions). */
export interface VizGradedInstance {
  signal_date:     string;
  grade:           string;
  tier1_pass:      boolean;
  tier2_pass:      boolean;
  tier3_pass:      boolean;
  tier4_pass:      boolean;
  return_pct:      number | null;
  return_vs_spy:   number | null;
  sharpe:          number | null;
  data_source?:    string;
}

/** Aggregated heuristic statistics computed from a set of graded instances. */
export interface VizHeuristicStats {
  sample_count:    number;
  win_rate:        number;
  accuracy_t1:     number;
  accuracy_t2:     number;
  accuracy_t3:     number;
  accuracy_t4:     number;
  avg_return:      number | null;
  avg_vs_spy:      number | null;
  avg_sharpe:      number | null;
  win_rate_30d:    number | null;
  win_rate_90d:    number | null;
  win_rate_252d:   number | null;
  sample_30d:      number;
  sample_90d:      number;
  sample_252d:     number;
  confidence_score: number;
  confidence_tier: string;
  is_reliable:     boolean;
  first_signal_date: string | null;
  last_signal_date:  string | null;
  // ── Profitability decomposition ───────────────────────────────────────────
  win_count:      number;
  loss_count:     number;
  avg_win:        number | null;   // mean return on winning signals (positive)
  avg_loss:       number | null;   // mean return on losing signals  (negative)
  profit_factor:  number | null;   // sum(wins) / |sum(losses)|  — >1 = net profitable
  expected_value: number | null;   // win_rate × avg_win + loss_rate × avg_loss
  payoff_ratio:   number | null;   // avg_win / |avg_loss|        — >1 = win more than lose
}

// ── J2. Date helpers (Vizardis-specific) ─────────────────────────────────────

/**
 * Return YYYY-MM-DD exactly `n` trading days AHEAD of `fromDate` (string).
 * Analogous to the existing `tradingDaysAgo` but going forward.
 */
export function vizTradingDaysAhead(n: number, fromDate: string): string {
  const d = new Date(fromDate + 'T12:00:00Z');
  let remaining = n;
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    if (isTradingDay(isoDate(d))) remaining--;
  }
  return isoDate(d);
}

/**
 * Return YYYY-MM-DD exactly `n` trading days BEFORE `fromDate` (string).
 * String-argument variant of the existing `tradingDaysAgo(n, Date)`.
 */
export function vizTradingDaysBack(n: number, fromDate: string): string {
  const d = new Date(fromDate + 'T12:00:00Z');
  let remaining = n;
  while (remaining > 0) {
    d.setDate(d.getDate() - 1);
    if (isTradingDay(isoDate(d))) remaining--;
  }
  return isoDate(d);
}

/** Return a date string `n` calendar days before `fromDate`. */
export function vizCalendarDaysBack(n: number, fromDate: string): string {
  const d = new Date(fromDate + 'T12:00:00Z');
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

// ── J3. Math helpers ──────────────────────────────────────────────────────────

/** Mean of a numeric array; returns null for empty arrays. */
export function vizMean(arr: (number | null | undefined)[]): number | null {
  const valid = arr.filter(v => isFiniteNum(v)) as number[];
  if (valid.length === 0) return null;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}

/**
 * Annualised Sharpe approximation for a holding period.
 * totalReturn — % gain/loss over the period.
 * dailyRets   — daily % returns during the holding window.
 */
export function vizSharpe(totalReturn: number, dailyRets: number[]): number | null {
  if (dailyRets.length < 2) return null;
  const mu = dailyRets.reduce((s, r) => s + r, 0) / dailyRets.length;
  const sd = Math.sqrt(dailyRets.reduce((s, r) => s + (r - mu) ** 2, 0) / dailyRets.length);
  if (sd === 0) return null;
  return totalReturn / (sd * Math.sqrt(dailyRets.length));
}

// ── J4. Outcome grading (4-tier) ──────────────────────────────────────────────

const GRADE_TIER2_THRESHOLD = 1.5;   // % — meaningful move threshold
const GRADE_SHARPE_FLOOR    = 0.5;

/**
 * Grade a single prediction outcome using the 4-tier system.
 *
 * @param entryPx   Price at signal date
 * @param exitPx    Price at horizon date
 * @param spyEntry  SPY close at signal date (null = skip tier3)
 * @param spyExit   SPY close at horizon date
 * @param dailyRets Array of daily % returns during the holding window (for Sharpe)
 * @param direction 'bullish' | 'bearish' — bearish predictions invert the return
 */
export function vizGradeOutcome(
  entryPx:   number,
  exitPx:    number,
  spyEntry:  number | null,
  spyExit:   number | null,
  dailyRets: number[],
  direction: 'bullish' | 'bearish' = 'bullish',
): VizGradeResult {
  const rawReturn   = (exitPx / entryPx - 1) * 100;
  // For bearish signals success = price going DOWN
  const effReturn   = direction === 'bearish' ? -rawReturn : rawReturn;

  const spyReturnPct = (isFiniteNum(spyEntry) && isFiniteNum(spyExit) && spyEntry! > 0)
    ? (spyExit! / spyEntry! - 1) * 100 : null;
  const vsspy = spyReturnPct !== null ? rawReturn - spyReturnPct : null;
  const sharpe = vizSharpe(effReturn, dailyRets);

  const tier1 = effReturn > 0;
  const tier2 = Math.abs(effReturn) > GRADE_TIER2_THRESHOLD;
  const tier3 = vsspy !== null ? (direction === 'bearish' ? vsspy < 0 : vsspy > 0) : false;
  const tier4 = sharpe !== null ? sharpe > GRADE_SHARPE_FLOOR : false;

  const grade: 'correct' | 'borderline' | 'incorrect' =
    tier1 && tier2 ? 'correct' : tier1 ? 'borderline' : 'incorrect';

  return {
    return_pct:     round(rawReturn, 4),
    spy_return_pct: spyReturnPct !== null ? round(spyReturnPct, 4) : null,
    return_vs_spy:  vsspy        !== null ? round(vsspy, 4)        : null,
    sharpe:         sharpe       !== null ? round(sharpe, 4)       : null,
    tier1_pass:  tier1,
    tier2_pass:  tier2,
    tier3_pass:  tier3,
    tier4_pass:  tier4,
    grade,
  };
}

// ── J5. Hypothesis trigger evaluation ─────────────────────────────────────────
//
// Single source of truth for all hypothesis trigger conditions.
// Used by: vizardis-signal-recorder, vizardis-backtest-runner.
// When a new hypothesis is added, update THIS function only.

function _vn(v: unknown): number | null {
  return isFiniteNum(v) ? (v as number) : null;
}

/**
 * Evaluate whether a named hypothesis fires for a given set of observations.
 *
 * @param id     Hypothesis ID (e.g. 'rsi_oversold')
 * @param params Hypothesis parameters JSONB from vizardis_hypotheses
 * @param today  Today's VizObsRow
 * @param prev1  Yesterday's row (or null)
 * @param prev2  2 days ago (or null)
 * @param prev3  3 days ago (or null)
 * @returns true if the trigger fires
 */
export function vizEvaluateTrigger(
  id:    string,
  params: Record<string, number>,
  today:  VizObsRow,
  prev1:  VizObsRow | null,
  prev2:  VizObsRow | null,
  prev3:  VizObsRow | null,
): boolean {
  switch (id) {

    case 'rsi_oversold':
      return _vn(today.rsi_14) !== null && today.rsi_14! < params.threshold;

    case 'rsi2_oversold':
      return _vn(today.rsi_2) !== null && today.rsi_2! < params.threshold;

    case 'rsi_cross_above_50':
      return prev1 !== null
        && _vn(prev1.rsi_14) !== null && _vn(today.rsi_14) !== null
        && prev1.rsi_14! <= params.midline && today.rsi_14! > params.midline;

    case 'price_reclaim_sma50':
      return prev1 !== null
        && _vn(prev1.close) !== null && _vn(prev1.sma_50)  !== null
        && _vn(today.close) !== null && _vn(today.sma_50)  !== null
        && prev1.close! <= prev1.sma_50! && today.close! > today.sma_50!;

    case 'price_reclaim_sma200':
      return prev1 !== null
        && _vn(prev1.close) !== null && _vn(prev1.sma_200) !== null
        && _vn(today.close) !== null && _vn(today.sma_200) !== null
        && prev1.close! <= prev1.sma_200! && today.close! > today.sma_200!;

    case 'macd_bullish_cross':
      return prev1 !== null
        && _vn(prev1.macd_histogram) !== null && _vn(today.macd_histogram) !== null
        && prev1.macd_histogram! <= 0 && today.macd_histogram! > 0;

    case 'macd_rsi_combined': {
      if (_vn(today.macd_histogram) === null || _vn(today.rsi_14) === null) return false;
      if (today.macd_histogram! <= 0 || today.rsi_14! <= params.rsi_midline) return false;
      const lookback = Math.round(params.cross_lookback ?? 3);
      const recent = [prev1, prev2, prev3].slice(0, lookback);
      return recent.some(p => p !== null && _vn(p!.macd_histogram) !== null && p!.macd_histogram! <= 0);
    }

    case 'momentum_6m_cross':
      return prev1 !== null
        && _vn(prev1.roc_126) !== null && _vn(today.roc_126) !== null
        && prev1.roc_126! <= 0 && today.roc_126! > 0;

    case 'fiftytwo_week_proximity':
      return _vn(today.pos_52w_pct) !== null
        && today.pos_52w_pct! >= (1 - params.proximity_pct) * 100;

    case 'vol_breakout_up':
      return _vn(today.day_return_pct) !== null && _vn(today.volume_ratio) !== null
        && today.day_return_pct! > params.return_threshold_pct * 100
        && today.volume_ratio!   > params.vol_ratio;

    case 'vol_breakout_down':
      return _vn(today.day_return_pct) !== null && _vn(today.volume_ratio) !== null
        && today.day_return_pct! < -(params.return_threshold_pct * 100)
        && today.volume_ratio!   > params.vol_ratio;

    case 'compute_signal_buy': {
      let bull = 0;
      if (_vn(today.rsi_14)        !== null && today.rsi_14!        > 50)             bull++;
      if (_vn(today.close)         !== null && _vn(today.sma_50)    !== null
          && today.close! > today.sma_50!)                                             bull++;
      if (_vn(today.close)         !== null && _vn(today.sma_200)   !== null
          && today.close! > today.sma_200!)                                            bull++;
      if (_vn(today.macd_histogram) !== null && today.macd_histogram! > 0)            bull++;
      if (prev1 !== null && _vn(today.close) !== null && _vn(prev1.close) !== null
          && today.close! > prev1.close!)                                              bull++;
      return bull >= 3;
    }

    case 'cs_or_rsi_oversold':
      return vizEvaluateTrigger('rsi_oversold',      { threshold: 35 }, today, prev1, prev2, prev3)
          || vizEvaluateTrigger('compute_signal_buy', params,            today, prev1, prev2, prev3);

    case 'cs_or_rsi2_oversold':
      return vizEvaluateTrigger('rsi2_oversold',     { threshold: 10 }, today, prev1, prev2, prev3)
          || vizEvaluateTrigger('compute_signal_buy', params,            today, prev1, prev2, prev3);

    case 'cs_or_both_rsi':
      return vizEvaluateTrigger('rsi_oversold',      { threshold: 35 }, today, prev1, prev2, prev3)
          || vizEvaluateTrigger('rsi2_oversold',      { threshold: 10 }, today, prev1, prev2, prev3)
          || vizEvaluateTrigger('compute_signal_buy', params,            today, prev1, prev2, prev3);

    case 'rsi_oversold_and_rsi2':
      return vizEvaluateTrigger('rsi_oversold',  { threshold: 35 }, today, prev1, prev2, prev3)
          && vizEvaluateTrigger('rsi2_oversold', { threshold: 10 }, today, prev1, prev2, prev3);

    default:
      return false;
  }
}

// ── J6. Heuristic statistics ──────────────────────────────────────────────────

const HEUR_MIN_RELIABLE   = 100;
const HEUR_DRIFT_30D      = 0.12;   // 12pp drop in 30d vs 252d = diverging

/**
 * Compute aggregate heuristic statistics from an array of graded instances.
 * `asOfDate` — used as the reference point for rolling windows.
 */
export function vizComputeHeuristicStats(
  results:   VizGradedInstance[],
  asOfDate:  string,
  liveCount: number,
): VizHeuristicStats {
  const total   = results.length;
  const correct = results.filter(r => r.grade === 'correct').length;

  const winRate  = total > 0 ? correct / total : 0;
  const t1Rate   = total > 0 ? results.filter(r => r.tier1_pass).length / total : 0;
  const t2Rate   = total > 0 ? results.filter(r => r.tier2_pass).length / total : 0;
  const t3Rate   = total > 0 ? results.filter(r => r.tier3_pass).length / total : 0;
  const t4Rate   = total > 0 ? results.filter(r => r.tier4_pass).length / total : 0;

  const avgReturn  = vizMean(results.map(r => r.return_pct));
  const avgVsSpy   = vizMean(results.filter(r => r.return_vs_spy !== null).map(r => r.return_vs_spy));
  const avgSharpe  = vizMean(results.filter(r => r.sharpe  !== null).map(r => r.sharpe));

  // Rolling windows
  const d30  = vizCalendarDaysBack(30,  asOfDate);
  const d90  = vizCalendarDaysBack(90,  asOfDate);
  const d252 = vizCalendarDaysBack(252, asOfDate);

  const r30  = results.filter(r => r.signal_date >= d30);
  const r90  = results.filter(r => r.signal_date >= d90);
  const r252 = results.filter(r => r.signal_date >= d252);

  const wr30  = r30.length  > 0 ? r30.filter(r  => r.grade === 'correct').length / r30.length  : null;
  const wr90  = r90.length  > 0 ? r90.filter(r  => r.grade === 'correct').length / r90.length  : null;
  const wr252 = r252.length > 0 ? r252.filter(r => r.grade === 'correct').length / r252.length : null;

  const confTier  = vizConfidenceTier(total, liveCount, wr30, wr252);
  const confScore = vizConfidenceScore(total, liveCount, winRate, t2Rate);
  const reliable  = total >= HEUR_MIN_RELIABLE && confTier !== 'diverging';

  const dates = results.map(r => r.signal_date).sort();

  // ── Profitability decomposition ──────────────────────────────────────────────
  // Wins = signals where direction was correct (tier1_pass = true).
  // For bearish signals, tier1_pass already accounts for direction inversion
  // (see vizGradeOutcome: effReturn > 0 → tier1_pass).
  // return_pct is always the RAW (non-directional) return stored in the DB;
  // for profitability we need the effective (direction-adjusted) return.
  // We approximate it as: if tier1_pass → the signal worked → |return_pct| is a gain.
  // If !tier1_pass → the signal failed → |return_pct| is a loss.
  const wins   = results.filter(r => r.tier1_pass);
  const losses = results.filter(r => !r.tier1_pass);
  const winCount  = wins.length;
  const lossCount = losses.length;

  const totalGain = wins.reduce((s, r)   => s + Math.abs(r.return_pct ?? 0), 0);
  const totalLoss = losses.reduce((s, r) => s + Math.abs(r.return_pct ?? 0), 0);

  const avgWin  = winCount  > 0 ? totalGain / winCount  : null;     // positive
  const avgLoss = lossCount > 0 ? -(totalLoss / lossCount) : null;  // negative

  // profit_factor = sum(winning returns) / sum(|losing returns|); >1 = net profitable
  const profitFactor = totalLoss > 0 ? totalGain / totalLoss : null;

  // expected_value = win_rate × avg_win + loss_rate × avg_loss
  const ev = (avgWin !== null && avgLoss !== null)
    ? winRate * avgWin + (1 - winRate) * avgLoss
    : null;

  // payoff_ratio = avg_win / |avg_loss|; >1 = wins are larger than losses
  const payoffRatio = (avgWin !== null && avgLoss !== null && avgLoss !== 0)
    ? avgWin / Math.abs(avgLoss)
    : null;

  return {
    sample_count:      total,
    win_rate:          round(winRate, 4),
    accuracy_t1:       round(t1Rate, 4),
    accuracy_t2:       round(t2Rate, 4),
    accuracy_t3:       round(t3Rate, 4),
    accuracy_t4:       round(t4Rate, 4),
    avg_return:        avgReturn !== null ? round(avgReturn, 4) : null,
    avg_vs_spy:        avgVsSpy  !== null ? round(avgVsSpy, 4)  : null,
    avg_sharpe:        avgSharpe !== null ? round(avgSharpe, 4) : null,
    win_rate_30d:      wr30  !== null ? round(wr30, 4)  : null,
    win_rate_90d:      wr90  !== null ? round(wr90, 4)  : null,
    win_rate_252d:     wr252 !== null ? round(wr252, 4) : null,
    sample_30d:        r30.length,
    sample_90d:        r90.length,
    sample_252d:       r252.length,
    confidence_score:  round(confScore, 2),
    confidence_tier:   confTier,
    is_reliable:       reliable,
    first_signal_date: dates.length > 0 ? dates[0]              : null,
    last_signal_date:  dates.length > 0 ? dates[dates.length-1] : null,
    // ── Profitability decomposition ─────────────────────────────────────────
    win_count:      winCount,
    loss_count:     lossCount,
    avg_win:        avgWin        !== null ? round(avgWin, 4)        : null,
    avg_loss:       avgLoss       !== null ? round(avgLoss, 4)       : null,
    profit_factor:  profitFactor  !== null ? round(profitFactor, 4)  : null,
    expected_value: ev            !== null ? round(ev, 4)            : null,
    payoff_ratio:   payoffRatio   !== null ? round(payoffRatio, 4)   : null,
  };
}

// ── J7. Context key resolver ──────────────────────────────────────────────────

/**
 * Extract the appropriate context key for a given asset_level from a context row.
 * Used by signal-recorder, backtest-runner, and heuristic-builder.
 */
export function vizGetContextKey(
  ctx:   Pick<VizContextRow, 'ctx_stock' | 'ctx_index_stock' | 'ctx_fund_stock' | 'ctx_index_fund' | 'ctx_all'> | null | undefined,
  level: string,
): string | null {
  if (!ctx) return null;
  switch (level) {
    case 'stock':       return ctx.ctx_stock;
    case 'index_stock': return ctx.ctx_index_stock;
    case 'fund_stock':  return ctx.ctx_fund_stock;
    case 'index_fund':  return ctx.ctx_index_fund;
    case 'all':         return ctx.ctx_all;
    case 'index':
    case 'fund':        return ctx.ctx_stock;   // these entities use their own state
    default:            return ctx.ctx_all;
  }
}

// ── J8. Confidence tier & score ───────────────────────────────────────────────

/**
 * Derive the confidence tier label from sample counts and rolling win rates.
 * Mirrors the SQL function `vizardis_confidence_tier()` in the migration.
 */
export function vizConfidenceTier(
  sampleCount: number,
  liveCount:   number,
  wr30d:       number | null,
  wr252d:      number | null,
): string {
  // Diverging: 30d accuracy drops ≥ 12pp below 252d baseline
  if (wr30d !== null && wr252d !== null && wr252d - wr30d >= HEUR_DRIFT_30D) return 'diverging';
  if (sampleCount <  10) return 'unproven';
  if (sampleCount <  30) return 'emerging';
  if (sampleCount < 100) return 'established';
  return 'reliable';
}

/**
 * Compute a 0–100 confidence score.
 * Mirrors the SQL function `vizardis_confidence_score()` in the migration.
 */
export function vizConfidenceScore(
  sampleCount: number,
  liveCount:   number,
  winRate:     number,
  t2Rate:      number,
): number {
  const sampleScore  = Math.min(sampleCount / 200, 1) * 50;
  const liveBonus    = Math.min(liveCount   / 50,  1) * 20;
  const qualityScore = (winRate ?? 0) * (t2Rate ?? 0) * 30;
  return sampleScore + liveBonus + qualityScore;
}

// ── Bias bands (used by signal-recorder) ─────────────────────────────────────

const VIZ_BIAS_BANDS: readonly { min: number; bias: string }[] = [
  { min: 72, bias: 'strong_bullish'  },
  { min: 58, bias: 'bullish'         },
  { min: 52, bias: 'tilt_bullish'    },
  { min: 48, bias: 'neutral'         },
  { min: 42, bias: 'tilt_bearish'    },
  { min: 28, bias: 'bearish'         },
  { min:  0, bias: 'strong_bearish'  },
];

/** Convert a Vizardis composite score (0–100) to a bias label. */
export function vizScoreToBias(score: number): string {
  for (const { min, bias } of VIZ_BIAS_BANDS) {
    if (score >= min) return bias;
  }
  return 'neutral';
}

// ═══════════════════════════════════════════════════════════════════════════════
// I. FUNCTION-RUN LOGGING
// ═══════════════════════════════════════════════════════════════════════════════
//
// Writes a summary row to the `function_runs` table after each Edge Function
// completes. Silently no-ops if the table doesn't exist yet (safe to deploy
// before running the migration).
//
// SQL to create the table (run once in Supabase SQL editor):
//
//   CREATE TABLE IF NOT EXISTS public.function_runs (
//     id             bigserial PRIMARY KEY,
//     fn_name        text        NOT NULL,
//     started_at     timestamptz NOT NULL,
//     completed_at   timestamptz NOT NULL,
//     duration_ms    integer     GENERATED ALWAYS AS
//                    (EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::integer STORED,
//     ticker_count   integer,
//     success_count  integer,
//     error_count    integer,
//     tickers_failed text[],
//     meta           jsonb
//   );
//   CREATE INDEX ON public.function_runs (fn_name, started_at DESC);

export interface FnRunLog {
  fn_name:        string;
  started_at:     string;   // ISO timestamp
  completed_at:   string;   // ISO timestamp
  ticker_count?:  number;
  success_count?: number;
  error_count?:   number;
  tickers_failed?: string[];
  meta?:          Record<string, unknown>;
}

/**
 * Append a run-log row to `function_runs`.
 * Call at the end of every Edge Function for observability.
 * Silently ignores errors (table may not exist yet).
 *
 * Usage:
 *   const t0 = new Date().toISOString();
 *   // ... do work ...
 *   await logFnRun(supabase, {
 *     fn_name: 'ta-batch',
 *     started_at: t0,
 *     completed_at: new Date().toISOString(),
 *     ticker_count: tickers.length,
 *     success_count: succeeded,
 *     error_count: failed,
 *     tickers_failed: failedList,
 *   });
 */
export async function logFnRun(
  supabase: SupabaseClient,
  log: FnRunLog,
): Promise<void> {
  try {
    await supabase.from('function_runs').insert(log);
  } catch {
    // silent — table may not exist yet, never break the caller
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// K. EXTENDED TECHNICAL ANALYSIS — VIZARDIS INDICATOR SUITE
// ═══════════════════════════════════════════════════════════════════════════════
//
// All 71 standard TA indicators across sections 1-7.
// No StockVizor-proprietary logic — only universally recognised algorithms.
// All functions operate on plain number[] arrays; NaN for warmup positions.
//
// Sections:
//   K1.  Double / Triple / Hull / KAMA / TRIX MAs
//   K2.  Momentum oscillators (StochRSI, CMO, TSI, KST, Coppock, AO, DPO, STC)
//   K3.  Volume oscillators (VPT, NVI, Chaikin Osc, Force Index)
//   K4.  Volatility (Keltner from ATR, Ulcer Index, PPO+signal)
//   K5.  Trend composites (Alligator, Guppy GMMA)
//   K6.  Statistical (Z-Score, LR Slope, Hurst Exponent)
//   K7.  VizIndicatorCache — per-ticker precomputed indicator store
//   K8.  vizBuildIndicatorCache — builds K7 from a VizObsRow[]
//   K9.  vizEvaluateTriggerV2 — all 71 hypotheses, cache-based

// ── K1. Moving Average variants ───────────────────────────────────────────────

/** Weighted Moving Average. */
export function computeWMA(values: number[], period: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += values[i - j] * (period - j);
    out[i] = sum / denom;
  }
  return out;
}

/**
 * Double EMA: DEMA(n) = 2×EMA(n) - EMA(EMA(n)).
 * Reduces lag vs plain EMA. Warmup ≈ 2×period.
 */
export function computeDEMA(values: number[], period: number): number[] {
  const ema1 = computeEMA(values, period);
  const ema2 = computeEMA(ema1.map(v => isNaN(v) ? 0 : v), period);
  return values.map((_, i) =>
    isNaN(ema1[i]) || isNaN(ema2[i]) ? NaN : 2 * ema1[i] - ema2[i],
  );
}

/**
 * Triple EMA: TEMA(n) = 3×EMA - 3×EMA(EMA) + EMA(EMA(EMA)).
 * Warmup ≈ 3×period.
 */
export function computeTEMA(values: number[], period: number): number[] {
  const ema1 = computeEMA(values, period);
  const ema2 = computeEMA(ema1.map(v => isNaN(v) ? 0 : v), period);
  const ema3 = computeEMA(ema2.map(v => isNaN(v) ? 0 : v), period);
  return values.map((_, i) =>
    isNaN(ema1[i]) || isNaN(ema2[i]) || isNaN(ema3[i])
      ? NaN
      : 3 * ema1[i] - 3 * ema2[i] + ema3[i],
  );
}

/**
 * Hull Moving Average: HMA(n) = WMA(2×WMA(n/2) − WMA(n), √n).
 * Very fast, low-lag.
 */
export function computeHMA(values: number[], period: number): number[] {
  const half  = Math.floor(period / 2);
  const sqN   = Math.round(Math.sqrt(period));
  const wHalf = computeWMA(values, half);
  const wFull = computeWMA(values, period);
  const diff  = values.map((_, i) =>
    isNaN(wHalf[i]) || isNaN(wFull[i]) ? NaN : 2 * wHalf[i] - wFull[i],
  );
  const hma = computeWMA(diff.map(v => isNaN(v) ? 0 : v), sqN);
  for (let i = 0; i < period - 1; i++) hma[i] = NaN;
  return hma;
}

/**
 * Kaufman Adaptive Moving Average.
 * Slows in volatile/choppy markets, speeds up in trending markets.
 */
export function computeKAMA(
  values:      number[],
  erPeriod   = 10,
  fastPeriod = 2,
  slowPeriod = 30,
): number[] {
  const n      = values.length;
  const out    = new Array<number>(n).fill(NaN);
  if (n < erPeriod) return out;
  const fastSC = 2 / (fastPeriod + 1);
  const slowSC = 2 / (slowPeriod + 1);
  let kama     = values[erPeriod - 1];
  out[erPeriod - 1] = kama;
  for (let i = erPeriod; i < n; i++) {
    const change = Math.abs(values[i] - values[i - erPeriod]);
    let vol = 0;
    for (let j = i - erPeriod + 1; j <= i; j++) vol += Math.abs(values[j] - values[j - 1]);
    const er = vol === 0 ? 0 : change / vol;
    const sc = (er * (fastSC - slowSC) + slowSC) ** 2;
    kama    = kama + sc * (values[i] - kama);
    out[i]  = kama;
  }
  return out;
}

/**
 * TRIX — 1-period ROC of triple-smoothed EMA.
 * Crosses above 0 = bullish momentum.
 */
export function computeTRIX(values: number[], period = 15): number[] {
  const ema1 = computeEMA(values, period);
  const ema2 = computeEMA(ema1.map(v => isNaN(v) ? 0 : v), period);
  const ema3 = computeEMA(ema2.map(v => isNaN(v) ? 0 : v), period);
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    if (!isNaN(ema3[i]) && !isNaN(ema3[i - 1]) && ema3[i - 1] !== 0)
      out[i] = (ema3[i] / ema3[i - 1] - 1) * 100;
  }
  return out;
}

// ── K2. Momentum oscillators ──────────────────────────────────────────────────

/** Stochastic RSI — applies the Stochastic formula to RSI values. */
export function computeStochRSI(
  closes:      number[],
  rsiPeriod  = 14,
  stochPeriod = 14,
  smoothK    = 3,
  smoothD    = 3,
): { k: number[]; d: number[] } {
  const rsi = computeRSI(closes, rsiPeriod);
  const n   = closes.length;
  const raw = new Array<number>(n).fill(NaN);
  for (let i = rsiPeriod + stochPeriod - 1; i < n; i++) {
    const slice = rsi.slice(i - stochPeriod + 1, i + 1).filter(v => !isNaN(v));
    if (slice.length < stochPeriod) continue;
    const lo = Math.min(...slice), hi = Math.max(...slice);
    raw[i] = hi === lo ? 0.5 : (rsi[i] - lo) / (hi - lo);
  }
  const k = computeSMA(raw.map(v => isNaN(v) ? 0 : v), smoothK);
  for (let i = 0; i < rsiPeriod + stochPeriod - 1; i++) k[i] = NaN;
  const d = computeSMA(k.map(v => isNaN(v) ? 0 : v), smoothD);
  for (let i = 0; i < rsiPeriod + stochPeriod + smoothK - 2; i++) d[i] = NaN;
  return { k, d };
}

/** Chande Momentum Oscillator: (upSum - dnSum) / (upSum + dnSum) × 100. */
export function computeCMO(values: number[], period = 14): number[] {
  const n   = values.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = period; i < n; i++) {
    let up = 0, dn = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = values[j] - values[j - 1];
      if (d > 0) up += d; else dn -= d;
    }
    out[i] = (up + dn) === 0 ? 0 : ((up - dn) / (up + dn)) * 100;
  }
  return out;
}

/** True Strength Index — double-smoothed price momentum. */
export function computeTSI(
  values:       number[],
  longPeriod  = 25,
  shortPeriod = 13,
  signalPeriod = 13,
): { tsi: number[]; signal: number[] } {
  const n   = values.length;
  const mtm = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) mtm[i] = values[i] - values[i - 1];
  const vm  = mtm.map(v => isNaN(v) ? 0 : v);
  const vma = vm.map(v => Math.abs(v));
  const sm  = computeEMA(computeEMA(vm,  longPeriod).map(v => isNaN(v) ? 0 : v), shortPeriod);
  const sma = computeEMA(computeEMA(vma, longPeriod).map(v => isNaN(v) ? 0 : v), shortPeriod);
  const tsi = sm.map((v, i) => isNaN(v) || isNaN(sma[i]) || sma[i] === 0 ? NaN : (v / sma[i]) * 100);
  const signal = computeEMA(tsi.map(v => isNaN(v) ? 0 : v), signalPeriod);
  return { tsi, signal };
}

/** Know Sure Thing oscillator. Standard params: ROC(10,13,14,15), SMA(10,13,14,15), WMA weights 1-4. */
export function computeKST(values: number[]): { kst: number[]; signal: number[] } {
  const n   = values.length;
  const rc1 = computeROC(values, 10).map(v => isNaN(v) ? 0 : v);
  const rc2 = computeROC(values, 13).map(v => isNaN(v) ? 0 : v);
  const rc3 = computeROC(values, 14).map(v => isNaN(v) ? 0 : v);
  const rc4 = computeROC(values, 15).map(v => isNaN(v) ? 0 : v);
  const sm1 = computeSMA(rc1, 10);
  const sm2 = computeSMA(rc2, 13);
  const sm3 = computeSMA(rc3, 14);
  const sm4 = computeSMA(rc4, 15);
  const kst = Array.from({ length: n }, (_, i) =>
    isNaN(sm1[i]) || isNaN(sm2[i]) || isNaN(sm3[i]) || isNaN(sm4[i])
      ? NaN
      : sm1[i] * 1 + sm2[i] * 2 + sm3[i] * 3 + sm4[i] * 4,
  );
  const signal = computeSMA(kst.map(v => isNaN(v) ? 0 : v), 9);
  return { kst, signal };
}

/** Coppock Curve: WMA(10) of [ROC(14) + ROC(11)]. Crosses above 0 = buy. */
export function computeCoppock(values: number[]): number[] {
  const roc14 = computeROC(values, 14).map(v => isNaN(v) ? 0 : v);
  const roc11 = computeROC(values, 11).map(v => isNaN(v) ? 0 : v);
  return computeWMA(roc14.map((v, i) => v + roc11[i]), 10);
}

/** Awesome Oscillator (close-based approximation of SMA5 − SMA34 of midprice). */
export function computeAO(closes: number[]): number[] {
  const s5  = computeSMA(closes, 5);
  const s34 = computeSMA(closes, 34);
  return s5.map((v, i) => isNaN(v) || isNaN(s34[i]) ? NaN : v - s34[i]);
}

/** Detrended Price Oscillator: close - SMA(n) shifted by floor(n/2)+1. */
export function computeDPO(values: number[], period = 20): number[] {
  const sma   = computeSMA(values, period);
  const shift = Math.floor(period / 2) + 1;
  const n     = values.length;
  const out   = new Array<number>(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    const si = i - shift;
    if (si >= 0 && !isNaN(sma[si])) out[i] = values[i] - sma[si];
  }
  return out;
}

/**
 * Schaff Trend Cycle — applies Stochastic twice to MACD output, smoothed with EMA(3).
 * Range 0–100; < 25 = oversold, > 75 = overbought.
 */
export function computeSTC(
  closes:      number[],
  stochPeriod = 10,
  fastEMA    = 23,
  slowEMA    = 50,
): number[] {
  const n      = closes.length;
  const fast   = computeEMA(closes, fastEMA);
  const slow   = computeEMA(closes, slowEMA);
  const macd   = fast.map((v, i) => isNaN(v) || isNaN(slow[i]) ? NaN : v - slow[i]);

  // First stochastic on MACD
  const stoch1 = new Array<number>(n).fill(NaN);
  for (let i = stochPeriod - 1; i < n; i++) {
    const sl = macd.slice(i - stochPeriod + 1, i + 1).filter(v => !isNaN(v));
    if (sl.length < stochPeriod) continue;
    const lo = Math.min(...sl), hi = Math.max(...sl);
    stoch1[i] = hi === lo ? 50 : ((macd[i]! - lo) / (hi - lo)) * 100;
  }
  const k = computeEMA(stoch1.map(v => isNaN(v) ? 0 : v), 3);
  for (let i = 0; i < stochPeriod; i++) k[i] = NaN;

  // Second stochastic on K
  const stoch2 = new Array<number>(n).fill(NaN);
  for (let i = stochPeriod * 2 - 2; i < n; i++) {
    const sl = k.slice(i - stochPeriod + 1, i + 1).filter(v => !isNaN(v));
    if (sl.length < stochPeriod) continue;
    const lo = Math.min(...sl), hi = Math.max(...sl);
    stoch2[i] = hi === lo ? 50 : ((k[i] - lo) / (hi - lo)) * 100;
  }
  const stc = computeEMA(stoch2.map(v => isNaN(v) ? 0 : v), 3);
  for (let i = 0; i < stochPeriod * 2 - 1; i++) stc[i] = NaN;
  return stc;
}

// ── K3. Volume oscillators ────────────────────────────────────────────────────

/** Volume Price Trend: cumulative (price % change × volume). */
export function computeVPT(closes: number[], volumes: number[]): number[] {
  const n   = closes.length;
  const out = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const pct = closes[i - 1] === 0 ? 0 : (closes[i] - closes[i - 1]) / closes[i - 1];
    out[i] = out[i - 1] + volumes[i] * pct;
  }
  return out;
}

/**
 * Negative Volume Index — tracks price changes on days when volume decreases.
 * Starts at 1000. Rising NVI = smart money accumulating on quiet days.
 */
export function computeNVI(closes: number[], volumes: number[]): number[] {
  const n   = closes.length;
  const out = new Array<number>(n).fill(1000);
  for (let i = 1; i < n; i++) {
    if (volumes[i] < volumes[i - 1]) {
      const pct = closes[i - 1] === 0 ? 0 : (closes[i] - closes[i - 1]) / closes[i - 1];
      out[i] = out[i - 1] * (1 + pct);
    } else {
      out[i] = out[i - 1];
    }
  }
  return out;
}

/** Chaikin Oscillator: EMA(3, A/D) − EMA(10, A/D). Crosses above 0 = bullish. */
export function computeChaikinOsc(
  adLine:      number[],
  fastPeriod = 3,
  slowPeriod = 10,
): number[] {
  const fast = computeEMA(adLine, fastPeriod);
  const slow = computeEMA(adLine, slowPeriod);
  return fast.map((v, i) => isNaN(v) || isNaN(slow[i]) ? NaN : v - slow[i]);
}

/** Force Index: EMA(period) of (close_change × volume). Elder's indicator. */
export function computeForceIndex(
  closes:  number[],
  volumes: number[],
  period = 2,
): number[] {
  const n  = closes.length;
  const fi = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) fi[i] = (closes[i] - closes[i - 1]) * volumes[i];
  const ema = computeEMA(fi.map(v => isNaN(v) ? 0 : v), period);
  for (let i = 0; i < period; i++) ema[i] = NaN;
  return ema;
}

// ── K4. Volatility — Keltner, Ulcer, PPO signal ───────────────────────────────

/**
 * Keltner Channel using a pre-computed ATR array.
 * Middle = EMA(close, emaPeriod); Upper/Lower = Middle ± mult × ATR.
 */
export function computeKeltnerFromATR(
  closes:     number[],
  atrArr:     number[],
  emaPeriod = 20,
  mult      = 2,
): { upper: number[]; middle: number[]; lower: number[] } {
  const mid   = computeEMA(closes, emaPeriod);
  const upper = mid.map((v, i) => isNaN(v) || isNaN(atrArr[i]) ? NaN : v + mult * atrArr[i]);
  const lower = mid.map((v, i) => isNaN(v) || isNaN(atrArr[i]) ? NaN : v - mult * atrArr[i]);
  return { upper, middle: mid, lower };
}

/**
 * Ulcer Index (close-based).
 * UI = sqrt( mean( (percentDrawdown)² ) ) over period bars.
 * Low UI = stock regaining losses quickly → low stress.
 */
export function computeUlcerIndex(closes: number[], period = 14): number[] {
  const n   = closes.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const peak  = Math.max(...slice);
    if (peak === 0) continue;
    const sq = slice.reduce((s, c) => s + ((c - peak) / peak * 100) ** 2, 0);
    out[i] = Math.sqrt(sq / period);
  }
  return out;
}

/** PPO with signal line: signal = EMA(signalPeriod, PPO). */
export function computePPOWithSignal(
  closes:       number[],
  fastPeriod  = 12,
  slowPeriod  = 26,
  signalPeriod = 9,
): { ppo: number[]; signal: number[] } {
  const ppo    = computePPO(closes, fastPeriod, slowPeriod);
  const signal = computeEMA(ppo.map(v => isNaN(v) ? 0 : v), signalPeriod);
  return { ppo, signal };
}

// ── K5. Trend composites ──────────────────────────────────────────────────────

/**
 * Williams Alligator — Jaw(SMMA13), Teeth(SMMA8), Lips(SMMA5).
 * Uses close as proxy for median price (H+L)/2.
 * When Lips > Teeth > Jaw and all rising = "awakening".
 */
export function computeAlligator(closes: number[]): {
  jaw: number[]; teeth: number[]; lips: number[];
} {
  const n = closes.length;
  function smma(period: number): number[] {
    const out = new Array<number>(n).fill(NaN);
    if (n < period) return out;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    out[period - 1] = sum / period;
    for (let i = period; i < n; i++)
      out[i] = (out[i - 1] * (period - 1) + closes[i]) / period;
    return out;
  }
  return { jaw: smma(13), teeth: smma(8), lips: smma(5) };
}

/**
 * Guppy Multiple Moving Averages.
 * Short group: EMA 3,5,8,10,12,15
 * Long group:  EMA 30,35,40,45,50,60
 */
export function computeGuppyEMAs(closes: number[]): {
  short: number[][]; long: number[][];
} {
  return {
    short: [3, 5, 8, 10, 12, 15].map(p => computeEMA(closes, p)),
    long:  [30, 35, 40, 45, 50, 60].map(p => computeEMA(closes, p)),
  };
}

// ── K6. Statistical ───────────────────────────────────────────────────────────

/** Rolling Z-Score: (close - mean) / stddev over `period` bars. */
export function computeZScore(values: number[], period = 20): number[] {
  const n   = values.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    const sl = values.slice(i - period + 1, i + 1);
    const mu = sl.reduce((s, v) => s + v, 0) / period;
    const sd = Math.sqrt(sl.reduce((s, v) => s + (v - mu) ** 2, 0) / period);
    out[i]   = sd === 0 ? 0 : (values[i] - mu) / sd;
  }
  return out;
}

/** Rolling linear regression slope over `period` bars. */
export function computeLRSlopeArr(values: number[], period = 20): number[] {
  const n    = values.length;
  const out  = new Array<number>(n).fill(NaN);
  const mx   = (period - 1) / 2;
  const ssxx = Array.from({ length: period }, (_, i) => (i - mx) ** 2)
                    .reduce((s, v) => s + v, 0);
  for (let i = period - 1; i < n; i++) {
    const sl = values.slice(i - period + 1, i + 1);
    const my = sl.reduce((s, v) => s + v, 0) / period;
    const ssxy = sl.reduce((s, v, j) => s + (j - mx) * (v - my), 0);
    out[i] = ssxx === 0 ? 0 : ssxy / ssxx;
  }
  return out;
}

/**
 * Hurst Exponent (simplified R/S analysis over `period` bars).
 * H > 0.5 = persistent (trending); H < 0.5 = anti-persistent (mean-reverting).
 * Returns NaN for bars with insufficient data.
 */
export function computeHurst(values: number[], period = 100): number[] {
  const n   = values.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    const slice = values.slice(i - period + 1, i + 1);
    const logR: number[] = [];
    for (let j = 1; j < slice.length; j++) {
      if (slice[j - 1] > 0) logR.push(Math.log(slice[j] / slice[j - 1]));
    }
    if (logR.length < 10) continue;
    const logRs: number[] = [], logN: number[] = [];
    for (const len of [Math.floor(logR.length / 2), logR.length]) {
      if (len < 4) continue;
      const sub = logR.slice(0, len);
      const mu  = sub.reduce((s, v) => s + v, 0) / len;
      const dev = sub.map(v => v - mu);
      let cum = 0;
      const cumD: number[] = [0];
      for (const d of dev) { cum += d; cumD.push(cum); }
      const R = Math.max(...cumD) - Math.min(...cumD);
      const S = Math.sqrt(dev.reduce((s, v) => s + v * v, 0) / len);
      if (S > 0) { logRs.push(Math.log(R / S)); logN.push(Math.log(len)); }
    }
    if (logRs.length >= 2) {
      const mx = logN.reduce((s, v) => s + v, 0) / logN.length;
      const my = logRs.reduce((s, v) => s + v, 0) / logRs.length;
      const ss = logN.reduce((s, x, k) => s + (x - mx) * (logRs[k] - my), 0);
      const sx = logN.reduce((s, x) => s + (x - mx) ** 2, 0);
      if (sx > 0) out[i] = ss / sx;
    }
  }
  return out;
}

// ── K7. VizIndicatorCache — per-ticker precomputed store ──────────────────────

/**
 * All indicator series for one ticker, indexed in parallel with the obs array.
 * Populated by vizBuildIndicatorCache(); consumed by vizEvaluateTriggerV2().
 */
export interface VizIndicatorCache {
  // ── Raw / pre-computed from observations ──
  close:      number[];
  volume:     number[];
  sma20:      number[];
  sma50:      number[];
  sma200:     number[];
  rsi14:      number[];
  // ── Multi-period RSI (computed from close; rsi14 above is obs-sourced) ────
  rsi2:       number[];
  rsi4:       number[];
  rsi5:       number[];
  rsi7:       number[];
  rsi9:       number[];
  rsi21:      number[];
  macdLine:   number[];
  macdSig:    number[];
  macdHist:   number[];
  stochK:     number[];
  stochD:     number[];
  williamsR:  number[];
  cci20:      number[];
  roc20:      number[];
  adx14:      number[];
  diPlus:     number[];
  diMinus:    number[];
  aroonUp:    number[];
  aroonDn:    number[];
  bbUpper:    number[];
  bbLower:    number[];
  bbWidth:    number[];
  bbPctB:     number[];
  bbSqueeze:  boolean[];
  atr14:      number[];
  obvArr:     number[];
  obvSlope:   number[];
  cmf20:      number[];
  mfi14:      number[];
  adLine:     number[];
  adSlope:    number[];
  vwap20:     number[];
  priceVsVwap: number[];
  hvPct:      number[];
  ppo:        number[];
  rsiDiv:     string[];
  macdDiv:    string[];
  swingStruct: string[];
  pos52w:     number[];
  beta252:    number[];
  // ── Computed from close ───────────────────
  ema12:      number[];
  ema13:      number[];
  ema26:      number[];
  ema50:      number[];
  volumeRatio: number[];
  dema12:     number[];
  dema26:     number[];
  tema12:     number[];
  tema26:     number[];
  hma20:      number[];
  hma50:      number[];
  kama:       number[];
  trix15:     number[];
  stochRsiK:  number[];
  stochRsiD:  number[];
  cmo14:      number[];
  // ── Multi-period CMO (close-only) ─────────────────────────────────────────
  cmo7:       number[];
  cmo9:       number[];
  cmo21:      number[];
  tsi:        number[];
  tsiSignal:  number[];
  kst:        number[];
  kstSignal:  number[];
  coppock:    number[];
  ao:         number[];
  dpo:        number[];
  // ── Multi-period DPO (close-only) ─────────────────────────────────────────
  dpo14:      number[];
  dpo30:      number[];
  stc:        number[];
  ppoSignal:  number[];
  lrSlope:    number[];
  // ── Multi-period LR Slope (close-only) ───────────────────────────────────
  lrSlope10:  number[];
  lrSlope14:  number[];
  lrSlope50:  number[];
  zScore:     number[];
  // ── Multi-period Z-Score (close-only) ────────────────────────────────────
  zScore10:   number[];
  zScore14:   number[];
  zScore30:   number[];
  hurst:      number[];
  // ── Multi-period TRIX (close-only) ───────────────────────────────────────
  trix8:      number[];
  trix12:     number[];
  trix20:     number[];
  // ── Multi-period ROC (close-only or from obs) ─────────────────────────────
  roc10:      number[];  // from obs if available, else computed
  roc14:      number[];
  roc30:      number[];
  ulcerIdx:   number[];
  // ── Multi-period Williams %R (from obs) ───────────────────────────────────
  wr7:        number[];
  wr10:       number[];
  wr20:       number[];
  wr28:       number[];
  // ── Multi-period CCI (from obs) ───────────────────────────────────────────
  cci10:      number[];
  cci14:      number[];
  cci25:      number[];
  // ── Multi-period Stochastic (from obs) ───────────────────────────────────
  stochK5:    number[];
  stochD5:    number[];
  stochK9:    number[];
  stochD9:    number[];
  stochK21:   number[];
  stochD21:   number[];
  // ── Multi-period MFI (from obs) ───────────────────────────────────────────
  mfi7:       number[];
  mfi10:      number[];
  mfi20:      number[];
  // ── Multi-period ADX / DI (from obs) ─────────────────────────────────────
  adx7:       number[];
  diPlus7:    number[];
  diMinus7:   number[];
  adx10:      number[];
  diPlus10:   number[];
  diMinus10:  number[];
  adx20:      number[];
  diPlus20:   number[];
  diMinus20:  number[];
  // ── Multi-period Aroon (from obs) ─────────────────────────────────────────
  aroonUp14:  number[];
  aroonDn14:  number[];
  aroonUp20:  number[];
  aroonDn20:  number[];
  aroonUp40:  number[];
  aroonDn40:  number[];
  // ── Multi-period ATR (from obs) ───────────────────────────────────────────
  atr7:       number[];
  atr10:      number[];
  atr20:      number[];
  // ── Computed from close + volume ──────────
  forceIdx:   number[];
  vpt:        number[];
  nvi:        number[];
  nviEma:     number[];
  // ── Computed from pre-computed series ─────
  chaikinOsc: number[];
  keltUpper:  number[];
  keltLower:  number[];
  keltMid:    number[];
  obvSma20:   number[];
  alliJaw:    number[];
  alliTeeth:  number[];
  alliLips:   number[];
  guppyShort: number[][];
  guppyLong:  number[][];
}

// ── K8. vizBuildIndicatorCache ────────────────────────────────────────────────

/** Safely extract a numeric series from obs rows by field name. */
function _numSeries(obs: VizObsRow[], field: string): number[] {
  return obs.map(o => {
    const v = o[field];
    return typeof v === 'number' && isFinite(v) && !isNaN(v) ? v : NaN;
  });
}
function _strSeries(obs: VizObsRow[], field: string): string[] {
  return obs.map(o => {
    const v = o[field];
    return typeof v === 'string' ? v : '';
  });
}
function _boolSeries(obs: VizObsRow[], field: string): boolean[] {
  return obs.map(o => {
    const v = o[field];
    return v === true || v === 'true';
  });
}

/**
 * Build the complete indicator cache for one ticker.
 * Pass the full sorted obs array (oldest → newest).
 * All arrays are co-indexed: cache.close[i] corresponds to obs[i].
 */
export function vizBuildIndicatorCache(obs: VizObsRow[]): VizIndicatorCache {
  // ── Extract pre-computed series from observations ─────────────────────────
  const close      = _numSeries(obs, 'close');
  const volume     = _numSeries(obs, 'volume');

  // Fill NaN volumes with 0 for volume-based indicators
  const vol0 = volume.map(v => isNaN(v) ? 0 : v);
  // Close with 0-fill for MA computation (NaN ruins EMA seed)
  const cl0  = close.map(v => isNaN(v) ? 0 : v);

  // ── Pre-computed indicator series ─────────────────────────────────────────
  const sma20      = _numSeries(obs, 'sma_20');
  const sma50      = _numSeries(obs, 'sma_50');
  const sma200     = _numSeries(obs, 'sma_200');
  const rsi14      = _numSeries(obs, 'rsi_14');
  const macdLine   = _numSeries(obs, 'macd_line');
  const macdSig    = _numSeries(obs, 'macd_signal');
  const macdHist   = _numSeries(obs, 'macd_histogram');
  const stochK     = _numSeries(obs, 'stoch_k');
  const stochD     = _numSeries(obs, 'stoch_d');
  const williamsR  = _numSeries(obs, 'williams_r_14');
  const cci20      = _numSeries(obs, 'cci_20');
  const roc20      = _numSeries(obs, 'roc_20');
  const adx14      = _numSeries(obs, 'adx_14');
  const diPlus     = _numSeries(obs, 'di_plus_14');
  const diMinus    = _numSeries(obs, 'di_minus_14');
  const aroonUp    = _numSeries(obs, 'aroon_up_25');
  const aroonDn    = _numSeries(obs, 'aroon_down_25');
  const bbUpper    = _numSeries(obs, 'bb_upper_20_2');
  const bbLower    = _numSeries(obs, 'bb_lower_20_2');
  const bbWidth    = _numSeries(obs, 'bb_width');
  const bbPctB     = _numSeries(obs, 'bb_pct_b');
  const bbSqueeze  = _boolSeries(obs, 'bb_squeeze');
  const atr14      = _numSeries(obs, 'atr_14');
  const obvArr     = _numSeries(obs, 'obv');
  const obvSlope   = _numSeries(obs, 'obv_slope_10');
  const cmf20      = _numSeries(obs, 'cmf_20');
  const mfi14      = _numSeries(obs, 'mfi_14');
  const adLine     = _numSeries(obs, 'ad_line');
  const adSlope    = _numSeries(obs, 'ad_slope_10');
  const vwap20     = _numSeries(obs, 'vwap_20');
  const priceVsVwap = _numSeries(obs, 'price_vs_vwap_pct');
  const hvPct      = _numSeries(obs, 'hv_percentile_252');
  const ppo        = _numSeries(obs, 'ppo');
  const rsiDiv     = _strSeries(obs, 'rsi_divergence');
  const macdDiv    = _strSeries(obs, 'macd_divergence');
  const swingStruct = _strSeries(obs, 'swing_structure');
  const pos52w     = _numSeries(obs, 'pos_52w_pct');
  const beta252    = _numSeries(obs, 'beta_252');

  // ── Multi-period RSI (computed from close for parameter sweeps) ──────────
  const rsi2  = computeRSI(cl0, 2);
  const rsi4  = computeRSI(cl0, 4);
  const rsi5  = computeRSI(cl0, 5);
  const rsi7  = computeRSI(cl0, 7);
  const rsi9  = computeRSI(cl0, 9);
  const rsi21 = computeRSI(cl0, 21);

  // ── Compute from close series ─────────────────────────────────────────────
  const volumeRatio = _numSeries(obs, 'volume_ratio');
  const ema12    = computeEMA(cl0, 12);
  const ema13    = computeEMA(cl0, 13);
  const ema26    = computeEMA(cl0, 26);
  const ema50c   = computeEMA(cl0, 50);
  const dema12   = computeDEMA(cl0, 12);
  const dema26   = computeDEMA(cl0, 26);
  const tema12   = computeTEMA(cl0, 12);
  const tema26   = computeTEMA(cl0, 26);
  const hma20    = computeHMA(cl0, 20);
  const hma50    = computeHMA(cl0, 50);
  const kama     = computeKAMA(cl0);
  const trix15   = computeTRIX(cl0, 15);
  const { k: stochRsiK, d: stochRsiD } = computeStochRSI(cl0);
  const cmo14    = computeCMO(cl0, 14);
  const cmo7     = computeCMO(cl0, 7);
  const cmo9     = computeCMO(cl0, 9);
  const cmo21    = computeCMO(cl0, 21);
  const { tsi, signal: tsiSignal }     = computeTSI(cl0);
  const { kst: kstArr, signal: kstSig } = computeKST(cl0);
  const coppock  = computeCoppock(cl0);
  const ao       = computeAO(cl0);
  const dpo      = computeDPO(cl0, 20);
  const dpo14    = computeDPO(cl0, 14);
  const dpo30    = computeDPO(cl0, 30);
  const stc      = computeSTC(cl0);
  const { signal: ppoSignal } = computePPOWithSignal(cl0);
  const lrSlope  = computeLRSlopeArr(cl0, 20);
  const lrSlope10 = computeLRSlopeArr(cl0, 10);
  const lrSlope14 = computeLRSlopeArr(cl0, 14);
  const lrSlope50 = computeLRSlopeArr(cl0, 50);
  const zScore   = computeZScore(cl0, 20);
  const zScore10 = computeZScore(cl0, 10);
  const zScore14 = computeZScore(cl0, 14);
  const zScore30 = computeZScore(cl0, 30);
  const hurst    = computeHurst(cl0, 100);
  const trix8    = computeTRIX(cl0, 8);
  const trix12   = computeTRIX(cl0, 12);
  const trix20   = computeTRIX(cl0, 20);
  // ROC: prefer obs-stored values when they match, compute others from close
  const roc10    = _numSeries(obs, 'roc_10');   // already in obs table
  const roc14    = computeROC(cl0, 14);         // close-computed
  const roc30    = computeROC(cl0, 30);         // close-computed
  const ulcerIdx = computeUlcerIndex(cl0, 14);

  // ── Multi-period OHLCV series (from obs — computed by daily-observations) ──
  const wr7      = _numSeries(obs, 'williams_r_7');
  const wr10     = _numSeries(obs, 'williams_r_10');
  const wr20     = _numSeries(obs, 'williams_r_20');
  const wr28     = _numSeries(obs, 'williams_r_28');
  const cci10    = _numSeries(obs, 'cci_10');
  const cci14    = _numSeries(obs, 'cci_14');
  const cci25    = _numSeries(obs, 'cci_25');
  const stochK5  = _numSeries(obs, 'stoch_k_5');
  const stochD5  = _numSeries(obs, 'stoch_d_5');
  const stochK9  = _numSeries(obs, 'stoch_k_9');
  const stochD9  = _numSeries(obs, 'stoch_d_9');
  const stochK21 = _numSeries(obs, 'stoch_k_21');
  const stochD21 = _numSeries(obs, 'stoch_d_21');
  const mfi7     = _numSeries(obs, 'mfi_7');
  const mfi10    = _numSeries(obs, 'mfi_10');
  const mfi20    = _numSeries(obs, 'mfi_20');
  const adx7     = _numSeries(obs, 'adx_7');
  const diPlus7  = _numSeries(obs, 'di_plus_7');
  const diMinus7 = _numSeries(obs, 'di_minus_7');
  const adx10    = _numSeries(obs, 'adx_10');
  const diPlus10 = _numSeries(obs, 'di_plus_10');
  const diMinus10 = _numSeries(obs, 'di_minus_10');
  const adx20    = _numSeries(obs, 'adx_20');
  const diPlus20 = _numSeries(obs, 'di_plus_20');
  const diMinus20 = _numSeries(obs, 'di_minus_20');
  const aroonUp14 = _numSeries(obs, 'aroon_up_14');
  const aroonDn14 = _numSeries(obs, 'aroon_down_14');
  const aroonUp20 = _numSeries(obs, 'aroon_up_20');
  const aroonDn20 = _numSeries(obs, 'aroon_down_20');
  const aroonUp40 = _numSeries(obs, 'aroon_up_40');
  const aroonDn40 = _numSeries(obs, 'aroon_down_40');
  const atr7     = _numSeries(obs, 'atr_7');
  const atr10    = _numSeries(obs, 'atr_10');
  const atr20    = _numSeries(obs, 'atr_20');

  // ── Compute from close + volume ───────────────────────────────────────────
  const forceIdx = computeForceIndex(cl0, vol0, 2);
  const vpt      = computeVPT(cl0, vol0);
  const nvi      = computeNVI(cl0, vol0);
  const nviEma   = computeEMA(nvi, 255);

  // ── Compute from pre-computed A/D line series ─────────────────────────────
  const validAD    = adLine.map(v => isNaN(v) ? 0 : v);
  const chaikinOsc = computeChaikinOsc(validAD);

  // ── Keltner Channel (uses pre-computed ATR) ───────────────────────────────
  const { upper: keltUpper, middle: keltMid, lower: keltLower } =
    computeKeltnerFromATR(cl0, atr14);

  // ── OBV SMA (for OBV vs SMA cross) ───────────────────────────────────────
  const validOBV = obvArr.map(v => isNaN(v) ? 0 : v);
  const obvSma20 = computeSMA(validOBV, 20);

  // ── Alligator ──────────────────────────────────────────────────────────────
  const { jaw: alliJaw, teeth: alliTeeth, lips: alliLips } = computeAlligator(cl0);

  // ── Guppy GMMA ────────────────────────────────────────────────────────────
  const { short: guppyShort, long: guppyLong } = computeGuppyEMAs(cl0);

  return {
    close, volume, volumeRatio, sma20, sma50, sma200, rsi14,
    rsi2, rsi4, rsi5, rsi7, rsi9, rsi21,
    macdLine, macdSig, macdHist, stochK, stochD,
    williamsR, cci20, roc20, adx14, diPlus, diMinus,
    aroonUp, aroonDn, bbUpper, bbLower, bbWidth, bbPctB, bbSqueeze,
    atr14, obvArr, obvSlope, cmf20, mfi14, adLine, adSlope,
    vwap20, priceVsVwap, hvPct, ppo, rsiDiv, macdDiv,
    swingStruct, pos52w, beta252,
    ema12, ema13, ema26, ema50: ema50c,
    dema12, dema26, tema12, tema26,
    hma20, hma50, kama, trix15,
    stochRsiK, stochRsiD,
    cmo14, cmo7, cmo9, cmo21,
    tsi, tsiSignal: tsiSignal,
    kst: kstArr, kstSignal: kstSig,
    coppock, ao,
    dpo, dpo14, dpo30,
    stc, ppoSignal,
    lrSlope, lrSlope10, lrSlope14, lrSlope50,
    zScore, zScore10, zScore14, zScore30,
    hurst, ulcerIdx,
    trix8, trix12, trix20,
    roc10, roc14, roc30,
    forceIdx, vpt, nvi, nviEma,
    chaikinOsc, keltUpper, keltMid, keltLower,
    obvSma20, alliJaw, alliTeeth, alliLips,
    guppyShort, guppyLong,
    // Multi-period OHLCV (from obs)
    wr7, wr10, wr20, wr28,
    cci10, cci14, cci25,
    stochK5, stochD5, stochK9, stochD9, stochK21, stochD21,
    mfi7, mfi10, mfi20,
    adx7, diPlus7, diMinus7,
    adx10, diPlus10, diMinus10,
    adx20, diPlus20, diMinus20,
    aroonUp14, aroonDn14, aroonUp20, aroonDn20, aroonUp40, aroonDn40,
    atr7, atr10, atr20,
  };
}

// ── K9. vizEvaluateTriggerV2 — cache-based, all 71 hypotheses ─────────────────

function _nn(v: number): boolean { return !isNaN(v) && isFinite(v); }

/** Snap period to nearest supported value and return corresponding series. */
function _snap(p: number, breakpoints: number[], series: number[][]): number[] {
  for (let i = 0; i < breakpoints.length - 1; i++) {
    if (p <= breakpoints[i]) return series[i];
  }
  return series[series.length - 1];
}

/**
 * Pick the correct pre-computed RSI series based on `params.period`.
 * Falls back to obs-sourced rsi14 when no period is specified.
 * Snaps to the nearest available period: 2, 4, 5, 7, 9, 14, 21+.
 */
function _rsiByPeriod(c: VizIndicatorCache, period?: number): number[] {
  if (!period || period <= 0)  return c.rsi14; // default: obs-sourced RSI(14)
  if (period <= 2)  return c.rsi2;
  if (period <= 4)  return c.rsi4;
  if (period <= 5)  return c.rsi5;
  if (period <= 7)  return c.rsi7;
  if (period <= 9)  return c.rsi9;
  if (period <= 14) return c.rsi14;
  return c.rsi21;                              // 15+ → RSI(21)
}

/** Cross detection: prev below threshold and today above. */
function _crossAbove(arr: number[], i: number, level = 0): boolean {
  return i > 0 && _nn(arr[i - 1]) && _nn(arr[i]) && arr[i - 1] <= level && arr[i] > level;
}
/** Cross detection: prev above threshold and today below. */
function _crossBelow(arr: number[], i: number, level = 0): boolean {
  return i > 0 && _nn(arr[i - 1]) && _nn(arr[i]) && arr[i - 1] >= level && arr[i] < level;
}

/**
 * Evaluate whether hypothesis `id` fires at bar index `i` in the cache.
 * Replaces vizEvaluateTrigger() for the backtest-runner (cache-based path).
 * The signal recorder continues to use the original vizEvaluateTrigger().
 */
export function vizEvaluateTriggerV2(
  id:     string,
  params: Record<string, number>,
  i:      number,
  c:      VizIndicatorCache,
): boolean {

  // For parameter sweep variants (id contains '__'), strip suffix to route to base case.
  // e.g. 'rsi_exit_oversold__20' → 'rsi_exit_oversold'; params still carry the actual value.
  const baseId = id.includes('__') ? id.split('__')[0] : id;

  switch (baseId) {

  // ── SECTION 1: TREND / MA ─────────────────────────────────────────────────

  case 'sma_cross_20_50':
    if (i < 1 || !_nn(c.sma20[i]) || !_nn(c.sma50[i])) return false;
    return c.sma20[i - 1] <= c.sma50[i - 1] && c.sma20[i] > c.sma50[i];

  case 'ema_cross_12_26':
    if (i < 1 || !_nn(c.ema12[i]) || !_nn(c.ema26[i])) return false;
    return c.ema12[i - 1] <= c.ema26[i - 1] && c.ema12[i] > c.ema26[i];

  case 'price_above_sma200':
    return _nn(c.close[i]) && _nn(c.sma200[i]) && c.close[i] > c.sma200[i];

  case 'price_above_ema50':
    return _nn(c.close[i]) && _nn(c.ema50[i]) && c.close[i] > c.ema50[i];

  case 'dema_cross':
    if (i < 1 || !_nn(c.dema12[i]) || !_nn(c.dema26[i])) return false;
    return c.dema12[i - 1] <= c.dema26[i - 1] && c.dema12[i] > c.dema26[i];

  case 'tema_cross':
    if (i < 1 || !_nn(c.tema12[i]) || !_nn(c.tema26[i])) return false;
    return c.tema12[i - 1] <= c.tema26[i - 1] && c.tema12[i] > c.tema26[i];

  case 'hma_cross':
    if (i < 1 || !_nn(c.hma20[i]) || !_nn(c.hma50[i])) return false;
    return c.hma20[i - 1] <= c.hma50[i - 1] && c.hma20[i] > c.hma50[i];

  case 'kama_turn_up':
    if (i < 2 || !_nn(c.kama[i]) || !_nn(c.kama[i - 1]) || !_nn(c.kama[i - 2])) return false;
    return c.kama[i] > c.kama[i - 1] && c.kama[i - 1] <= c.kama[i - 2];

  case 'trix_cross_zero': {
    const trixSeries = _snap(params.period ?? 15, [8, 12, 15, 20], [c.trix8, c.trix12, c.trix15, c.trix20]);
    return _crossAbove(trixSeries, i, 0);
  }

  case 'macd_cross_signal':
    if (i < 1 || !_nn(c.macdLine[i]) || !_nn(c.macdSig[i])) return false;
    return c.macdLine[i - 1] <= c.macdSig[i - 1] && c.macdLine[i] > c.macdSig[i];

  case 'macd_cross_zero':
    return _crossAbove(c.macdHist, i, 0);

  case 'adx_above_25': {
    const adxS = _snap(params.period ?? 14, [7, 10, 14, 20], [c.adx7, c.adx10, c.adx14, c.adx20]);
    return _nn(adxS[i]) && adxS[i] > (params.threshold ?? 25);
  }

  case 'adx_rising_di_bull': {
    const p    = params.period ?? 14;
    const adxS = _snap(p, [7, 10, 14, 20], [c.adx7,     c.adx10,     c.adx14,    c.adx20]);
    const diPS = _snap(p, [7, 10, 14, 20], [c.diPlus7,  c.diPlus10,  c.diPlus,   c.diPlus20]);
    const diMS = _snap(p, [7, 10, 14, 20], [c.diMinus7, c.diMinus10, c.diMinus,  c.diMinus20]);
    if (i < 1 || !_nn(adxS[i]) || !_nn(diPS[i]) || !_nn(diMS[i])) return false;
    return adxS[i] > adxS[i - 1] && diPS[i] > diMS[i];
  }

  case 'donchian_close_break': {
    const per = Math.round(params.period ?? 20);
    if (i < per || !_nn(c.close[i])) return false;
    const prevMax = Math.max(...c.close.slice(i - per, i));
    return c.close[i] > prevMax;
  }

  case 'aroon_bullish': {
    const p   = params.period ?? 25;
    const upS = _snap(p, [14, 20, 25, 40], [c.aroonUp14, c.aroonUp20, c.aroonUp, c.aroonUp40]);
    const dnS = _snap(p, [14, 20, 25, 40], [c.aroonDn14, c.aroonDn20, c.aroonDn, c.aroonDn40]);
    return _nn(upS[i]) && _nn(dnS[i])
        && upS[i] > (params.up_threshold ?? 70)
        && dnS[i] < (params.down_threshold ?? 30);
  }

  case 'alligator_awakening': {
    if (i < 1 || !_nn(c.alliJaw[i]) || !_nn(c.alliTeeth[i]) || !_nn(c.alliLips[i])) return false;
    const { alliJaw: j, alliTeeth: t, alliLips: l } = c;
    return l[i] > t[i] && t[i] > j[i]
        && l[i] > l[i - 1] && t[i] > t[i - 1] && j[i] > j[i - 1];
  }

  case 'guppy_gmma_bullish': {
    const s = c.guppyShort, l = c.guppyLong;
    if (s.some(e => !_nn(e[i])) || l.some(e => !_nn(e[i]))) return false;
    const minS = Math.min(...s.map(e => e[i]));
    const maxL = Math.max(...l.map(e => e[i]));
    return minS > maxL;
  }

  case 'elder_impulse_bull':
    // EMA(13) slope up AND MACD histogram rising — both from cache
    if (i < 1 || !_nn(c.ema13[i]) || !_nn(c.macdHist[i])) return false;
    return c.ema13[i] > c.ema13[i - 1]
        && _nn(c.macdHist[i - 1]) && c.macdHist[i] > c.macdHist[i - 1];

  // ── SECTION 2: MOMENTUM / OSCILLATORS ────────────────────────────────────

  case 'rsi_cross_above_50':
    return _crossAbove(_rsiByPeriod(c, params.period), i, params.midline ?? 50);

  case 'rsi_exit_oversold':
    return _crossAbove(_rsiByPeriod(c, params.period), i, params.threshold ?? 30);

  case 'rsi_exit_overbought':
    return _crossBelow(_rsiByPeriod(c, params.period), i, params.threshold ?? 70);

  case 'stoch_k_cross_d': {
    const os  = params.oversold ?? 20;
    const p   = params.period ?? 14;
    const kS  = _snap(p, [5, 9, 14, 21], [c.stochK5, c.stochK9, c.stochK, c.stochK21]);
    const dS  = _snap(p, [5, 9, 14, 21], [c.stochD5, c.stochD9, c.stochD, c.stochD21]);
    if (i < 1 || !_nn(kS[i]) || !_nn(dS[i])) return false;
    return dS[i] < os && kS[i - 1] <= dS[i - 1] && kS[i] > dS[i];
  }

  case 'stoch_exit_oversold': {
    const stochKS = _snap(params.period ?? 14, [5, 9, 14, 21], [c.stochK5, c.stochK9, c.stochK, c.stochK21]);
    return _crossAbove(stochKS, i, params.threshold ?? 20);
  }

  case 'stochrsi_cross_50':
    return _crossAbove(c.stochRsiK, i, 0.5);

  case 'stochrsi_exit_overs':
    return _crossAbove(c.stochRsiK, i, params.threshold ?? 0.2);

  case 'williams_exit_overs': {
    const wrS = _snap(params.period ?? 14, [7, 10, 14, 20, 28],
      [c.wr7, c.wr10, c.williamsR, c.wr20, c.wr28]);
    return _crossAbove(wrS, i, params.threshold ?? -80);
  }

  case 'cci_cross_zero': {
    const cciS = _snap(params.period ?? 20, [10, 14, 20, 25], [c.cci10, c.cci14, c.cci20, c.cci25]);
    return _crossAbove(cciS, i, 0);
  }

  case 'cci_exit_oversold': {
    const cciS = _snap(params.period ?? 20, [10, 14, 20, 25], [c.cci10, c.cci14, c.cci20, c.cci25]);
    return _crossAbove(cciS, i, params.threshold ?? -100);
  }

  case 'roc_cross_zero': {
    const rocSeries = _snap(params.period ?? 20, [10, 14, 20, 30], [c.roc10, c.roc14, c.roc20, c.roc30]);
    return _crossAbove(rocSeries, i, 0);
  }

  case 'cmo_cross_zero': {
    const cmoSeries = _snap(params.period ?? 14, [7, 9, 14, 21], [c.cmo7, c.cmo9, c.cmo14, c.cmo21]);
    return _crossAbove(cmoSeries, i, 0);
  }

  case 'tsi_cross_zero':
    return _crossAbove(c.tsi, i, 0);

  case 'tsi_cross_signal':
    if (i < 1 || !_nn(c.tsi[i]) || !_nn(c.tsiSignal[i])) return false;
    return c.tsi[i - 1] <= c.tsiSignal[i - 1] && c.tsi[i] > c.tsiSignal[i];

  case 'ppo_cross_zero':
    return _crossAbove(c.ppo, i, 0);

  case 'ppo_cross_signal':
    if (i < 1 || !_nn(c.ppo[i]) || !_nn(c.ppoSignal[i])) return false;
    return c.ppo[i - 1] <= c.ppoSignal[i - 1] && c.ppo[i] > c.ppoSignal[i];

  case 'ao_cross_zero':
    return _crossAbove(c.ao, i, 0);

  case 'ao_twin_peaks': {
    // Two sub-zero AO troughs, second trough higher than first
    if (i < 4 || !_nn(c.ao[i]) || c.ao[i] >= 0) return false;
    let trough2 = NaN, trough1 = NaN;
    for (let j = i - 1; j >= 2 && isNaN(trough1); j--) {
      if (!_nn(c.ao[j]) || c.ao[j] >= 0) continue;
      if (c.ao[j] < c.ao[j - 1] && c.ao[j] < (j + 1 <= i ? c.ao[j + 1] : Infinity)) {
        if (isNaN(trough2)) trough2 = c.ao[j]; else trough1 = c.ao[j];
      }
    }
    return !isNaN(trough2) && !isNaN(trough1) && trough2 > trough1;
  }

  case 'kst_cross_signal':
    if (i < 1 || !_nn(c.kst[i]) || !_nn(c.kstSignal[i])) return false;
    return c.kst[i - 1] <= c.kstSignal[i - 1] && c.kst[i] > c.kstSignal[i];

  case 'coppock_cross_zero':
    return _crossAbove(c.coppock, i, 0);

  case 'force_index_cross_0':
    return _crossAbove(c.forceIdx, i, 0);

  case 'dpo_cross_zero': {
    const dpoSeries = _snap(params.period ?? 20, [14, 20, 30], [c.dpo14, c.dpo, c.dpo30]);
    return _crossAbove(dpoSeries, i, 0);
  }

  case 'stc_turn_up':
    return _crossAbove(c.stc, i, params.threshold ?? 25);

  // ── SECTION 3: VOLUME ─────────────────────────────────────────────────────

  case 'obv_rising':
    return _nn(c.obvSlope[i]) && c.obvSlope[i] > 0;

  case 'obv_cross_sma':
    if (i < 1 || !_nn(c.obvArr[i]) || !_nn(c.obvSma20[i])) return false;
    return c.obvArr[i - 1] <= c.obvSma20[i - 1] && c.obvArr[i] > c.obvSma20[i];

  case 'vpt_rising':
    if (i < 2 || !_nn(c.vpt[i]) || !_nn(c.vpt[i - 1]) || !_nn(c.vpt[i - 2])) return false;
    return c.vpt[i] > c.vpt[i - 1] && c.vpt[i - 1] <= c.vpt[i - 2];

  case 'ad_line_rising':
    return _nn(c.adSlope[i]) && c.adSlope[i] > 0;

  case 'cmf_cross_zero':
    return _crossAbove(c.cmf20, i, 0);

  case 'chaikin_osc_cross_0':
    return _crossAbove(c.chaikinOsc, i, 0);

  case 'mfi_exit_oversold': {
    const mfiS = _snap(params.period ?? 14, [7, 10, 14, 20], [c.mfi7, c.mfi10, c.mfi14, c.mfi20]);
    return _crossAbove(mfiS, i, params.threshold ?? 20);
  }

  case 'mfi_cross_50': {
    const mfiS = _snap(params.period ?? 14, [7, 10, 14, 20], [c.mfi7, c.mfi10, c.mfi14, c.mfi20]);
    return _crossAbove(mfiS, i, 50);
  }

  case 'nvi_rising':
    return _nn(c.nvi[i]) && _nn(c.nviEma[i]) && c.nvi[i] > c.nviEma[i];

  case 'vwap_cross':
    if (i < 1 || !_nn(c.priceVsVwap[i])) return false;
    return c.priceVsVwap[i - 1] <= 0 && c.priceVsVwap[i] > 0;

  case 'volume_surge':
    return _nn(c.volumeRatio[i]) && c.volumeRatio[i] >= (params.multiplier ?? 2.0);

  // ── SECTION 4: VOLATILITY / BANDS ────────────────────────────────────────

  case 'bb_lower_touch':
    return _nn(c.bbPctB[i]) && c.bbPctB[i] <= (params.threshold ?? 0.05);

  case 'bb_squeeze_breakout':
    if (i < 1 || !_nn(c.close[i]) || !_nn(c.bbUpper[i])) return false;
    return c.bbSqueeze[i - 1] && c.close[i] > c.bbUpper[i];

  case 'bb_pct_b_cross_0_5':
    return _crossAbove(c.bbPctB, i, 0.5);

  case 'keltner_breakout':
    if (i < 1 || !_nn(c.close[i]) || !_nn(c.keltUpper[i])) return false;
    return c.close[i - 1] <= c.keltUpper[i - 1] && c.close[i] > c.keltUpper[i];

  case 'keltner_lower_touch':
    return _nn(c.close[i]) && _nn(c.keltLower[i]) && c.close[i] < c.keltLower[i];

  case 'atr_expansion': {
    const atrS = _snap(params.period ?? 14, [7, 10, 14, 20], [c.atr7, c.atr10, c.atr14, c.atr20]);
    if (i < 1 || !_nn(atrS[i]) || !_nn(atrS[i - 1])) return false;
    return atrS[i] > atrS[i - 1];
  }

  case 'ulcer_index_low': {
    if (!_nn(c.ulcerIdx[i])) return false;
    const hist = c.ulcerIdx.slice(Math.max(0, i - 252), i + 1).filter(_nn);
    if (hist.length < 30) return false;
    const sorted = [...hist].sort((a, b) => a - b);
    return c.ulcerIdx[i] <= sorted[Math.floor(sorted.length * 0.1)];
  }

  case 'bb_keltner_squeeze': {
    if (!_nn(c.bbUpper[i]) || !_nn(c.keltUpper[i])) return false;
    return (c.bbUpper[i] - c.bbLower[i]) < (c.keltUpper[i] - c.keltLower[i]);
  }

  // ── SECTION 5: PRICE STRUCTURE ────────────────────────────────────────────

  case 'high_52w_breakout':
    return _nn(c.pos52w[i]) && c.pos52w[i] >= (params.threshold ?? 98);

  case 'low_52w_bounce':
    return _nn(c.pos52w[i]) && c.pos52w[i] <= (params.threshold ?? 2);

  case 'higher_high_hl':
    return c.swingStruct[i] === 'HH_HL';

  // ── SECTION 6: BREADTH (per-ticker A/D) ──────────────────────────────────

  case 'ad_line_new_high': {
    const lb = Math.round(params.lookback ?? 20);
    if (i < lb || !_nn(c.adLine[i])) return false;
    const prevMax = Math.max(...c.adLine.slice(i - lb, i).filter(_nn));
    return c.adLine[i] > prevMax;
  }

  // ── SECTION 7: STATISTICAL ────────────────────────────────────────────────

  case 'linear_reg_slope_pos': {
    const lrSeries = _snap(params.period ?? 20, [10, 14, 20, 50], [c.lrSlope10, c.lrSlope14, c.lrSlope, c.lrSlope50]);
    return _nn(lrSeries[i]) && lrSeries[i] > 0;
  }

  case 'z_score_below_neg2': {
    const zSeries = _snap(params.period ?? 20, [10, 14, 20, 30], [c.zScore10, c.zScore14, c.zScore, c.zScore30]);
    return _nn(zSeries[i]) && zSeries[i] < (params.threshold ?? -2);
  }

  case 'hurst_above_0_5':
    return _nn(c.hurst[i]) && c.hurst[i] > (params.threshold ?? 0.5);

  case 'rsi_divergence_bull':
    return c.rsiDiv[i] === 'bullish';

  case 'macd_divergence_bull':
    return c.macdDiv[i] === 'bullish';

  case 'hv_percentile_low':
    return _nn(c.hvPct[i]) && c.hvPct[i] < (params.threshold ?? 20);

  case 'beta_high':
    return _nn(c.beta252[i]) && c.beta252[i] > (params.threshold ?? 1.2);

  default:
    return false;
  }
}
