// ═══════════════════════════════════════════════════════════════════
// StockVizor — watchlist-classify Edge Function
// ═══════════════════════════════════════════════════════════════════
// Purpose: For every user_watchlists row with mode='vizwatch', compute
//          the bucket and target_price from current ta_cache values.
//
// Logic:
//   1. Read all user_watchlists rows where mode='vizwatch'
//   2. Group by ticker, fetch latest ta_cache row per ticker
//   3. For each row: compute signal_score (-100..+100) from indicators
//      (Smart Candle Engine reuse: RSI + MACD + EMA position + recent move)
//   4. Map score to bucket:
//      ≥ +60: strong_bullish  (Strong Bullish Setup)
//      +30 to +59: bullish_tilt
//      -29 to +29: neutral
//      -59 to -30: bearish_tilt
//      ≤ -60: strong_bearish
//   5. Pick target:
//      Bullish buckets → resistance (or tg1, or swing_high_50d)
//      Bearish buckets → support (or swing_low_50d)
//      Neutral → null
//   6. Build target_label like "$235.50 (20-day high)" or "$182.00 (support)"
//   7. UPSERT bucket, bucket_score, target_price, target_label, last_classified_at
//
// Schedule: daily at 1am UTC (9pm ET)
// Also called from frontend on add-ticker for instant classification.
// ═══════════════════════════════════════════════════════════════════
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
// ── Compute direction-aware signal score from ta_cache row ──
function computeSignalScore(ta) {
  let score = 0;
  const price = Number(ta.price ?? 0);
  const rsi = ta.rsi != null ? Number(ta.rsi) : null;
  const macd_h = ta.macd_h != null ? Number(ta.macd_h) : null;
  const vol_ratio = ta.vol_ratio != null ? Number(ta.vol_ratio) : null;
  const ema9 = ta.ema9 != null ? Number(ta.ema9) : null;
  const ema20 = ta.ema20 != null ? Number(ta.ema20) : null;
  const ema50 = ta.ema50 != null ? Number(ta.ema50) : null;
  const sma200 = ta.sma200 != null ? Number(ta.sma200) : null;
  // RSI scoring: bullish 50-70 sweet spot; -ish elsewhere
  if (rsi != null) {
    if (rsi > 70) score -= 15; // overbought
    else if (rsi >= 50) score += 15; // healthy momentum
    else if (rsi < 30) score -= 5; // weak (oversold could go either way)
    else if (rsi >= 30) score -= 5; // weak momentum
  }
  // MACD histogram direction
  if (macd_h != null) {
    if (macd_h > 0.5) score += 15;
    else if (macd_h > 0) score += 8;
    else if (macd_h < -0.5) score -= 15;
    else if (macd_h < 0) score -= 8;
  }
  // EMA stacking: price > ema9 > ema20 = strong bullish trend; opposite = bearish
  if (price > 0) {
    if (ema9 && ema20) {
      // 9 > 20 with price above both = trending up
      if (price > ema9 && ema9 > ema20) score += 12;
      else if (price < ema9 && ema9 < ema20) score -= 12;
    }
    if (ema50) {
      if (price > ema50 * 1.02) score += 8;
      else if (price < ema50 * 0.98) score -= 8;
    }
    if (sma200) {
      if (price > sma200 * 1.02) score += 10;
      else if (price < sma200 * 0.98) score -= 10;
    }
  }
  // Volume confirmation (when available)
  if (vol_ratio != null && vol_ratio > 1.5) {
    // High volume amplifies whatever direction the price is going
    if (macd_h != null && macd_h > 0) score += 5;
    else if (macd_h != null && macd_h < 0) score -= 5;
  }
  // Clip to -100..+100
  return Math.max(-100, Math.min(100, Math.round(score)));
}
// ── Map score to bucket ──
function scoreToBucket(score) {
  if (score >= 60) return 'strong_bullish';
  if (score >= 30) return 'bullish_tilt';
  if (score >= -29) return 'neutral';
  if (score >= -59) return 'bearish_tilt';
  return 'strong_bearish';
}
// ── Pick target price + label per bucket ──
function pickTarget(bucket, ta) {
  const isBullish = bucket === 'strong_bullish' || bucket === 'bullish_tilt';
  const isBearish = bucket === 'strong_bearish' || bucket === 'bearish_tilt';
  if (!isBullish && !isBearish) {
    return {
      price: null,
      label: null
    };
  }
  if (isBullish) {
    // Prefer: resistance, then tg1, then swing_high_50d
    if (ta.resistance != null && ta.resistance > 0) {
      return {
        price: Number(ta.resistance),
        label: 'resistance'
      };
    }
    if (ta.tg1 != null && ta.tg1 > 0) {
      return {
        price: Number(ta.tg1),
        label: 'first target'
      };
    }
    if (ta.swing_high_50d != null) {
      return {
        price: Number(ta.swing_high_50d),
        label: '50-day high'
      };
    }
  } else {
    // Bearish: support, then tg1, then swing_low_50d
    if (ta.support != null && ta.support > 0) {
      return {
        price: Number(ta.support),
        label: 'support'
      };
    }
    if (ta.tg1 != null && ta.tg1 > 0) {
      return {
        price: Number(ta.tg1),
        label: 'first target'
      };
    }
    if (ta.swing_low_50d != null) {
      return {
        price: Number(ta.swing_low_50d),
        label: '50-day low'
      };
    }
  }
  return {
    price: null,
    label: null
  };
}
// ── Bulk-load latest ta_cache row per ticker ──
async function loadLatestTaForTickers(tickers) {
  const out = new Map();
  if (tickers.length === 0) return out;
  // Chunk to avoid URL length issues
  const CHUNK = 500;
  for(let i = 0; i < tickers.length; i += CHUNK){
    const chunk = tickers.slice(i, i + CHUNK);
    const { data, error } = await supabase.from('ta_cache').select('ticker, price, rsi, macd_h, vol_ratio, ema9, ema20, ema50, sma200, tg1, support, resistance, swing_high_50d, swing_low_50d, trading_date').in('ticker', chunk).order('trading_date', {
      ascending: false
    });
    if (error) {
      console.warn('[classify] ta_cache fetch error:', error.message);
      continue;
    }
    // Pick latest per ticker
    for (const row of data ?? []){
      if (!out.has(row.ticker)) {
        out.set(row.ticker, row);
      }
    }
  }
  return out;
}
async function recordHealth(opts) {
  const status = opts.failed === 0 && opts.updated > 0 ? 'healthy' : opts.updated > 0 ? 'partial' : opts.attempted === 0 ? 'idle' : 'failed';
  await supabase.from('cache_health').upsert({
    cache_name: 'watchlist_classify',
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
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const t0 = Date.now();
  if (!SUPABASE_KEY) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'missing keys'
    }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json', ...CORS }
    });
  }
  // Parse body for optional single-user mode (used by frontend on add-ticker)
  let userId = null;
  let tickerFilter = null;
  try {
    if (req.method === 'POST' && req.headers.get('content-length') !== '0') {
      const body = await req.json();
      userId = body?.user_id ?? null;
      tickerFilter = body?.ticker ?? null;
    }
  } catch (e) {
  // Body parse fail is fine; we'll classify all
  }
  try {
    // 1. Load user_watchlists rows for vizwatch mode (filtered if user_id provided)
    let q = supabase.from('user_watchlists').select('user_id, ticker, mode, list_name').eq('mode', 'vizwatch');
    if (userId) q = q.eq('user_id', userId);
    if (tickerFilter) q = q.eq('ticker', tickerFilter);
    const { data: rows, error: rowsErr } = await q;
    if (rowsErr) throw new Error(`load watchlists: ${rowsErr.message}`);
    if (!rows || rows.length === 0) {
      const dur = Date.now() - t0;
      await recordHealth({
        attempted: 0,
        updated: 0,
        failed: 0,
        durationMs: dur
      });
      return new Response(JSON.stringify({
        ok: true,
        duration_ms: dur,
        message: 'no vizwatch rows to classify',
        scope: {
          user_id: userId,
          ticker: tickerFilter
        }
      }, null, 2), {
        status: 200,
        headers: {
          'Content-Type': 'application/json', ...CORS
        }
      });
    }
    // 2. Get unique tickers and load ta_cache
    const uniqueTickers = [
      ...new Set(rows.map((r)=>r.ticker))
    ];
    const taMap = await loadLatestTaForTickers(uniqueTickers);
    // 3. Compute classifications
    const updates = [];
    let classified = 0, skipped = 0;
    const nowIso = new Date().toISOString();
    for (const r of rows){
      const ta = taMap.get(r.ticker);
      if (!ta || !ta.price) {
        // No TA data yet (e.g. brand-new ticker)
        skipped++;
        continue;
      }
      const score = computeSignalScore(ta);
      const bucket = scoreToBucket(score);
      const target = pickTarget(bucket, ta);
      updates.push({
        user_id: r.user_id,
        ticker: r.ticker,
        mode: r.mode,
        list_name: r.list_name,
        bucket,
        bucket_score: score,
        target_price: target.price,
        target_label: target.label,
        last_classified_at: nowIso
      });
      classified++;
    }
    // 4. UPSERT updates
    if (updates.length > 0) {
      const CHUNK = 200;
      for(let i = 0; i < updates.length; i += CHUNK){
        const chunk = updates.slice(i, i + CHUNK);
        const { error: upErr } = await supabase.from('user_watchlists').upsert(chunk, {
          onConflict: 'user_id,mode,list_name,ticker'
        });
        if (upErr) {
          console.warn('[classify] upsert err:', upErr.message);
        }
      }
    }
    const dur = Date.now() - t0;
    await recordHealth({
      attempted: rows.length,
      updated: classified,
      failed: skipped,
      durationMs: dur
    });
    // Bucket summary for visibility
    const bucketCounts = {};
    for (const u of updates){
      bucketCounts[u.bucket] = (bucketCounts[u.bucket] ?? 0) + 1;
    }
    return new Response(JSON.stringify({
      ok: true,
      duration_ms: dur,
      scope: {
        user_id: userId,
        ticker: tickerFilter
      },
      total_rows: rows.length,
      classified,
      skipped_no_ta: skipped,
      buckets: bucketCounts
    }, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json', ...CORS
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
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }
});