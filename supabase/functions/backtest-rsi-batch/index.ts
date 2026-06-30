// StockVizor — Batch RSI Cycle Backtest across multiple tickers
// Deploy as: backtest-rsi-batch
//
// Processes a CHUNK of tickers (default 25) per invocation, fetches Polygon
// bars ONCE per ticker, computes cycles for MULTIPLE rsiLen values from the
// same bar data, writes all results to rsi_cycles_results.
//
// Self-fires the next chunk before exiting (fire-and-forget chain).
// Stops when offset >= stopAt.
//
// URL: ?limit=25&offset=0&stopAt=1000&rsiLens=5,7&tf=4hour&years=4&lb=3&stop=10
//
// Universe: top tickers from ta_cache by dollar volume (price * avg_vol20),
// filtered to >= $5 price and >= 500K avg vol; sectors excluding 'ETF'.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const POLYGON_BASE = 'https://api.polygon.io';
const POLYGON_KEY  = Deno.env.get('POLYGON_API_KEY') ?? '';
const SUPABASE_URL = 'https://hkamukkkkpqhdpcradau.supabase.co';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const FN_URL       = `${SUPABASE_URL}/functions/v1/backtest-rsi-batch`;

const RULES = {
  OVERSOLD: 35,
  OVERBOUGHT: 65,
};

Deno.serve(async (req: Request) => {
  if (!POLYGON_KEY)  return errResp('POLYGON_API_KEY not set', 500);
  if (!SUPABASE_KEY) return errResp('SUPABASE_SERVICE_ROLE_KEY not set', 500);

  const t0 = Date.now();
  const url = new URL(req.url);
  const limit       = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '25', 10)));
  const offset      = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));
  const stopAt      = Math.max(1, parseInt(url.searchParams.get('stopAt') || '1000', 10));
  const rsiLens     = (url.searchParams.get('rsiLens') || '5,7').split(',').map(s => parseInt(s.trim(), 10)).filter(n => n >= 2 && n <= 50);
  const tfRaw       = url.searchParams.get('tf') || '4hour';
  const years       = Math.max(1, Math.min(10, parseFloat(url.searchParams.get('years') || '4')));
  const lookback    = Math.max(1, Math.min(20, parseInt(url.searchParams.get('lb') || '3', 10)));
  const stopLossPct = Math.max(0, Math.min(50, parseFloat(url.searchParams.get('stop') || '10')));
  const minPrice    = parseFloat(url.searchParams.get('minPrice') || '5');
  const minVol      = parseFloat(url.searchParams.get('minVol') || '500000');

  const tf = parseTf(tfRaw);
  if (!tf) return errResp(`Unrecognized tf: ${tfRaw}`, 400);
  if (rsiLens.length === 0) return errResp('No valid rsiLens', 400);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── 1. Pull universe (top tickers by dollar volume, ranked once) ──
  // We use the most recent ta_cache snapshot. Rank by price * avg_vol20 desc.
  const { data: latestRows, error: dtErr } = await supabase
    .from('ta_cache')
    .select('trading_date')
    .order('trading_date', { ascending: false })
    .limit(1);
  if (dtErr) return errResp(`ta_cache date query: ${dtErr.message}`, 500);
  const dt = latestRows?.[0]?.trading_date;
  if (!dt) return errResp('No ta_cache data', 500);

  const { data: rows, error: tkErr } = await supabase
    .from('ta_cache')
    .select('ticker,price,avg_vol20,sector')
    .eq('trading_date', dt)
    .gte('price', minPrice)
    .gte('avg_vol20', minVol)
    .limit(8000);
  if (tkErr) return errResp(`ta_cache query: ${tkErr.message}`, 500);

  const ranked = (rows || [])
    .filter(r => r.sector && r.sector !== 'ETF' && r.ticker)
    .map(r => ({ ticker: r.ticker as string, dv: (+r.price) * (+r.avg_vol20) }))
    .sort((a, b) => b.dv - a.dv);

  const totalUniverse = Math.min(stopAt, ranked.length);
  const chunk = ranked.slice(offset, Math.min(offset + limit, totalUniverse));

  if (chunk.length === 0) {
    return jsonResp({
      ok: true,
      done: true,
      offset, totalUniverse,
      duration_ms: Date.now() - t0,
      message: 'No more tickers to process',
    });
  }

  // ── 2. Process each ticker ──
  const today = new Date();
  const fromObj = new Date(today);
  fromObj.setDate(fromObj.getDate() - Math.round(years * 365));
  const fromDate = isoDate(fromObj);
  const toDate   = isoDate(today);

  const results: any[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const { ticker } of chunk) {
    try {
      // Fetch bars (paginated)
      const bars = await fetchPolygonBars(ticker, tf, fromDate, toDate);
      if (!bars || bars.length < 50) {
        results.push({ ticker, error: 'insufficient bars', bars: bars?.length || 0 });
        failed++;
        continue;
      }

      const closes = bars.map(b => b.c);
      const rsi14  = computeRSI(closes, 14);

      // For each requested rsiLen, compute cycles and write
      for (const rsiLen of rsiLens) {
        const rsiFast = computeRSI(closes, rsiLen);
        const cycles = computeCycles(bars, rsiFast, rsi14, lookback, stopLossPct);

        // Wipe and insert
        await supabase.from('rsi_cycles_results')
          .delete()
          .eq('ticker', ticker)
          .eq('timeframe', tfRaw)
          .eq('rsi_length', rsiLen);

        if (cycles.length > 0) {
          const records = cycles.map(c => ({
            ticker,
            timeframe: tfRaw,
            rsi_length: rsiLen,
            pivot_window: 5,
            trough_date: c.trough_date,
            trough_price: round4(c.trough_price),
            trough_rsi: round2(c.trough_rsi),
            crest_date: c.crest_date,
            crest_price: round4(c.crest_price),
            crest_rsi: round2(c.crest_rsi),
            profit_pct: round4(c.profit_pct),
            bars_held: c.bars_held,
          }));
          // Insert in chunks
          const CHUNK = 200;
          for (let i = 0; i < records.length; i += CHUNK) {
            await supabase.from('rsi_cycles_results').insert(records.slice(i, i + CHUNK));
          }
        }
      }

      results.push({ ticker, bars: bars.length });
      succeeded++;
    } catch (e: any) {
      results.push({ ticker, error: String(e?.message || e).slice(0, 200) });
      failed++;
    }
  }

  // ── 3. Self-fire next chunk if more work remaining ──
  const nextOffset = offset + limit;
  let chained = false;
  if (nextOffset < totalUniverse) {
    try {
      const nextUrl = new URL(FN_URL);
      nextUrl.searchParams.set('limit',   String(limit));
      nextUrl.searchParams.set('offset',  String(nextOffset));
      nextUrl.searchParams.set('stopAt',  String(stopAt));
      nextUrl.searchParams.set('rsiLens', rsiLens.join(','));
      nextUrl.searchParams.set('tf',      tfRaw);
      nextUrl.searchParams.set('years',   String(years));
      nextUrl.searchParams.set('lb',      String(lookback));
      nextUrl.searchParams.set('stop',    String(stopLossPct));
      nextUrl.searchParams.set('minPrice', String(minPrice));
      nextUrl.searchParams.set('minVol',   String(minVol));
      // Fire-and-forget. Use SUPABASE_KEY as bearer for self-call.
      fetch(nextUrl.toString(), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
      }).catch(() => {});
      chained = true;
    } catch {}
  }

  return jsonResp({
    ok: true,
    offset, limit, nextOffset, totalUniverse, chained,
    chunk_size: chunk.length, succeeded, failed,
    rsiLens, tfRaw, lookback, stopLossPct,
    duration_ms: Date.now() - t0,
    results: results.slice(0, 5),  // truncate response, full data in DB
  });
});

// ────────────────────────────────────────────────────────────────────────────
async function fetchPolygonBars(ticker: string, tf: { mult: number; span: string }, fromDate: string, toDate: string) {
  let allRaw: any[] = [];
  let nextUrl: string | null =
    `${POLYGON_BASE}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${tf.mult}/${tf.span}/` +
    `${fromDate}/${toDate}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_KEY}`;
  let pages = 0;
  const MAX_PAGES = 10;
  while (nextUrl && pages < MAX_PAGES) {
    const r = await fetch(nextUrl, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) break;
    const j = await r.json();
    if (Array.isArray(j?.results) && j.results.length > 0) {
      allRaw.push(...j.results);
    }
    nextUrl = j?.next_url ? `${j.next_url}&apiKey=${POLYGON_KEY}` : null;
    pages++;
    if (allRaw.length > 50_000) break;
  }
  if (allRaw.length === 0) return null;
  return allRaw.map(b => ({
    t: +b.t,
    iso: new Date(+b.t).toISOString(),
    o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v,
  }));
}

function computeCycles(bars: any[], rsiFast: number[], rsi14: number[], lookback: number, stopLossPct: number) {
  // Find extrema: Recovery-cross + OS/OB confirm + No-Falling-Knife
  type Extreme = { idx: number; type: 'trough' | 'crest'; rsi: number };
  const extrema: Extreme[] = [];
  for (let i = 16; i < bars.length; i++) {
    const rFast = rsiFast[i];
    const r14 = rsi14[i];
    const rFastPrev = rsiFast[i - 1];
    const r14Prev = rsi14[i - 1];
    if (!isFinite(rFast) || !isFinite(r14)) continue;
    if (!isFinite(rFastPrev) || !isFinite(r14Prev)) continue;
    if (rFast <= 0) continue;

    const fastCrossedAboveSlow = rFastPrev <= r14Prev && rFast > r14;
    const fastCrossedBelowSlow = rFastPrev >= r14Prev && rFast < r14;

    let wasOversold = false, wasOverbought = false;
    const start = Math.max(0, i - lookback);
    for (let k = start; k <= i; k++) {
      if (isFinite(rsiFast[k])) {
        if (rsiFast[k] < RULES.OVERSOLD) wasOversold = true;
        if (rsiFast[k] > RULES.OVERBOUGHT) wasOverbought = true;
      }
    }

    if (fastCrossedAboveSlow && wasOversold && rFast > RULES.OVERSOLD) {
      extrema.push({ idx: i, type: 'trough', rsi: rFast });
    } else if (fastCrossedBelowSlow && wasOverbought && rFast < RULES.OVERBOUGHT) {
      extrema.push({ idx: i, type: 'crest', rsi: rFast });
    }
  }

  // Pair trough → crest
  const cycles: any[] = [];
  let lookingFor: 'trough' | 'crest' = 'trough';
  let cur: any = null;
  for (const e of extrema) {
    if (e.type !== lookingFor) continue;
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

  // Build records with stop-loss applied
  const stopFrac = stopLossPct / 100;
  return cycles.map(c => {
    const tBar = bars[c.trough_idx];
    const cBar = bars[c.crest_idx];
    const stopPrice = stopFrac > 0 ? tBar.c * (1 - stopFrac) : -Infinity;
    let exitIdx = c.crest_idx, exitPrice = cBar.c, exitDate = cBar.iso, exitRsi = c.crest_rsi;
    if (stopFrac > 0) {
      for (let k = c.trough_idx + 1; k <= c.crest_idx; k++) {
        const b = bars[k];
        if (b.l <= stopPrice) {
          exitIdx = k;
          exitPrice = stopPrice;
          exitDate = b.iso;
          exitRsi = isFinite(rsiFast[k]) ? rsiFast[k] : 0;
          break;
        }
      }
    }
    const profit = ((exitPrice - tBar.c) / tBar.c) * 100;
    return {
      trough_date: tBar.iso,
      trough_price: tBar.c,
      trough_rsi: c.trough_rsi,
      crest_date: exitDate,
      crest_price: exitPrice,
      crest_rsi: exitRsi,
      profit_pct: profit,
      bars_held: exitIdx - c.trough_idx,
    };
  });
}

function parseTf(s: string): { mult: number; span: string } | null {
  const map: Record<string, { mult: number; span: string }> = {
    '1hour': { mult: 1, span: 'hour' },
    '2hour': { mult: 2, span: 'hour' },
    '4hour': { mult: 4, span: 'hour' },
    '1day':  { mult: 1, span: 'day' },
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
