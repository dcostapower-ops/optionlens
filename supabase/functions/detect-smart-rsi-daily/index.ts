// StockVizor — Smart RSI daily detection
// Deploy as: detect-smart-rsi-daily (--no-verify-jwt)
//
// Runs once per day around 09:00 ET. Loops the top 1000 tickers (by dollar
// volume in ta_cache, same universe as backtest-rsi-batch). For each ticker,
// fetches recent 4-hour bars, runs the Smart RSI Recovery-Cross algorithm,
// and sets smart_rsi_7_fired / smart_rsi_5_fired in ta_cache if a fresh
// entry signal fired within the last 6 four-hour bars (~24 hours window).
//
// URL params (optional):
//   ?limit=30&offset=0  → chunked processing for self-chaining
//   ?stopAt=1000        → cap of tickers to process
//   ?window=6           → fire window (bars to check)
//
// The function self-chains the next chunk via fire-and-forget HTTP POST so
// a single trigger processes the entire universe in ~30 minutes.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const POLYGON_BASE = 'https://api.polygon.io';
const POLYGON_KEY  = Deno.env.get('POLYGON_API_KEY') ?? '';
const SUPABASE_URL = 'https://hkamukkkkpqhdpcradau.supabase.co';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const FN_URL       = `${SUPABASE_URL}/functions/v1/detect-smart-rsi-daily`;

// Backtested-locked rule parameters
const RULES = {
  OVERSOLD: 35,
  OVERBOUGHT: 65,
  LOOKBACK: 3,        // bars to check for recent oversold touch
  RSI_7: 7,           // fast RSI for Smart RSI** strategy
  RSI_5: 5,           // fast RSI for Smart RSI* strategy
  RSI_SLOW: 14,       // slow RSI (reference line both fasts cross)
  FIRE_WINDOW: 6,     // recent N bars to consider a fire still active
};

Deno.serve(async (req: Request) => {
  if (!POLYGON_KEY)  return jerr('POLYGON_API_KEY not set');
  if (!SUPABASE_KEY) return jerr('SUPABASE_SERVICE_ROLE_KEY not set');

  const t0 = Date.now();
  const url = new URL(req.url);
  const limit    = clamp(parseInt(url.searchParams.get('limit')  || '25', 10), 1, 50);
  const offset   = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));
  const stopAt   = Math.max(1, parseInt(url.searchParams.get('stopAt') || '1000', 10));
  const fireWin  = clamp(parseInt(url.searchParams.get('window') || String(RULES.FIRE_WINDOW), 10), 1, 20);
  const minPrice = parseFloat(url.searchParams.get('minPrice') || '5');
  const minVol   = parseFloat(url.searchParams.get('minVol')   || '500000');

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── 1. Pull universe (top tickers by dollar volume) ─────────────────────
  const { data: latestRows, error: dtErr } = await supabase
    .from('ta_cache')
    .select('trading_date')
    .order('trading_date', { ascending: false })
    .limit(1);
  if (dtErr) return jerr(`ta_cache date query: ${dtErr.message}`);
  const dt = latestRows?.[0]?.trading_date;
  if (!dt) return jerr('No ta_cache data');

  const { data: rows, error: tkErr } = await supabase
    .from('ta_cache')
    .select('ticker,price,avg_vol20,sector')
    .eq('trading_date', dt)
    .gte('price', minPrice)
    .gte('avg_vol20', minVol)
    .limit(8000);
  if (tkErr) return jerr(`ta_cache query: ${tkErr.message}`);

  const ranked = (rows || [])
    .filter(r => r.sector && r.sector !== 'ETF' && r.ticker)
    .map(r => ({ ticker: r.ticker as string, dv: (+r.price) * (+r.avg_vol20) }))
    .sort((a, b) => b.dv - a.dv);

  const totalUniverse = Math.min(stopAt, ranked.length);
  const chunk = ranked.slice(offset, Math.min(offset + limit, totalUniverse));

  if (chunk.length === 0) {
    return jres({
      ok: true, done: true, offset, totalUniverse,
      duration_ms: Date.now() - t0,
    });
  }

  // ── 2. Date range: fetch enough 4-hour bars to compute RSI cleanly ──────
  // Need ~30 bars for RSI to stabilize + the fire window.
  // 4-hour bars in extended hours = ~6/day, so 14 days = ~84 bars is plenty.
  const today = new Date();
  const fromObj = new Date(today);
  fromObj.setDate(fromObj.getDate() - 30);  // 30 days of 4h bars (~180 bars)
  const fromDate = isoDate(fromObj);
  const toDate   = isoDate(today);

  const results: any[] = [];
  let succeeded = 0, failed = 0, fired7 = 0, fired5 = 0;

  for (const { ticker } of chunk) {
    try {
      const bars = await fetchPolygonBars(ticker, fromDate, toDate);
      if (!bars || bars.length < 30) {
        results.push({ ticker, error: 'insufficient bars', bars: bars?.length || 0 });
        failed++;
        continue;
      }
      const closes = bars.map(b => b.c);
      const rsi14 = computeRSI(closes, RULES.RSI_SLOW);
      const rsi7  = computeRSI(closes, RULES.RSI_7);
      const rsi5  = computeRSI(closes, RULES.RSI_5);

      // Detect FIRES on the most recent `fireWin` bars
      const fires7 = detectEntryFires(bars, rsi7, rsi14, RULES.LOOKBACK, fireWin);
      const fires5 = detectEntryFires(bars, rsi5, rsi14, RULES.LOOKBACK, fireWin);

      const hit7 = fires7.length > 0;
      const hit5 = fires5.length > 0;
      const at7  = hit7 ? new Date(fires7[fires7.length - 1].time).toISOString() : null;
      const at5  = hit5 ? new Date(fires5[fires5.length - 1].time).toISOString() : null;

      // Write to ta_cache for today's row
      await supabase.from('ta_cache')
        .update({
          smart_rsi_7_fired: hit7,
          smart_rsi_5_fired: hit5,
          smart_rsi_7_fired_at: at7,
          smart_rsi_5_fired_at: at5,
        })
        .eq('ticker', ticker)
        .eq('trading_date', dt);

      if (hit7) fired7++;
      if (hit5) fired5++;
      results.push({ ticker, hit7, hit5, bars: bars.length });
      succeeded++;
    } catch (e: any) {
      results.push({ ticker, error: String(e?.message || e).slice(0, 200) });
      failed++;
    }
  }

  // ── 3. Self-fire next chunk ─────────────────────────────────────────────
  const nextOffset = offset + limit;
  let chained = false;
  if (nextOffset < totalUniverse) {
    try {
      const nextUrl = new URL(FN_URL);
      nextUrl.searchParams.set('limit',  String(limit));
      nextUrl.searchParams.set('offset', String(nextOffset));
      nextUrl.searchParams.set('stopAt', String(stopAt));
      nextUrl.searchParams.set('window', String(fireWin));
      fetch(nextUrl.toString(), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      }).catch(() => {});
      chained = true;
    } catch {}
  }

  return jres({
    ok: true,
    offset, limit, nextOffset, totalUniverse, chained,
    chunk_size: chunk.length, succeeded, failed,
    fired7, fired5,
    duration_ms: Date.now() - t0,
    sample_results: results.slice(0, 5),
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SHARED ALGORITHM (locked to the backtested rule from backtest-rsi-batch)
// ────────────────────────────────────────────────────────────────────────────

// Returns array of bar indexes where an entry signal fired within the last
// `fireWin` bars. The rule (same as the 65.2%/PF 2.04 backtested winner):
//   - prev bar: rsi_fast <= rsi_slow (fast was at/below slow)
//   - this bar: rsi_fast >  rsi_slow (crossed above)
//   - rsi_fast touched < OVERSOLD within last `lookback` bars
//   - rsi_fast > OVERSOLD at this bar (no-falling-knife filter)
function detectEntryFires(bars: any[], rsiFast: number[], rsiSlow: number[], lookback: number, fireWin: number) {
  const fires: { time: number; idx: number; rsi: number }[] = [];
  const startIdx = Math.max(16, bars.length - fireWin);
  for (let i = startIdx; i < bars.length; i++) {
    const rFast = rsiFast[i];
    const r14   = rsiSlow[i];
    const rFastPrev = rsiFast[i - 1];
    const r14Prev   = rsiSlow[i - 1];
    if (!isFinite(rFast) || !isFinite(r14)) continue;
    if (!isFinite(rFastPrev) || !isFinite(r14Prev)) continue;

    // Cross condition
    const crossedAbove = rFastPrev <= r14Prev && rFast > r14;
    if (!crossedAbove) continue;

    // Recent oversold touch
    let wasOversold = false;
    const start = Math.max(0, i - lookback);
    for (let k = start; k <= i; k++) {
      if (isFinite(rsiFast[k]) && rsiFast[k] < RULES.OVERSOLD) { wasOversold = true; break; }
    }
    if (!wasOversold) continue;

    // No-falling-knife: must have cleared oversold
    if (rFast <= RULES.OVERSOLD) continue;

    fires.push({ time: bars[i].t, idx: i, rsi: rFast });
  }
  return fires;
}

async function fetchPolygonBars(ticker: string, fromDate: string, toDate: string) {
  let allRaw: any[] = [];
  let nextUrl: string | null =
    `${POLYGON_BASE}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/4/hour/` +
    `${fromDate}/${toDate}?adjusted=true&sort=asc&limit=5000&apiKey=${POLYGON_KEY}`;
  let pages = 0;
  while (nextUrl && pages < 4) {
    const r = await fetch(nextUrl, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) break;
    const j = await r.json();
    if (Array.isArray(j?.results) && j.results.length > 0) allRaw.push(...j.results);
    nextUrl = j?.next_url ? `${j.next_url}&apiKey=${POLYGON_KEY}` : null;
    pages++;
    if (allRaw.length > 5000) break;
  }
  if (allRaw.length === 0) return null;
  return allRaw.map(b => ({ t: +b.t, o:+b.o, h:+b.h, l:+b.l, c:+b.c, v:+b.v }));
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
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function jres(b: any, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }); }
function jerr(msg: string, s = 500) { return jres({ ok: false, error: msg }, s); }
