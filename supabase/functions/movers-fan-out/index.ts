// ═══════════════════════════════════════════════════════════════════
// StockVizor — movers-fan-out Edge Function
// ═══════════════════════════════════════════════════════════════════
// Purpose: Every 15 min, identify top 10 gainers + 10 losers split by
//          stocks (CS/ADR) vs ETFs. For each, attach signal score,
//          descriptive label, 10-day sparkline, and indicator readings.
//
// Logic:
//   1. Read ta_ticker_universe (~3,983 liquid US symbols)
//   2. Bulk snapshot for those symbols
//   3. Join to ticker_reference for asset_type (stock vs ETF split)
//   4. Filter: must have today's dollar volume >= $5M (runtime liquidity)
//   5. Rank by today's change_pct (or Friday's if weekend)
//   6. Top 10 gainers + 10 losers per kind = 40 rows
//   7. For each: fetch 10-day daily aggs (sparkline), compute signal_score
//      and signal_label from ta_cache indicators
//   8. UPSERT to top_movers_cache (kind, rank as PK)
//
// Schedule: every 15 min
// ═══════════════════════════════════════════════════════════════════
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const POLYGON_BASE = 'https://api.polygon.io';
const POLYGON_KEY = Deno.env.get('POLYGON_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const STOCK_TYPES = new Set([
  'CS',
  'ADRC',
  'ADRP',
  'ADRR'
]); // ETF excluded
const ETF_TYPES = new Set([
  'ETF'
]);
const MIN_TODAY_DOLLAR_VOLUME = 5_000_000;
const TOP_N = 10;
// ── Fetch the universe ──
async function loadUniverse() {
  const { data } = await supabase.from('app_config').select('value').eq('key', 'ta_ticker_universe').limit(1);
  if (!data?.length) return [];
  const raw = data[0].value;
  const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(arr) ? arr : [];
}
// ── Bulk snapshots ──
async function bulkSnapshots(symbols) {
  const out = new Map();
  const CHUNK = 200;
  for(let i = 0; i < symbols.length; i += CHUNK){
    const chunk = symbols.slice(i, i + CHUNK);
    const url = `${POLYGON_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${chunk.join(',')}&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'StockVizor/1.0'
      }
    });
    if (!r.ok) continue;
    const j = await r.json();
    for (const t of j?.tickers ?? []){
      const sym = t.ticker;
      if (!sym) continue;
      const day = t.day ?? {};
      const prev = t.prevDay ?? {};
      const dayHasData = (day.c ?? 0) > 0;
      // Off-hours fallback: when today's snapshot is empty (pre-market / weekend / holiday),
      // show yesterday's full-day close-to-open move from prevDay as a useful proxy.
      // This prevents the dashboard from showing all-zeroes during off-hours.
      const offHoursChangeAbs = (prev.c ?? 0) > 0 && (prev.o ?? 0) > 0
        ? (prev.c - prev.o) : 0;
      const offHoursChangePct = (prev.c ?? 0) > 0 && (prev.o ?? 0) > 0
        ? ((prev.c - prev.o) / prev.o) * 100 : 0;
      const last_price = dayHasData ? day.c : prev.c ?? 0;
      const prev_close = dayHasData ? prev.c ?? 0 : prev.o ?? 0;
      const change_abs = dayHasData ? t.todaysChange ?? 0 : offHoursChangeAbs;
      const change_pct = dayHasData ? t.todaysChangePerc ?? 0 : offHoursChangePct;
      const day_volume_raw = dayHasData ? day.v : prev.v;
      const day_volume = day_volume_raw != null ? Math.trunc(Number(day_volume_raw)) : 0;
      const data_as_of = t.updated && t.updated > 0
        ? new Date(Math.floor(t.updated / 1e6)).toISOString()
        : (prev.t ? new Date(prev.t).toISOString() : null);
      if (last_price > 0) {
        out.set(sym, {
          symbol: sym,
          last_price,
          prev_close,
          change_abs,
          change_pct,
          day_volume,
          data_as_of,
          is_off_hours_fallback: !dayHasData,  // flag for downstream labeling
        });
      }
    }
  }
  return out;
}
// ── Fetch 10-day daily aggs for sparkline ──
async function fetch10DaySparkline(symbol) {
  // Last 20 calendar days to ensure we get 10 trading days
  const today = new Date();
  const past = new Date(today.getTime() - 20 * 24 * 60 * 60 * 1000);
  const fromDate = past.toISOString().slice(0, 10);
  const toDate = today.toISOString().slice(0, 10);
  const url = `${POLYGON_BASE}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=30&apiKey=${POLYGON_KEY}`;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'StockVizor/1.0'
      }
    });
    if (!r.ok) return [];
    const j = await r.json();
    const bars = j?.results ?? [];
    return bars.slice(-10).map((b)=>({
        d: new Date(b.t).toISOString().slice(0, 10),
        c: b.c
      }));
  } catch  {
    return [];
  }
}
// ── Load TA indicators from ta_cache (latest row per symbol) ──
async function loadTaIndicators(symbols) {
  const out = new Map();
  if (symbols.length === 0) return out;
  // Get latest trading_date row per symbol
  const { data, error } = await supabase.from('ta_cache').select('ticker, price, rsi, macd_h, vol_ratio, ema9, ema20, ema50, sma200, trading_date').in('ticker', symbols).order('trading_date', {
    ascending: false
  });
  if (error || !data) return out;
  // Pick latest per ticker
  for (const row of data){
    if (!out.has(row.ticker)) out.set(row.ticker, row);
  }
  return out;
}
// ── Compute signal score and label ──
function computeSignal(snap, ta, isGainer) {
  let score = 0;
  let rsi14 = null;
  let macd_hist = null;
  let vol_ratio = null;
  let ema_position = null;
  if (ta) {
    rsi14 = ta.rsi != null ? Number(ta.rsi) : null;
    macd_hist = ta.macd_h != null ? Number(ta.macd_h) : null;
    vol_ratio = ta.vol_ratio != null ? Number(ta.vol_ratio) : null;
    // Compute EMA position
    const price = Number(ta.price ?? 0);
    const ema50 = Number(ta.ema50 ?? 0);
    const sma200 = Number(ta.sma200 ?? 0);
    if (price > 0 && ema50 > 0 && sma200 > 0) {
      if (price > ema50 && ema50 > sma200) ema_position = 'above_50_200';
      else if (price < ema50 && ema50 < sma200) ema_position = 'below_50_200';
      else ema_position = 'mixed';
    }
    // RSI scoring (sweet spot for momentum is 50-70)
    if (rsi14 != null) {
      if (rsi14 > 70) score -= 15; // overbought = bearish for further upside
      else if (rsi14 >= 50 && rsi14 <= 70) score += 15; // healthy momentum
      else if (rsi14 < 30) score += 5; // oversold = bullish bounce setup
      else if (rsi14 >= 30 && rsi14 < 50) score -= 5; // weak momentum
    }
    // MACD scoring (positive histogram = bullish)
    if (macd_hist != null) {
      if (macd_hist > 0.5) score += 15;
      else if (macd_hist > 0) score += 8;
      else if (macd_hist < -0.5) score -= 15;
      else if (macd_hist < 0) score -= 8;
    }
    // Volume scoring
    if (vol_ratio != null) {
      if (vol_ratio > 2 && isGainer) score += 10; // strong vol with up day = continuation
      else if (vol_ratio > 2 && !isGainer) score -= 10; // strong vol with down day = capitulation
    }
    // EMA position
    if (ema_position === 'above_50_200') score += 20;
    else if (ema_position === 'below_50_200') score -= 20;
  }
  // Add directional bias from today's move (gainers tilted +, losers tilted -)
  if (isGainer) score += 15;
  else score -= 15;
  // Clip to -100..+100
  score = Math.max(-100, Math.min(100, Math.round(score)));
  // Derive label — unified vocabulary across product:
  // Strong Uptrend / Uptrend / Sideways / Downtrend / Strong Downtrend
  // Note: same label for ±0..29 ("sideways") regardless of which gainer/loser bucket.
  let signal_label;
  if (score >= 60)        signal_label = 'Strong Uptrend';
  else if (score >= 30)   signal_label = 'Uptrend';
  else if (score >= -29)  signal_label = 'Sideways';
  else if (score >= -59)  signal_label = 'Downtrend';
  else                    signal_label = 'Strong Downtrend';
  return {
    rsi14,
    macd_hist,
    vol_ratio,
    ema_position,
    signal_score: score,
    signal_label
  };
}
async function recordHealth(opts) {
  const status = opts.failed === 0 && opts.updated > 0 ? 'healthy' : opts.updated > 0 ? 'partial' : 'failed';
  await supabase.from('cache_health').upsert({
    cache_name: 'top_movers_cache',
    last_run_at: new Date().toISOString(),
    last_success_at: opts.updated > 0 ? new Date().toISOString() : null,
    symbols_attempted: opts.attempted,
    symbols_updated: opts.updated,
    symbols_failed: opts.failed,
    duration_ms: opts.durationMs,
    last_error: opts.error ?? null,
    status,
    updated_at: new Date().toISOString()
  }, {
    onConflict: 'cache_name'
  });
}
Deno.serve(async (_req)=>{
  const t0 = Date.now();
  if (!POLYGON_KEY || !SUPABASE_KEY) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'missing keys'
    }), {
      status: 500
    });
  }
  try {
    // 1. Load universe
    const universe = await loadUniverse();
    if (universe.length === 0) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'empty universe'
      }), {
        status: 500
      });
    }
    // 2. Bulk snapshots for entire universe
    const snapshots = await bulkSnapshots(universe);
    // 3. Get asset_type for each universe symbol from ticker_reference.
    // Chunk the .in() lookup since 3,983 symbols would overflow URL length.
    const refMap = new Map();
    const REF_CHUNK = 500;
    for(let i = 0; i < universe.length; i += REF_CHUNK){
      const chunk = universe.slice(i, i + REF_CHUNK);
      const { data: refData } = await supabase.from('ticker_reference').select('symbol, asset_type').in('symbol', chunk);
      for (const r of refData ?? []){
        if (r.asset_type) refMap.set(r.symbol, r.asset_type);
      }
    }
    // 4. Categorize and apply runtime liquidity filter
    // Note: bulkSnapshots() already falls back to prevDay on weekends,
    // so day_volume here represents "the most recent trading session's volume"
    // — Friday's volume on a Sunday, today's volume during market hours.
    const stocks = [];
    const etfs = [];
    let nonZeroVolCount = 0;
    let typeFoundCount = 0;
    for (const [sym, snap] of snapshots){
      if (snap.day_volume > 0) nonZeroVolCount++;
      const dollarVol = snap.last_price * snap.day_volume;
      if (dollarVol < MIN_TODAY_DOLLAR_VOLUME) continue; // runtime liquidity
      const type = refMap.get(sym);
      if (type) typeFoundCount++;
      if (!type) continue;
      if (STOCK_TYPES.has(type)) stocks.push(snap);
      else if (ETF_TYPES.has(type)) etfs.push(snap);
    }
    // Diagnostics for debugging
    const diagInfo = {
      universe: universe.length,
      snapshots: snapshots.size,
      with_volume: nonZeroVolCount,
      type_found: typeFoundCount,
      stocks: stocks.length,
      etfs: etfs.length
    };
    // 5. Rank: top 10 gainers + 10 losers per kind
    const rank = (arr, dir)=>{
      const sorted = [
        ...arr
      ].sort((a, b)=>dir === 'gainer' ? b.change_pct - a.change_pct : a.change_pct - b.change_pct);
      return sorted.slice(0, TOP_N);
    };
    const stockGainers = rank(stocks, 'gainer');
    const stockLosers = rank(stocks, 'loser');
    const etfGainers = rank(etfs, 'gainer');
    const etfLosers = rank(etfs, 'loser');
    // 6. Collect all top movers symbols
    const allTopMovers = [
      ...stockGainers,
      ...stockLosers,
      ...etfGainers,
      ...etfLosers
    ];
    const allTopSymbols = [
      ...new Set(allTopMovers.map((s)=>s.symbol))
    ];
    // 7. Fetch sparklines (parallel)
    const sparklineMap = new Map();
    await Promise.all(allTopSymbols.map(async (sym)=>{
      const sp = await fetch10DaySparkline(sym);
      sparklineMap.set(sym, sp);
    }));
    // 8. Load ta_cache indicators for all top movers
    const taMap = await loadTaIndicators(allTopSymbols);
    // 9. Build UPSERT rows
    const now = new Date().toISOString();
    const buildRows = (items, kind)=>{
      const isGainer = kind.endsWith('_gainer');
      return items.map((s, i)=>{
        const ta = taMap.get(s.symbol);
        const sig = computeSignal(s, ta, isGainer);
        const sp = sparklineMap.get(s.symbol) ?? [];
        return {
          kind,
          rank: i + 1,
          symbol: s.symbol,
          last_price: s.last_price,
          change_abs: s.change_abs,
          change_pct: s.change_pct,
          day_volume: s.day_volume,
          fetched_at: now,
          updated_at: now,
          data_as_of: s.data_as_of,
          sparkline_10d: sp,
          signal_score: sig.signal_score,
          signal_label: sig.signal_label,
          rsi14: sig.rsi14,
          macd_hist: sig.macd_hist,
          vol_ratio: sig.vol_ratio,
          ema_position: sig.ema_position
        };
      });
    };
    const allRows = [
      ...buildRows(stockGainers, 'stock_gainer'),
      ...buildRows(stockLosers, 'stock_loser'),
      ...buildRows(etfGainers, 'etf_gainer'),
      ...buildRows(etfLosers, 'etf_loser')
    ];
    // 10. Clear stale rows then UPSERT
    // Use DELETE + INSERT pattern to handle case where a kind has fewer than TOP_N (clears old rows)
    const { error: delErr } = await supabase.from('top_movers_cache').delete().gte('rank', 1);
    if (delErr) throw new Error('clear failed: ' + delErr.message);
    const { error: insErr } = await supabase.from('top_movers_cache').insert(allRows);
    if (insErr) throw new Error('insert failed: ' + insErr.message);
    const dur = Date.now() - t0;
    await recordHealth({
      attempted: universe.length,
      updated: allRows.length,
      failed: 0,
      durationMs: dur
    });
    return new Response(JSON.stringify({
      ok: true,
      duration_ms: dur,
      universe_size: universe.length,
      snapshots_fetched: snapshots.size,
      diagnostics: diagInfo,
      stocks_eligible: stocks.length,
      etfs_eligible: etfs.length,
      written: allRows.length,
      breakdown: {
        stock_gainers: stockGainers.length,
        stock_losers: stockLosers.length,
        etf_gainers: etfGainers.length,
        etf_losers: etfLosers.length
      },
      top_stock_gainer_sample: stockGainers[0] ? {
        symbol: stockGainers[0].symbol,
        change_pct: stockGainers[0].change_pct
      } : null,
      top_etf_gainer_sample: etfGainers[0] ? {
        symbol: etfGainers[0].symbol,
        change_pct: etfGainers[0].change_pct
      } : null
    }, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (e) {
    const dur = Date.now() - t0;
    const errMsg = String(e).slice(0, 500);
    await recordHealth({
      attempted: 0,
      updated: 0,
      failed: 1,
      durationMs: dur,
      error: errMsg
    });
    return new Response(JSON.stringify({
      ok: false,
      error: errMsg
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
});