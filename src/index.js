const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,apikey,Prefer',
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function errorResp(msg, status = 400) {
  return jsonResp({ error: msg }, status);
}

// ── Supabase helpers ─────────────────────────────────────────────────────────

// Read — uses anon key (RLS applies)
async function supaQuery(env, path) {
  const base = env.SUPABASE_URL;
  const key  = env.SUPABASE_ANON_KEY;
  if (!base || !key) throw new Error('Supabase not configured');
  const r = await fetch(`${base}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

// Upsert — uses service role key to bypass RLS for cache writes.
// Falls back to anon key; errors are logged but never propagated to the caller.
async function supaUpsert(env, table, data, onConflict) {
  const base = env.SUPABASE_URL;
  const key  = env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
  if (!base || !key) return;
  const qs = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
  try {
    const r = await fetch(`${base}/rest/v1/${table}${qs}`, {
      method: 'POST',
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(data),
    });
    if (!r.ok) console.error(`[supaUpsert ${table}] ${r.status}:`, (await r.text()).slice(0, 200));
  } catch (e) {
    console.error(`[supaUpsert ${table}]`, e.message);
  }
}

// ── TA COMPUTATION — runs in the Worker on ta_cache miss ─────────────────────
// All computed from Polygon OHLCV bars server-side. Never in the browser.

// EMA array — SMA-seeded, full length output starting at index (period-1)
function emaArr(closes, period) {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  let val = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [val];
  for (let i = period; i < closes.length; i++) {
    val = closes[i] * k + val * (1 - k);
    out.push(val);
  }
  return out; // length = closes.length - period + 1
}

// Simple SMA of last n values
function smaN(closes, n) {
  if (closes.length < n) return null;
  return closes.slice(-n).reduce((a, b) => a + b, 0) / n;
}

// RSI(14) — Wilder smoothing
function computeRSI14(closes) {
  const p = 14;
  if (closes.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  g /= p; l /= p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (p - 1) + Math.max(0,  d)) / p;
    l = (l * (p - 1) + Math.max(0, -d)) / p;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

// MACD histogram (12, 26, 9)
function computeMACDHist(closes) {
  if (closes.length < 35) return null;
  const e12 = emaArr(closes, 12);
  const e26 = emaArr(closes, 26);
  const len  = Math.min(e12.length, e26.length);
  if (len < 1) return null;
  const macd = Array.from({ length: len }, (_, i) =>
    e12[e12.length - len + i] - e26[e26.length - len + i]);
  if (macd.length < 9) return null;
  const sig = emaArr(macd, 9);
  return macd[macd.length - 1] - sig[sig.length - 1];
}

// ADX(14) — Wilder smoothing
function computeADX14(bars) {
  const p = 14;
  if (bars.length < p * 2) return null;
  function wilder(arr) {
    let s = arr.slice(0, p).reduce((a, b) => a + b, 0);
    const r = [s];
    for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; r.push(s); }
    return r;
  }
  const tr = [], dmp = [], dmm = [];
  for (let i = 1; i < bars.length; i++) {
    const { h, l } = bars[i], pc = bars[i - 1].c, ph = bars[i - 1].h, pl = bars[i - 1].l;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, dn = pl - l;
    dmp.push(up > dn && up > 0 ? up : 0);
    dmm.push(dn > up && dn > 0 ? dn : 0);
  }
  const sTR = wilder(tr), sDMP = wilder(dmp), sDMM = wilder(dmm);
  const dxs = sTR.map((t, i) => {
    const diP = t ? 100 * sDMP[i] / t : 0, diM = t ? 100 * sDMM[i] / t : 0;
    const s = diP + diM;
    return s ? 100 * Math.abs(diP - diM) / s : 0;
  });
  if (dxs.length < p) return null;
  const adxArr = wilder(dxs);
  return adxArr[adxArr.length - 1];
}

// Stochastic %K(14)
function computeStochK14(bars) {
  const p = 14;
  if (bars.length < p) return null;
  const sl = bars.slice(-p);
  const hi = Math.max(...sl.map(b => b.h)), lo = Math.min(...sl.map(b => b.l));
  return hi === lo ? 50 : ((bars[bars.length - 1].c - lo) / (hi - lo)) * 100;
}

// Bollinger Band position — 0 = lower band, 1 = upper band
function computeBollPos(closes, p = 20) {
  if (closes.length < p) return null;
  const sl = closes.slice(-p);
  const mean = sl.reduce((a, b) => a + b, 0) / p;
  const std  = Math.sqrt(sl.reduce((a, b) => a + (b - mean) ** 2, 0) / p);
  if (std === 0) return 0.5;
  return (closes[closes.length - 1] - (mean - 2 * std)) / (4 * std);
}

// Today's date in ET (market dates are ET-keyed)
function todayET() {
  // en-CA locale returns YYYY-MM-DD format directly
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

// ── Fetch bars from Polygon → compute all TA → upsert to ta_cache + quote_cache
// Called only on ta_cache miss. Returns the ta row so dashboardTicker
// can build the response without a second DB round-trip.
async function fetchAndCacheTA(env, symbol) {
  const POLY_KEY = env.POLYGON_KEY;
  if (!POLY_KEY) throw new Error('Polygon key not configured');

  const today = new Date().toISOString().slice(0, 10);
  const from  = new Date(Date.now() - 310 * 86400000).toISOString().slice(0, 10);
  const url   = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${from}/${today}?adjusted=true&sort=asc&limit=400&apiKey=${POLY_KEY}`;

  const r = await fetch(url, { headers: { 'User-Agent': 'StockVizor/1.0' } });
  if (!r.ok) throw new Error(`Polygon ${r.status} for ${symbol}`);
  const j = await r.json();
  const bars = j.results ?? [];
  if (bars.length < 2) throw new Error(`No Polygon bar data for ${symbol}`);

  const last  = bars[bars.length - 1];
  const prev  = bars[bars.length - 2];
  const tradingDate = new Date(last.t).toISOString().slice(0, 10);
  const closes = bars.map(b => b.c);

  // Compute all indicators
  const ema20  = emaArr(closes, 20).at(-1) ?? null;
  const sma50  = smaN(closes, 50);
  const sma200 = smaN(closes, 200);
  const rsi    = computeRSI14(closes);
  const macdH  = computeMACDHist(closes);
  const adx    = computeADX14(bars);
  const stochK = computeStochK14(bars);
  const bollP  = computeBollPos(closes);
  const mom5   = closes.length >= 6 ? closes.at(-1) - closes.at(-6) : null;

  // Classic pivot points from previous bar's H/L/C
  const pivot = (prev.h + prev.l + prev.c) / 3;
  const r1    = 2 * pivot - prev.l;
  const r2    = pivot + (prev.h - prev.l);

  // 50-day swing high / low
  const tail50 = bars.slice(-50);
  const swingH = Math.max(...tail50.map(b => b.h));
  const swingL = Math.min(...tail50.map(b => b.l));

  const changeAbs = last.c - prev.c;
  const changePct = (changeAbs / prev.c) * 100;

  const taRow = {
    ticker: symbol, trading_date: tradingDate,
    price: last.c, rsi, macd_h: macdH, ema20, sma50, sma200,
    adx14: adx, stoch_k: stochK, boll_pos: bollP, mom5,
    pivot_r1: r1, pivot_r2: r2, tg1: r1, tg2: r2,
    swing_high_50d: swingH, swing_low_50d: swingL,
  };
  const quoteRow = {
    symbol, last_price: last.c, change_abs: changeAbs,
    change_pct: changePct, day_high: last.h, day_low: last.l,
  };

  // Write to both caches concurrently — errors logged, never block the response
  await Promise.allSettled([
    supaUpsert(env, 'ta_cache',    taRow,    'ticker,trading_date'),
    supaUpsert(env, 'quote_cache', quoteRow, 'symbol'),
  ]);

  // Return merged so dashboardTicker can serve without a second DB round-trip
  return { ...taRow, _q: quoteRow };
}

// ── Signal computation — all logic lives here, never in the browser ──────────
function computeSignal(ta) {
  if (!ta) return { bias: 'Neutral', emoji: '⚪', confluence: 0, factors: [] };
  const factors = [];
  let bull = 0;

  if (ta.rsi != null)    { if (ta.rsi > 52)          { bull++; factors.push(`RSI ${ta.rsi.toFixed(1)} (bull)`); }
                           else                        {         factors.push(`RSI ${ta.rsi.toFixed(1)} (bear)`); } }
  if (ta.macd_h != null) { if (ta.macd_h > 0)         { bull++; factors.push('MACD hist positive'); }
                           else                        {         factors.push('MACD hist negative'); } }
  if (ta.price != null && ta.sma50 != null)
                         { if (ta.price > ta.sma50)   { bull++; factors.push(`Price > SMA50 (${ta.sma50.toFixed(2)})`); }
                           else                        {         factors.push(`Price < SMA50 (${ta.sma50.toFixed(2)})`); } }
  if (ta.adx14 != null)  { if (ta.adx14 > 20)         { bull++; factors.push(`ADX ${ta.adx14.toFixed(1)} (trending)`); }
                           else                        {         factors.push(`ADX ${ta.adx14.toFixed(1)} (ranging)`); } }
  if (ta.mom5 != null)   { if (ta.mom5 > 0)           { bull++; factors.push('5-day momentum positive'); }
                           else                        {         factors.push('5-day momentum negative'); } }

  const total = factors.length || 1;
  const bias  = bull >= Math.ceil(total * 0.7) ? 'Bullish'
              : bull <= Math.floor(total * 0.3) ? 'Bearish'
              : 'Neutral';
  const emoji = bias === 'Bullish' ? '🟢' : bias === 'Bearish' ? '🔴' : '⚪';
  return { bias, emoji, confluence: bull, outOf: total, factors };
}

// ── SMA state label — drives the Technical Hint panel ───────────────────────
function computeSMAState(price, sma20, sma50, sma200) {
  if (price == null) return null;
  const a20  = sma20  != null && price > sma20;
  const a50  = sma50  != null && price > sma50;
  const a200 = sma200 != null && price > sma200;
  const n = (a20 ? 1 : 0) + (a50 ? 1 : 0) + (a200 ? 1 : 0);
  if (n === 3) return { label: 'Above all SMAs',        arrow: '▲', color: '#14B8A6' };
  if (n === 2 && !a200) return { label: 'Above SMA20 & SMA50', arrow: '▲', color: '#4fdbc8' };
  if (a200 && a50 && !a20) return { label: 'Between SMA20 & SMA50', arrow: '↔', color: '#F59E0B' };
  if (a200 && !a50)        return { label: 'Between SMA50 & SMA200', arrow: '↔', color: '#F59E0B' };
  if (n === 0) return { label: 'Below all SMAs',        arrow: '▼', color: '#F43F5E' };
  return { label: 'Above SMA200 only', arrow: '↔', color: '#F59E0B' };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname.startsWith('/api/polygon/')) {
      return handlePolygon(request, env, url);
    }

    if (url.pathname.startsWith('/api/db/')) {
      return handleSupabaseDB(request, env, url);
    }

    if (url.pathname.startsWith('/api/dashboard/')) {
      return handleDashboard(request, env, url);
    }

    // ── URL OBFUSCATION ───────────────────────────────────────────────
    const path = url.pathname;
    const PATH_MAP = {
      '/v': '/v.html',
      '/s': '/s.html',
      '/m': '/m.html',
    };
    const OLD_PATHS = new Set(['/dashboard', '/screener', '/monitor']);

    if (PATH_MAP[path]) {
      const assetUrl = new URL(url);
      assetUrl.pathname = PATH_MAP[path];
      const resp = await env.ASSETS.fetch(assetUrl.toString());
      const newHeaders = new Headers(resp.headers);
      newHeaders.set('Cache-Control', 'no-store, must-revalidate, max-age=0');
      newHeaders.set('Pragma', 'no-cache');
      newHeaders.set('Expires', '0');
      newHeaders.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
      newHeaders.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: newHeaders });
    }

    const HIDDEN_HTML = new Set([
      '/dashboard.html', '/screener.html', '/monitor.html',
      '/v.html', '/s.html', '/m.html',
    ]);
    if (OLD_PATHS.has(path) || HIDDEN_HTML.has(path)) {
      return new Response(`<!DOCTYPE html><html><head><title>404 — Page not found</title>
<meta name="robots" content="noindex,nofollow">
<style>body{font-family:system-ui;background:#0a0d18;color:#e5e7eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}main{text-align:center}h1{font-size:64px;margin:0;color:#4a8cff}p{color:#9aa5b8}a{color:#4a8cff;text-decoration:none}</style>
</head><body><main><h1>404</h1><p>The page you requested does not exist.</p><p><a href="/">Return home</a></p></main></body></html>`, {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Cache-Control': 'no-store' },
      });
    }

    const isHtml = path === '/' || path.endsWith('.html') || !path.includes('.') || path === '/index';
    if (isHtml) {
      const resp = await env.ASSETS.fetch(request);
      const newHeaders = new Headers(resp.headers);
      newHeaders.set('Cache-Control', 'no-store, must-revalidate, max-age=0');
      newHeaders.set('Pragma', 'no-cache');
      newHeaders.set('Expires', '0');
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: newHeaders });
    }

    return env.ASSETS.fetch(request);
  },
};

// ── /api/polygon/ — Polygon.io proxy (key stays server-side) ────────────────
async function handlePolygon(request, env, url) {
  const POLY_KEY = env.POLYGON_KEY;
  if (!POLY_KEY) return errorResp('Polygon API key not configured', 500);

  const polyPath   = url.pathname.replace('/api/polygon', '');
  const polyParams = new URLSearchParams(url.search);
  polyParams.set('apiKey', POLY_KEY);
  const polyUrl = `https://api.polygon.io${polyPath}?${polyParams.toString()}`;

  try {
    const resp = await fetch(polyUrl, { method: request.method, headers: { 'User-Agent': 'StockVizor/1.0' } });
    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...CORS_HEADERS },
    });
  } catch (e) {
    return errorResp('Polygon API error: ' + e.message, 502);
  }
}

// ── /api/db/ — Supabase REST proxy (forwards user JWT, adds anon key) ────────
async function handleSupabaseDB(request, env, url) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_KEY = env.SUPABASE_ANON_KEY;
  if (!SUPA_URL || !SUPA_KEY) return errorResp('Supabase not configured', 500);

  const tablePath  = url.pathname.replace('/api/db', '');
  const supaUrl    = `${SUPA_URL}/rest/v1${tablePath}${url.search}`;
  const authHeader = request.headers.get('Authorization') || `Bearer ${SUPA_KEY}`;
  const preferHeader = request.headers.get('Prefer') || '';
  const headers = { apikey: SUPA_KEY, Authorization: authHeader, 'Content-Type': 'application/json' };
  if (preferHeader) headers['Prefer'] = preferHeader;

  try {
    const resp = await fetch(supaUrl, { method: request.method, headers, body: request.method !== 'GET' ? await request.text() : undefined });
    const body = await resp.text();
    return new Response(body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  } catch (e) {
    return errorResp('Supabase error: ' + e.message, 502);
  }
}

// ── /api/dashboard/ — aggregated data endpoints for the dashboard UI ─────────
async function handleDashboard(request, env, url) {
  const sub = url.pathname.replace('/api/dashboard/', '');

  // GET /api/dashboard/ticker/{symbol}
  if (sub.startsWith('ticker/')) {
    const symbol = sub.slice(7).toUpperCase();
    if (!symbol) return errorResp('Symbol required', 400);
    return dashboardTicker(env, symbol);
  }

  // GET /api/dashboard/quotes?tickers=NVDA,AAPL,TSLA
  if (sub === 'quotes') {
    const raw = url.searchParams.get('tickers') || '';
    const tickers = raw.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
    if (!tickers.length) return errorResp('tickers param required', 400);
    return dashboardQuotes(env, tickers);
  }

  // GET /api/dashboard/index
  if (sub === 'index') {
    return dashboardIndex(env);
  }

  // GET /api/dashboard/sparklines?tickers=AAPL,NVDA,...&days=10
  // One-call envelope: returns last N closing prices for all watchlist tickers.
  // Called once on page load — client draws all sparklines from one response.
  if (sub === 'sparklines') {
    const raw = url.searchParams.get('tickers') || '';
    const tickers = raw.split(',').map(t => t.trim().toUpperCase()).filter(Boolean).slice(0, 50);
    if (!tickers.length) return errorResp('tickers param required', 400);
    const days = Math.min(20, Math.max(5, parseInt(url.searchParams.get('days') || '10', 10)));
    return dashboardSparklines(env, tickers, days);
  }

  return errorResp('Unknown dashboard endpoint', 404);
}

// ── /api/dashboard/ticker/{symbol} ──────────────────────────────────────────
// Cache-first rule:
//   1. Check ta_cache for today's ET date → if found, return immediately (0 Polygon calls)
//   2. On miss → fetch Polygon bars, compute all TA, write to ta_cache + quote_cache, return
//   3. Next calendar day → ta_cache miss again → repeat step 2
// This means any user who hits a ticker first that day pays the Polygon cost once;
// every subsequent user that day gets it from Supabase cache.
async function dashboardTicker(env, symbol) {
  try {
    const today = todayET(); // YYYY-MM-DD in America/New_York

    const [quoteRows, taRows, newsRows] = await Promise.all([
      supaQuery(env, `quote_cache?symbol=eq.${symbol}&select=last_price,change_abs,change_pct,day_high,day_low&limit=1`),
      // ← only fetch today's entry; if it's missing we'll compute and write it below
      supaQuery(env, `ta_cache?ticker=eq.${symbol}&trading_date=eq.${today}&limit=1&select=trading_date,price,rsi,macd_h,ema20,sma50,sma200,adx14,stoch_k,boll_pos,mom5,pivot_r1,pivot_r2,tg1,tg2,swing_high_50d,swing_low_50d`),
      supaQuery(env, `news_cache?tickers=cs.%7B${symbol}%7D&order=published_at.desc&limit=3&select=headline,publisher,published_at,sentiment`),
    ]);

    let q  = quoteRows?.[0] ?? null;
    let ta = taRows?.[0]    ?? null;

    // ── Cache miss for ta_cache OR quote_cache → go to Polygon ──
    // If either is missing, recompute both so caches stay in sync.
    if (!ta || !q) {
      try {
        const fresh = await fetchAndCacheTA(env, symbol);
        if (!ta) ta = fresh;        // use computed ta row directly
        if (!q)  q  = fresh._q;    // use computed quote data if quote_cache was empty
      } catch (e) {
        console.error(`[ta cache miss ${symbol}]`, e.message);
        // Continue — partial response (no TA) is better than a 502
      }
    }

    const price      = q ? parseFloat(q.last_price)   : (ta ? parseFloat(ta.price) : null);
    const changeAbs  = q ? parseFloat(q.change_abs)   : null;
    const changePct  = q ? parseFloat(q.change_pct)   : null;

    const sma20  = ta?.ema20   ?? null;   // ema20 is stored in ta_cache as the 20-period proxy
    const sma50  = ta?.sma50   ?? null;
    const sma200 = ta?.sma200  ?? null;

    const signal   = computeSignal(ta ? { ...ta, price } : null);
    const smaState = computeSMAState(price, sma20, sma50, sma200);

    // Best available price target: tg1 → pivot_r1 → swing_high_50d
    const target1  = ta?.tg1           ?? ta?.pivot_r1        ?? ta?.swing_high_50d ?? null;
    const target2  = ta?.tg2           ?? ta?.pivot_r2        ?? null;
    const targetR1 = ta?.pivot_r1      ?? null;
    const targetR2 = ta?.pivot_r2      ?? null;

    return jsonResp({
      symbol,
      price,
      change_abs:  changeAbs,
      change_pct:  changePct,
      day_high:    q ? parseFloat(q.day_high)  : null,
      day_low:     q ? parseFloat(q.day_low)   : null,
      trading_date: ta?.trading_date ?? null,
      // SMA levels for chart overlay (flat horizontal lines)
      sma20, sma50, sma200,
      // Indicator values (for display only — already computed by batch)
      rsi:     ta?.rsi     ?? null,
      macd_h:  ta?.macd_h  ?? null,
      adx14:   ta?.adx14   ?? null,
      stoch_k: ta?.stoch_k ?? null,
      mom5:    ta?.mom5    ?? null,
      // Price targets
      target1, target2, pivot_r1: targetR1, pivot_r2: targetR2,
      // Pre-computed signal and SMA state
      signal,
      sma_state: smaState,
      // News
      news: (newsRows ?? []).map(n => ({
        headline:     n.headline,
        publisher:    n.publisher,
        published_at: n.published_at,
        sentiment:    n.sentiment,
      })),
    });
  } catch (e) {
    return errorResp(`ticker fetch failed: ${e.message}`, 502);
  }
}

// ── /api/dashboard/quotes?tickers=A,B,C ─────────────────────────────────────
// Bulk price/change lookup for the watchlist sidebar.
// Primary: quote_cache. Fallback: ta_cache (today) for any ticker not yet in quote_cache.
async function dashboardQuotes(env, tickers) {
  try {
    const inList = tickers.map(t => `"${t}"`).join(',');
    const rows   = await supaQuery(env, `quote_cache?symbol=in.(${inList})&select=symbol,last_price,change_abs,change_pct`);
    const result = {};
    const found  = new Set();
    for (const r of (rows ?? [])) {
      const price = parseFloat(r.last_price);
      const chgA  = parseFloat(r.change_abs);
      const pct   = parseFloat(r.change_pct);
      if (!isFinite(price)) continue;
      result[r.symbol] = {
        price:  price.toFixed(2),
        change: isFinite(chgA) ? (chgA >= 0 ? '+' : '') + chgA.toFixed(2) : '—',
        pct:    isFinite(pct)  ? (pct  >= 0 ? '+' : '') + pct.toFixed(2) + '%' : '—',
        dir:    isFinite(pct) ? (pct >= 0 ? 'bull' : 'bear') : 'bull',
      };
      found.add(r.symbol);
    }

    // Fallback: tickers missing from quote_cache → try ta_cache for today's price
    const missing = tickers.filter(t => !found.has(t));
    if (missing.length) {
      const today      = todayET();
      const missList   = missing.map(t => `"${t}"`).join(',');
      const taRows     = await supaQuery(env, `ta_cache?ticker=in.(${missList})&trading_date=eq.${today}&select=ticker,price`);
      for (const r of (taRows ?? [])) {
        const price = parseFloat(r.price);
        if (!isFinite(price)) continue;
        result[r.ticker] = { price: price.toFixed(2), change: '—', pct: '—', dir: 'bull' };
      }
    }

    return jsonResp(result);
  } catch (e) {
    return errorResp(`quotes fetch failed: ${e.message}`, 502);
  }
}

// ── /api/dashboard/index ─────────────────────────────────────────────────────
// Index strip data: SPY, QQQ, DIA, IWM, VIX, GLD, TNX.
async function dashboardIndex(env) {
  const INDEX_SYMBOLS = ['SPY', 'QQQ', 'DIA', 'IWM', 'VIX', 'GLD', 'TNX'];
  try {
    const inList = INDEX_SYMBOLS.map(t => `"${t}"`).join(',');
    const rows   = await supaQuery(env, `quote_cache?symbol=in.(${inList})&select=symbol,last_price,change_abs,change_pct`);
    const result = {};
    for (const r of (rows ?? [])) {
      const pct = parseFloat(r.change_pct);
      result[r.symbol] = {
        price:  parseFloat(r.last_price).toFixed(2),
        change: parseFloat(r.change_abs).toFixed(2),
        pct:    (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%',
        dir:    pct >= 0 ? 'bull' : 'bear',
      };
    }
    return jsonResp(result);
  } catch (e) {
    return errorResp(`index fetch failed: ${e.message}`, 502);
  }
}

// ── /api/dashboard/sparklines?tickers=A,B,C&days=10 ─────────────────────────
// One-call envelope: fetches last N daily closing prices for all watchlist tickers
// from Polygon in parallel, returns { AAPL: [c1,c2,...], NVDA: [...] }.
// Called once on page load — client draws all watchlist sparklines from one response.
// Each individual Polygon fetch is a subrequest; Worker handles all in parallel.
async function dashboardSparklines(env, tickers, days) {
  const POLY_KEY = env.POLYGON_KEY;
  if (!POLY_KEY) return errorResp('Polygon API key not configured', 500);

  const today = new Date().toISOString().slice(0, 10);
  const from  = new Date(Date.now() - (days + 5) * 86400000).toISOString().slice(0, 10); // +5 buffer for weekends/holidays

  const fetches = tickers.map(async sym => {
    const polyUrl = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/day/${from}/${today}?adjusted=true&sort=asc&limit=${days + 5}&apiKey=${POLY_KEY}`;
    try {
      const r = await fetch(polyUrl, { headers: { 'User-Agent': 'StockVizor/1.0' } });
      if (!r.ok) return [sym, null];
      const j = await r.json();
      const closes = (j.results ?? []).slice(-days).map(b => b.c);
      return [sym, closes.length >= 2 ? closes : null];
    } catch {
      return [sym, null];
    }
  });

  const results = await Promise.all(fetches);
  const out = {};
  for (const [sym, closes] of results) {
    if (closes) out[sym] = closes;
  }
  return new Response(JSON.stringify(out), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600', ...CORS_HEADERS },
  });
}
