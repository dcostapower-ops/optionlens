// ═══════════════════════════════════════════════════════════════════
// StockVizor — quote-fan-out Edge Function
// ═══════════════════════════════════════════════════════════════════
// Purpose: Fetch latest snapshots for ticker-tape symbols (47 stocks +
//          10 commodity ETFs from Massive, 10 crypto from CoinGecko)
//          and UPSERT into quote_cache.
// Schedule: every 15 minutes (market hours), hourly off-hours
// Auth:    invoked via service_role key (cron) — verify_jwt = false
// ═══════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const POLYGON_BASE = 'https://api.polygon.io';
const POLYGON_KEY  = Deno.env.get('POLYGON_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Symbol universe (locked: must match dashboard.html ticker tape) ──
const STOCKS: string[] = [
  'AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','AVGO','NFLX','AMD',
  'JPM','BAC','GS','V','MA','WMT','HD','JNJ','UNH','PFE',
  'MRK','BA','CAT','HON','KO','PEP','MCD','NKE','DIS','BRK.B',
  'ORCL','CRM','ADBE','CSCO','INTC','QCOM','TXN','COST','MU','PYPL',
  'UBER','COIN','SHOP','XYZ','XLK','XLF','XLE','XLV','XLY',
];

const COMMODITY_ETFS: string[] = [
  'GLD','SLV','GDX','USO','UNG','TLT','IEF','SHY','DBA','UUP',
];

// CoinGecko crypto: { coingecko_id, display_symbol }
const CRYPTOS: { id: string; symbol: string }[] = [
  { id: 'bitcoin',     symbol: 'BTC'  },
  { id: 'ethereum',    symbol: 'ETH'  },
  { id: 'solana',      symbol: 'SOL'  },
  { id: 'binancecoin', symbol: 'BNB'  },
  { id: 'ripple',      symbol: 'XRP'  },
  { id: 'cardano',     symbol: 'ADA'  },
  { id: 'dogecoin',    symbol: 'DOGE' },
  { id: 'avalanche-2', symbol: 'AVAX' },
  { id: 'chainlink',   symbol: 'LINK' },
  { id: 'polkadot',    symbol: 'DOT'  },
];

interface UpsertRow {
  symbol: string;
  asset_class: 'stock' | 'etf' | 'commodity_etf' | 'crypto';
  last_price: number | null;
  prev_close: number | null;
  change_abs: number | null;
  change_pct: number | null;
  day_volume: number | null;
  day_high: number | null;
  day_low: number | null;
  data_source: string;
  fetched_at: string;
  data_as_of: string | null;
  updated_at: string;
}

function nowIso() { return new Date().toISOString(); }

// ── Fetch stocks + commodity ETFs from Massive snapshot bulk ──
async function fetchStocksFromMassive(): Promise<{ rows: UpsertRow[]; failed: string[]; error?: string }> {
  const tickers = [...STOCKS, ...COMMODITY_ETFS];
  const tickersParam = tickers.join(',');
  const url = `${POLYGON_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${encodeURIComponent(tickersParam)}&apiKey=${POLYGON_KEY}`;

  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'StockVizor/1.0' } });
    if (!r.ok) {
      const txt = await r.text();
      return { rows: [], failed: tickers, error: `HTTP ${r.status}: ${txt.slice(0, 200)}` };
    }
    const j = await r.json();
    const tickerArr = j?.tickers ?? [];
    const fetched = nowIso();
    const rows: UpsertRow[] = [];
    const seenSymbols = new Set<string>();

    for (const t of tickerArr) {
      const sym = t.ticker;
      if (!sym) continue;
      seenSymbols.add(sym);

      const day = t.day ?? {};
      const prev = t.prevDay ?? {};
      // On weekends/holidays, day.c is 0 because there's no trading session today.
      // In that case, fall back to prev.c (Friday's close). data_as_of reflects the
      // actual data timestamp regardless.
      const dayHasData    = (day.c ?? 0) > 0;
      const last_price    = dayHasData ? day.c : (prev.c ?? null);
      const prev_close    = dayHasData ? (prev.c ?? null) : (prev.o ?? null);
      const change_abs    = dayHasData ? (t.todaysChange ?? null) : 0;
      const change_pct    = dayHasData ? (t.todaysChangePerc ?? null) : 0;
      const day_volumeRaw = dayHasData ? day.v : prev.v;
      const day_volume    = day_volumeRaw != null ? Math.trunc(Number(day_volumeRaw)) : null;
      const day_high      = dayHasData ? (day.h ?? null) : (prev.h ?? null);
      const day_low       = dayHasData ? (day.l ?? null) : (prev.l ?? null);
      // 'updated' is nanoseconds since epoch — represents the most recent quote
      const data_as_of    = t.updated ? new Date(Math.floor(t.updated / 1e6)).toISOString() : null;

      const isCommodity = COMMODITY_ETFS.includes(sym);
      rows.push({
        symbol: sym,
        asset_class: isCommodity ? 'commodity_etf' : 'stock',
        last_price, prev_close, change_abs, change_pct,
        day_volume, day_high, day_low,
        data_source: 'massive',
        fetched_at: fetched,
        data_as_of,
        updated_at: fetched,
      });
    }

    const failed = tickers.filter(t => !seenSymbols.has(t));
    return { rows, failed };
  } catch (e) {
    return { rows: [], failed: tickers, error: String(e).slice(0, 200) };
  }
}

// ── Fetch crypto from CoinGecko free tier ──
async function fetchCryptoFromCoinGecko(): Promise<{ rows: UpsertRow[]; failed: string[]; error?: string }> {
  const ids = CRYPTOS.map(c => c.id).join(',');
  // include_24hr_change for change_pct; include_last_updated_at for data_as_of
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true&include_24hr_vol=true`;

  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'StockVizor/1.0', 'Accept': 'application/json' } });
    if (!r.ok) {
      const txt = await r.text();
      return { rows: [], failed: CRYPTOS.map(c => c.symbol), error: `CoinGecko HTTP ${r.status}: ${txt.slice(0, 200)}` };
    }
    const j = await r.json();
    const fetched = nowIso();
    const rows: UpsertRow[] = [];
    const failed: string[] = [];

    for (const c of CRYPTOS) {
      const data = j[c.id];
      if (!data) {
        failed.push(c.symbol);
        continue;
      }
      const last_price  = data.usd ?? null;
      const change_pct  = data.usd_24h_change ?? null;
      // For prev_close, derive from last_price + change_pct
      const prev_close  = (last_price != null && change_pct != null)
        ? last_price / (1 + change_pct / 100)
        : null;
      const change_abs  = (last_price != null && prev_close != null) ? last_price - prev_close : null;
      const day_volume  = data.usd_24h_vol != null ? Math.trunc(Number(data.usd_24h_vol)) : null;
      const data_as_of  = data.last_updated_at ? new Date(data.last_updated_at * 1000).toISOString() : null;

      rows.push({
        symbol: c.symbol,
        asset_class: 'crypto',
        last_price, prev_close, change_abs, change_pct,
        day_volume,
        day_high: null, day_low: null,
        data_source: 'coingecko',
        fetched_at: fetched,
        data_as_of,
        updated_at: fetched,
      });
    }

    return { rows, failed };
  } catch (e) {
    return { rows: [], failed: CRYPTOS.map(c => c.symbol), error: String(e).slice(0, 200) };
  }
}

// ── Health logging ──
async function recordHealth(opts: {
  attempted: number;
  updated: number;
  failed: number;
  durationMs: number;
  error?: string;
}) {
  let status = 'healthy';
  if (opts.updated === 0) status = 'failed';
  else if (opts.failed > 0) status = 'partial';

  await supabase.from('cache_health').upsert({
    cache_name: 'quote_cache',
    last_run_at: nowIso(),
    last_success_at: opts.updated > 0 ? nowIso() : null,
    symbols_attempted: opts.attempted,
    symbols_updated: opts.updated,
    symbols_failed: opts.failed,
    duration_ms: opts.durationMs,
    last_error: opts.error ?? null,
    status,
    updated_at: nowIso(),
  }, { onConflict: 'cache_name' });
}

// ── Main handler ──
Deno.serve(async (req) => {
  const t0 = Date.now();
  const url = new URL(req.url);
  const debugSym = url.searchParams.get('debug');

  if (!POLYGON_KEY) {
    await recordHealth({ attempted: 0, updated: 0, failed: STOCKS.length + COMMODITY_ETFS.length + CRYPTOS.length, durationMs: 0, error: 'POLYGON_API_KEY not set' });
    return new Response(JSON.stringify({ ok: false, error: 'POLYGON_API_KEY not set' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  if (!SUPABASE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY not set' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  // Debug mode: just dump raw response for one ticker — does not write to DB
  if (debugSym) {
    const dbgUrl = `${POLYGON_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${encodeURIComponent(debugSym)}&apiKey=${POLYGON_KEY}`;
    const r = await fetch(dbgUrl, { headers: { 'User-Agent': 'StockVizor/1.0' } });
    const j = await r.json();
    return new Response(JSON.stringify({ debug: debugSym, polygon_response: j }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Run both fetches in parallel
  const [massive, coingecko] = await Promise.all([
    fetchStocksFromMassive(),
    fetchCryptoFromCoinGecko(),
  ]);

  const allRows = [...massive.rows, ...coingecko.rows];
  const allFailed = [...massive.failed, ...coingecko.failed];

  const errors: string[] = [];
  if (massive.error) errors.push('massive: ' + massive.error);
  if (coingecko.error) errors.push('coingecko: ' + coingecko.error);

  let upsertError: string | undefined;
  if (allRows.length > 0) {
    const { error } = await supabase
      .from('quote_cache')
      .upsert(allRows, { onConflict: 'symbol' });
    if (error) upsertError = 'upsert: ' + error.message;
  }

  const dur = Date.now() - t0;
  const totalAttempted = STOCKS.length + COMMODITY_ETFS.length + CRYPTOS.length;
  await recordHealth({
    attempted: totalAttempted,
    updated: upsertError ? 0 : allRows.length,
    failed: upsertError ? totalAttempted : allFailed.length,
    durationMs: dur,
    error: upsertError ?? (errors.length > 0 ? errors.join(' | ') : undefined),
  });

  return new Response(JSON.stringify({
    ok: !upsertError && allRows.length > 0,
    duration_ms: dur,
    summary: {
      attempted: totalAttempted,
      updated: upsertError ? 0 : allRows.length,
      failed: upsertError ? totalAttempted : allFailed.length,
    },
    breakdown: {
      stocks_etfs: { attempted: STOCKS.length + COMMODITY_ETFS.length, fetched: massive.rows.length, failed: massive.failed.length },
      crypto:      { attempted: CRYPTOS.length, fetched: coingecko.rows.length, failed: coingecko.failed.length },
    },
    failed_symbols: allFailed.slice(0, 20),
    errors: errors.length > 0 ? errors : undefined,
    upsert_error: upsertError,
  }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
