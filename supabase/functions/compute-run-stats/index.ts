// StockVizor — Nightly Run-Duration Stats Pre-warmer
// Deploy: supabase functions deploy compute-run-stats --use-api
//
// Trigger: nightly pg_cron or manual POST (no JWT required)
// What it does:
//   1. Queries liquidity_history for the distinct tickers updated in the past
//      7 days (i.e. active tickers that have fresh data).
//   2. Calls the Worker /api/run-stats?ticker=X&refresh=1 for each one,
//      which recomputes the run-duration percentiles from DB and writes the
//      result to Cloudflare KV with a 24-hour TTL.
//   3. Returns a summary: how many tickers were processed and any errors.
//
// This keeps the KV cache warm so the first user of the day gets sub-1ms
// stats rather than waiting for an on-demand DB query.

const WORKER_BASE  = Deno.env.get('WORKER_BASE_URL') ?? 'https://stockvizor.com';
const WORKER_TOKEN = Deno.env.get('WORKER_BATCH_TOKEN') ?? '';   // optional auth header
const SUPA_URL     = 'https://hkamukkkkpqhdpcradau.supabase.co';
const SUPA_KEY     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// How many days back to look for "active" tickers
const ACTIVE_WINDOW_DAYS = 7;
// Max concurrent Worker calls (stay polite)
const CONCURRENCY = 8;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (!SUPA_KEY) return jerr('SUPABASE_SERVICE_ROLE_KEY not set');

  const t0 = Date.now();

  // ── 1. Find recently-active tickers ────────────────────────────────────────
  const sinceDate = new Date(Date.now() - ACTIVE_WINDOW_DAYS * 86400_000)
    .toISOString().slice(0, 10);

  const listUrl = `${SUPA_URL}/rest/v1/liquidity_history`
    + `?trading_date=gte.${sinceDate}`
    + `&select=ticker`
    + `&limit=2000`;

  const listResp = await fetch(listUrl, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });

  if (!listResp.ok) {
    return jerr(`DB list failed: ${listResp.status}`);
  }

  const rows: { ticker: string }[] = await listResp.json();
  const tickers = [...new Set(rows.map(r => r.ticker).filter(Boolean))].sort();

  if (!tickers.length) {
    return jres({ ok: true, tickers: 0, elapsed_ms: Date.now() - t0, msg: 'No active tickers found' });
  }

  // ── 2. Call Worker /api/run-stats?ticker=X&refresh=1 in batches ────────────
  const errors: { ticker: string; error: string }[] = [];
  let succeeded = 0;

  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(t => warmRunStats(t)),
    );
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled' && r.value.ok) {
        succeeded++;
      } else {
        const reason = r.status === 'rejected'
          ? String(r.reason)
          : `HTTP ${(r.value as Response).status}`;
        errors.push({ ticker: batch[j], error: reason });
      }
    }
    // Tiny pause between batches to avoid hammering the Worker
    if (i + CONCURRENCY < tickers.length) {
      await new Promise(res => setTimeout(res, 200));
    }
  }

  return jres({
    ok:          true,
    tickers:     tickers.length,
    succeeded,
    failed:      errors.length,
    errors:      errors.slice(0, 20),   // cap error list
    elapsed_ms:  Date.now() - t0,
  });
});

async function warmRunStats(ticker: string): Promise<Response> {
  const url = `${WORKER_BASE}/api/run-stats?ticker=${encodeURIComponent(ticker)}&refresh=1`;
  const headers: Record<string, string> = { 'User-Agent': 'StockVizor-Batch/1.0' };
  if (WORKER_TOKEN) headers['X-Batch-Token'] = WORKER_TOKEN;
  return fetch(url, { headers });
}

function jres(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function jerr(msg: string, status = 500) {
  return jres({ ok: false, error: msg }, status);
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
}
