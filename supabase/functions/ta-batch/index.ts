// OptionLens TA Batch Job — Supabase Edge Function v23.1-lock-only
// Deploy as function name: ta-batch
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
let BATCH_SIZE = 10;
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
  if (isTrading(etDate) && hhmm >= 930) return etDate;
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
// ── PRICE BARS (grouped daily) + ADX(14) + STOCHASTIC(14,3) ─────────────────
async function fetchPriceBars(supabase, tradingDate, TICKERS) {
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
  const dates = [];
  const d = new Date(tradingDate + 'T12:00:00');
  while(dates.length < 30){
    const ds = d.toISOString().slice(0, 10);
    if (isTrading(ds)) dates.push(ds);
    d.setDate(d.getDate() - 1);
  }
  console.log(`[batch:bars] fetching ${dates.length} trading days for ADX/Stoch`);
  const tickerSet = new Set(TICKERS);
  const barsByDate = {};
  for (const date of dates){
    try {
      const r = await fetch(`${POLYGON_BASE}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apiKey=${POLYGON_KEY}`, {
        signal: AbortSignal.timeout(20000)
      });
      if (r.ok) {
        const data = await r.json();
        if (data?.results) {
          barsByDate[date] = {};
          for (const b of data.results)if (b.T && tickerSet.has(b.T)) barsByDate[date][b.T] = b;
        }
      }
    } catch (e) {
      console.warn('[batch:bars] fetch error for', date, e.message);
    }
    await sleep(70) // TEST 4b: was 1000, now 70
    ;
  }
  const datesAvail = Object.keys(barsByDate).sort().reverse();
  if (!datesAvail.length) {
    console.warn('[batch:bars] no bar data available — skipping price bars');
    return;
  }
  const rows = [];
  for (const tk of TICKERS){
    const bars = datesAvail.map((date)=>barsByDate[date]?.[tk]).filter(Boolean);
    if (!bars.length) continue;
    const closes = bars.map((b)=>b.c);
    const highs = bars.map((b)=>b.h);
    const lows = bars.map((b)=>b.l);
    const price = closes[0];
    const n = bars.length;
    const atr14 = bars.reduce((s, b)=>s + (b.h - b.l), 0) / n;
    const mom5 = n >= 2 ? (closes[0] - closes[n - 1]) / closes[n - 1] * 100 : 0;
    const mean5 = closes.slice(0, Math.min(5, n)).reduce((a, b)=>a + b, 0) / Math.min(5, n);
    const std5 = Math.sqrt(closes.slice(0, Math.min(5, n)).reduce((a, b)=>a + (b - mean5) ** 2, 0) / Math.min(5, n)) || atr14;
    const bollPos = 4 * std5 > 0 ? Math.min(100, Math.max(0, (price - (mean5 - 2 * std5)) / (4 * std5) * 100)) : 50;
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
      const c = [
        ...closes
      ].reverse();
      const h = [
        ...highs
      ].reverse();
      const l = [
        ...lows
      ].reverse();
      const len = c.length;
      const tr = [];
      const pdm = [];
      const mdm = [];
      for(let i = 1; i < len; i++){
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
        let atr = tr.slice(0, 14).reduce((s, v)=>s + v, 0);
        let aPdm = pdm.slice(0, 14).reduce((s, v)=>s + v, 0);
        let aMdm = mdm.slice(0, 14).reduce((s, v)=>s + v, 0);
        const dxArr = [];
        for(let i = 14; i < tr.length; i++){
          atr = atr - atr / 14 + tr[i];
          aPdm = aPdm - aPdm / 14 + pdm[i];
          aMdm = aMdm - aMdm / 14 + mdm[i];
          const pdi = atr > 0 ? aPdm / atr * 100 : 0;
          const mdi = atr > 0 ? aMdm / atr * 100 : 0;
          const diSum = pdi + mdi;
          const dx = diSum > 0 ? Math.abs(pdi - mdi) / diSum * 100 : 0;
          dxArr.push(dx);
        }
        if (dxArr.length >= 14) {
          let adxVal = dxArr.slice(0, 14).reduce((s, v)=>s + v, 0) / 14;
          for(let i = 14; i < dxArr.length; i++){
            adxVal = (adxVal * 13 + dxArr[i]) / 14;
          }
          adx14 = Math.round(adxVal * 100) / 100;
        }
      }
    }
    const row = {
      ticker: tk,
      trading_date: tradingDate,
      price,
      atr14,
      boll_pos: bollPos,
      mom5,
      vol: bars[0].v || 0
    };
    if (stoch_k !== null) row.stoch_k = stoch_k;
    if (adx14 !== null) row.adx14 = adx14;
    if (SECTOR_MAP[tk]) row.sector = SECTOR_MAP[tk];

    // ─── Support/Resistance/Pivot/Fib (ported from screener)
    // bars in this loop are DESC (newest first); convert to ASC for the helper
    try {
      const barsAsc = [...bars].reverse();
      const bbUpper = mean5 + 2 * std5;
      const bbLower = mean5 - 2 * std5;
      const sr = computePivotFib(barsAsc, price, bbUpper, bbLower);
      if (sr) {
        row.tg1 = sr.tg1;
        row.tg2 = sr.tg2;
        row.support = sr.support;
        row.resistance = sr.resistance;
        row.pivot_pp = sr.pivot_pp;
        row.pivot_r1 = sr.pivot_r1;
        row.pivot_r2 = sr.pivot_r2;
        row.pivot_s1 = sr.pivot_s1;
        row.pivot_s2 = sr.pivot_s2;
        row.fib_levels = sr.fib_levels;
        row.swing_high_50d = sr.swing_high_50d;
        row.swing_low_50d = sr.swing_low_50d;
        row.sr_computed_at = new Date().toISOString();
      }
    } catch (e) {
      // Don't break ta-batch on S/R compute errors — just skip those columns
      console.warn(`[batch:bars] S/R compute failed for ${tk}:`, e.message);
    }

    rows.push(row);
  }
  if (!rows.length) {
    console.warn('[batch:bars] no rows to upsert');
    return;
  }
  for(let i = 0; i < rows.length; i += 50){
    const result = await supabase.from('ta_cache').upsert(rows.slice(i, i + 50), {
      onConflict: 'ticker,trading_date'
    });
    if (result?.error) console.error('[batch:bars] upsert error:', result.error.message);
  }
  const adxCount = rows.filter((r)=>r.adx14 != null).length;
  const stochCount = rows.filter((r)=>r.stoch_k != null).length;
  console.log(`[batch:bars] stored ${rows.length} tickers (ADX: ${adxCount}, Stoch: ${stochCount})`);
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
  try {
    const body = await _req.json();
    if (body?.mode) mode = body.mode;
    if (body?.date) dateOverride = body.date;
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
    // ── Phase 1: Price bars ──
    if (!priceBarsDone) {
      await fetchPriceBars(supabase, tradingDate, TICKERS);
      priceBarsDone = true;
      await supabase.from('batch_state').update({
        price_bars_done: true,
        last_updated: new Date().toISOString()
      }).eq('trading_date', tradingDate);
      batchesFired++;
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
        console.log(`[batch] ${ind.label} [${tickerIdx}..${tickerIdx + batch.length - 1}/${TICKERS.length}]: ${batch.join(',')}`);
        const results = [];
        for (const tk of batch){
          const data = await polygonFetch(ind.url(tk));
          results.push({
            tk,
            val: data?._429 ? null : ind.parse(data),
            rate_limited: data?._429 === true
          });
          if (data?._429) break;
          await sleep(70) // TEST 4b: was 700, now 70
          ;
        }
        batchesFired++;
        if (results.every((r)=>r.rate_limited)) {
          console.warn('[batch] full 429 — waiting 30s then continuing');
          await sleep(30000);
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
