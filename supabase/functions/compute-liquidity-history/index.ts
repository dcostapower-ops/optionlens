// StockVizor — Daily Liquidity History Updater
// Deploy as: compute-liquidity-history (--no-verify-jwt)
//
// Runs once daily (cron-triggered or manual POST). Uses Polygon's "grouped daily"
// endpoint to get every US stock's OHLCV bar for a given date, then computes
// inflow (close ≥ open → v × close) and outflow (close < open → v × close),
// and batch-upserts into the liquidity_history table.
//
// URL params:
//   ?date=YYYY-MM-DD   — override date (defaults to most recent trading day)
//   ?force=1            — re-upsert even if data already exists for this date
//
// Filters: price ≥ $1, volume ≥ 100,000 shares (to skip illiquid junk)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://hkamukkkkpqhdpcradau.supabase.co';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const POLY_KEY     = Deno.env.get('POLYGON_API_KEY') ?? Deno.env.get('POLYGON_KEY') ?? '';

const MIN_PRICE  = 1.0;
const MIN_VOL    = 100_000;
const BATCH_SIZE = 200;

Deno.serve(async (req: Request) => {
  if (!SUPABASE_KEY) return jerr('SUPABASE_SERVICE_ROLE_KEY not set');
  if (!POLY_KEY)     return jerr('POLYGON_KEY not set');

  const t0  = Date.now();
  const url = new URL(req.url);

  // Default to yesterday (most recent completed trading day)
  const targetDate = url.searchParams.get('date')
    ?? new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const force = url.searchParams.get('force') === '1';

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── 1. Skip if we already have rows for this date (unless forced) ─────────
  if (!force) {
    const { count } = await supabase
      .from('liquidity_history')
      .select('*', { count: 'exact', head: true })
      .eq('trading_date', targetDate);
    if ((count ?? 0) > 100) {
      return jres({ ok: true, skipped: true, reason: 'Data already exists; pass ?force=1 to override', date: targetDate, count });
    }
  }

  // ── 2. Fetch Polygon grouped daily bars ──────────────────────────────────
  const polyUrl = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${targetDate}?adjusted=true&apiKey=${POLY_KEY}`;
  const polyResp = await fetch(polyUrl, { headers: { 'User-Agent': 'StockVizor/1.0' } });
  if (!polyResp.ok) {
    const errText = await polyResp.text().catch(() => '');
    return jerr(`Polygon ${polyResp.status}: ${errText.slice(0, 200)}`);
  }
  const pj = await polyResp.json();
  const allBars: any[] = (pj.results ?? []);

  // ── 3. Filter + compute inflow/outflow ───────────────────────────────────
  const rows: any[] = [];
  for (const b of allBars) {
    if (!b.T || !b.c || !b.o || !b.v) continue;          // bad data
    if (b.c < MIN_PRICE || b.v < MIN_VOL) continue;      // too small
    const dv      = b.v * b.c;
    const inflow  = b.c >= b.o ? dv : 0;
    const outflow = b.c <  b.o ? dv : 0;
    const net     = inflow - outflow;
    rows.push({
      ticker:       b.T.toUpperCase(),
      trading_date: targetDate,
      inflow,
      outflow,
      net,
      inflow_pct:  Math.round((inflow  / (dv || 1)) * 10000) / 100,
      outflow_pct: Math.round((outflow / (dv || 1)) * 10000) / 100,
    });
  }

  if (!rows.length) {
    return jres({ ok: true, date: targetDate, count: 0, note: 'No qualifying bars (likely weekend/holiday)' });
  }

  // ── 4. Batch upsert (200 rows per request) ───────────────────────────────
  let upserted = 0, failed = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('liquidity_history')
      .upsert(chunk, { onConflict: 'ticker,trading_date' });
    if (error) { failed += chunk.length; }
    else        { upserted += chunk.length; }
  }

  return jres({
    ok: true,
    date: targetDate,
    raw_bars: allBars.length,
    qualifying: rows.length,
    upserted,
    failed,
    duration_ms: Date.now() - t0,
  });
});

function jres(b: any, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
}
function jerr(msg: string, s = 500) { return jres({ ok: false, error: msg }, s); }
