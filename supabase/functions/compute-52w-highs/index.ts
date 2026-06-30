// StockVizor — 52-Week High/Low Backfill — Supabase Edge Function v2
// Deploy as: compute-52w-highs
//
// V2 NOTE: v1 used grouped-daily Polygon endpoint and hit WORKER_RESOURCE_LIMIT
// from accumulated JSON parsing across 252 calls. v2 uses per-ticker fetch
// (same pattern as ta-batch) which has tiny per-invocation memory footprint.
//
// WHAT IT DOES (this version):
//   Backfills high52/low52/pct_from_52h on rows in ta_cache that are still NULL.
//   Picks up to ~500 tickers per invocation, fetches each one's 252-day daily
//   bars, computes max(high)/min(low), upserts. Self-resumable: re-running
//   continues from where it left off (because completed rows already have
//   high52 populated and the WHERE high52 IS NULL filter excludes them).
//
// EXPECTED RUNTIME PER INVOCATION:
//   ~120-130 sec, processes 250-450 tickers depending on Polygon latency.
//
// FULL UNIVERSE BACKFILL:
//   ~5,300 tickers / ~300 per invocation = ~18 invocations = ~36 min
//   when fired every 2 minutes via pg_cron.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const POLYGON_BASE = 'https://api.polygon.io';
const POLYGON_KEY  = Deno.env.get('POLYGON_API_KEY') ?? '';
const SUPABASE_URL = 'https://hkamukkkkpqhdpcradau.supabase.co';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const MAX_RUNTIME_MS  = 130_000;   // 130s budget (Edge cap is 150s)
const FETCH_TIMEOUT_MS = 12_000;
const PER_TICKER_DELAY_MS = 70;    // Polygon-friendly throttle (matches ta-batch)
const PICK_BATCH_SIZE = 500;       // tickers to claim per invocation

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

Deno.serve(async (_req: Request) => {
  const startMs = Date.now();
  const log = (msg: string) =>
    console.log(`[52w-bf] +${Math.round((Date.now() - startMs) / 1000)}s · ${msg}`);

  if (!POLYGON_KEY)  return new Response('POLYGON_API_KEY not set', { status: 500 });
  if (!SUPABASE_KEY) return new Response('SUPABASE_SERVICE_ROLE_KEY not set', { status: 500 });

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Latest trading date in ta_cache
  const { data: dateRows } = await supabase
    .from('ta_cache')
    .select('trading_date')
    .order('trading_date', { ascending: false })
    .limit(1);
  const tradingDate = dateRows?.[0]?.trading_date;
  if (!tradingDate) {
    return new Response(JSON.stringify({ ok: false, error: 'No trading_date in ta_cache' }), { status: 500 });
  }
  log(`trading_date=${tradingDate}`);

  // Pick tickers still missing high52
  const { data: missing, error: pickErr } = await supabase
    .from('ta_cache')
    .select('ticker')
    .eq('trading_date', tradingDate)
    .is('high52', null)
    .limit(PICK_BATCH_SIZE);

  if (pickErr) {
    log(`ERROR picking tickers: ${pickErr.message}`);
    return new Response(JSON.stringify({ ok: false, error: pickErr.message }), { status: 500 });
  }

  if (!missing || missing.length === 0) {
    log('all tickers already have high52 — nothing to do');
    return new Response(JSON.stringify({
      ok: true,
      done: true,
      trading_date: tradingDate,
      message: 'All tickers have high52'
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  log(`picked ${missing.length} tickers needing high52 backfill`);

  // Compute lookback range (~252 trading days = ~370 calendar days)
  const fromObj = new Date(tradingDate + 'T12:00:00Z');
  fromObj.setUTCDate(fromObj.getUTCDate() - 370);
  const fromDate = fromObj.toISOString().slice(0, 10);

  const updates: any[] = [];
  let processed = 0;
  let failed = 0;
  let skipped = 0;

  for (const { ticker } of missing) {
    if (Date.now() - startMs > MAX_RUNTIME_MS - 15_000) {
      log(`time budget hit at ${processed} processed — flushing`);
      break;
    }

    try {
      const url =
        `${POLYGON_BASE}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/` +
        `${fromDate}/${tradingDate}?adjusted=true&sort=desc&limit=260&apiKey=${POLYGON_KEY}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

      if (r.status === 429) {
        await sleep(8_000);
        await sleep(PER_TICKER_DELAY_MS);
        skipped++;
        continue;
      }
      if (!r.ok) {
        failed++;
        await sleep(PER_TICKER_DELAY_MS);
        continue;
      }

      const data = await r.json();
      const bars = data?.results;
      if (!bars || !bars.length) {
        skipped++;
        await sleep(PER_TICKER_DELAY_MS);
        continue;
      }

      const win = Math.min(252, bars.length);
      let h52 = -Infinity;
      let l52 = Infinity;
      for (let i = 0; i < win; i++) {
        const b = bars[i];
        if (typeof b.h === 'number' && b.h > h52) h52 = b.h;
        if (typeof b.l === 'number' && b.l < l52) l52 = b.l;
      }
      const latestClose = bars[0].c;

      // SANITY GUARD: reject pre-reverse-split prices Polygon failed to adjust.
      // Real US stocks rarely fall more than 98% from peak; ratio > 50× signals
      // a missed corporate-action adjustment, not a legitimate drawdown.
      const dataLooksClean =
        isFinite(h52) && isFinite(l52) &&
        latestClose != null && latestClose > 0 &&
        h52 > 0 && l52 > 0 &&
        h52 <= latestClose * 50;
      if (!dataLooksClean) {
        skipped++;
        await sleep(PER_TICKER_DELAY_MS);
        continue;
      }

      const pctFromH = ((latestClose - h52) / h52) * 100;

      updates.push({
        ticker,
        trading_date: tradingDate,
        high52: Math.round(h52 * 10000) / 10000,
        low52:  Math.round(l52 * 10000) / 10000,
        pct_from_52h: Math.round(pctFromH * 10000) / 10000,
      });
      processed++;
    } catch (e) {
      failed++;
    }

    await sleep(PER_TICKER_DELAY_MS);
  }

  log(`fetched: processed=${processed} failed=${failed} skipped=${skipped}`);

  // Bulk upsert
  let upserted = 0;
  let upsertErrors = 0;
  const UPSERT_CHUNK = 100;
  for (let i = 0; i < updates.length; i += UPSERT_CHUNK) {
    const chunk = updates.slice(i, i + UPSERT_CHUNK);
    const { error } = await supabase
      .from('ta_cache')
      .upsert(chunk, { onConflict: 'ticker,trading_date' });
    if (error) {
      upsertErrors++;
      console.error('[52w-bf] upsert error:', error.message);
    } else {
      upserted += chunk.length;
    }
  }

  const elapsedSec = Math.round((Date.now() - startMs) / 1000);
  log(`COMPLETE elapsed=${elapsedSec}s upserted=${upserted}`);

  return new Response(JSON.stringify({
    ok: true,
    done: false,                         // more invocations needed if processed < missing.length
    trading_date: tradingDate,
    processed, failed, skipped,
    upserted, upsert_errors: upsertErrors,
    remaining_in_picked_batch: missing.length - processed,
    elapsed_sec: elapsedSec,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
});
