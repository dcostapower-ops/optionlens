// StockVizor — Daily Stock Research Report Generator
// Deploy as: generate-research-stocks (--no-verify-jwt)
//
// Loops top 1000 tickers (by dollar volume) and generates a 300-500 word
// per-ticker research brief covering fundamental + technical highlights.
// Self-chains chunks of N tickers via fire-and-forget HTTP POST so a single
// trigger processes the entire universe in ~30-50 min.
//
// URL params:
//   ?limit=12&offset=0&stopAt=1000  → chunked processing
//   ?force=1                         → regenerate today's existing reports
//
// Cost target: ~$0.005 per ticker with Haiku 4.5 → ~$5/day for 1000 tickers.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://hkamukkkkpqhdpcradau.supabase.co';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANTH_KEY     = Deno.env.get('FRANK-API-ANTHROPIC') ?? Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const FN_URL       = `${SUPABASE_URL}/functions/v1/generate-research-stocks`;
const MODEL = 'claude-haiku-4-5-20251001';

Deno.serve(async (req: Request) => {
  if (!SUPABASE_KEY) return jerr('SUPABASE_SERVICE_ROLE_KEY not set');
  if (!ANTH_KEY)     return jerr('FRANK-API-ANTHROPIC not set');

  const t0 = Date.now();
  const url = new URL(req.url);
  const limit  = clamp(parseInt(url.searchParams.get('limit')  || '15', 10), 1, 25);
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));
  const stopAt = Math.max(1, parseInt(url.searchParams.get('stopAt') || '1000', 10));
  const force  = url.searchParams.get('force') === '1';
  const minPrice = parseFloat(url.searchParams.get('minPrice') || '5');
  const minVol   = parseFloat(url.searchParams.get('minVol')   || '500000');

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const todayISO = new Date().toISOString().slice(0, 10);

  // ── 1. Pull universe (top tickers by dollar volume) ─────────────────────
  const { data: latestRows, error: dtErr } = await supabase
    .from('ta_cache')
    .select('trading_date')
    .order('trading_date', { ascending: false })
    .limit(1);
  if (dtErr) return jerr(`ta_cache date query: ${dtErr.message}`);
  const dt = latestRows?.[0]?.trading_date;
  if (!dt) return jerr('No ta_cache data');

  // Fetch the rich ta_cache record per ticker so we have technicals for the prompt
  const { data: rows, error: tkErr } = await supabase
    .from('ta_cache')
    .select('ticker,price,sma20,sma50,sma200,rsi,macd_h,adx14,stoch_k,mom5,avg_vol20,sector,high52,low52,pct_from_52h,sc_state')
    .eq('trading_date', dt)
    .gte('price', minPrice)
    .gte('avg_vol20', minVol)
    .order('avg_vol20', { ascending: false })  // ensures highest-volume tickers survive Supabase's row cap
    .limit(8000);
  if (tkErr) return jerr(`ta_cache query: ${tkErr.message}`);

  const ranked = (rows || [])
    .filter(r => r.sector && r.sector !== 'ETF' && r.ticker)
    .map(r => ({ ...r, dv: (+r.price) * (+r.avg_vol20) }))
    .sort((a, b) => b.dv - a.dv);

  const totalUniverse = Math.min(stopAt, ranked.length);
  const chunk = ranked.slice(offset, Math.min(offset + limit, totalUniverse));

  if (chunk.length === 0) {
    return jres({ ok: true, done: true, offset, totalUniverse, duration_ms: Date.now() - t0 });
  }

  // ── 2. Pre-fetch watchlist tickers (image gen only for these) ───────────
  const { data: wlRows } = await supabase.from('user_watchlists').select('ticker');
  const watchlistSet = new Set<string>((wlRows || []).map((r: any) => r.ticker));

  // ── 3. For each ticker, generate a report ───────────────────────────────
  // Skip tickers already done today unless force=1.
  let succeeded = 0, failed = 0, skipped = 0;
  let totalCost = 0;
  const samples: any[] = [];

  for (const r of chunk) {
    if (!force) {
      const { data: existing } = await supabase
        .from('research_stock_reports')
        .select('id')
        .eq('ticker', r.ticker)
        .eq('report_date', todayISO)
        .maybeSingle();
      if (existing) { skipped++; continue; }
    }
    try {
      const report = await generateStockReport(r);
      if (!report) { failed++; continue; }
      const cost = report.cost_usd || 0;
      totalCost += cost;
      const { error: upErr } = await supabase
        .from('research_stock_reports')
        .upsert({
          ticker: r.ticker,
          report_date: todayISO,
          title: report.title,
          summary: report.summary,
          body_md: report.body_md,
          charts: report.charts,
          model: MODEL,
        }, { onConflict: 'ticker,report_date' });
      if (upErr) { failed++; samples.push({ ticker: r.ticker, error: upErr.message }); continue; }
      succeeded++;
      if (samples.length < 3) samples.push({ ticker: r.ticker, title: report.title, words: report.body_md.split(/\s+/).filter(Boolean).length });
      // Auto-generate images for watchlist stocks only (fire-and-forget)
      if (watchlistSet.has(r.ticker)) {
        fetch(`${SUPABASE_URL}/functions/v1/generate-research-images?type=stock&report_date=${encodeURIComponent(todayISO)}&ticker=${encodeURIComponent(r.ticker)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        }).catch(() => {});
      }
    } catch (e: any) {
      failed++;
      samples.push({ ticker: r.ticker, error: String(e?.message || e).slice(0, 200) });
    }
  }

  // ── 3. Self-fire next chunk ─────────────────────────────────────────────
  // Uses EdgeRuntime.waitUntil so the HTTP request is guaranteed to dispatch
  // before the Deno process terminates (plain fire-and-forget is silently lost).
  const nextOffset = offset + limit;
  let chained = false;
  if (nextOffset < totalUniverse) {
    try {
      const nextUrl = new URL(FN_URL);
      nextUrl.searchParams.set('limit',  String(limit));
      nextUrl.searchParams.set('offset', String(nextOffset));
      nextUrl.searchParams.set('stopAt', String(stopAt));
      if (force) nextUrl.searchParams.set('force', '1');
      const chainP = fetch(nextUrl.toString(), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      }).catch(() => {});
      // Keep the runtime alive until the chain request is dispatched
      try { (globalThis as any).EdgeRuntime.waitUntil(chainP); } catch {}
      chained = true;
    } catch {}
  }

  return jres({
    ok: true,
    offset, limit, nextOffset, totalUniverse, chained,
    chunk_size: chunk.length, succeeded, failed, skipped,
    total_cost_usd: round4(totalCost),
    duration_ms: Date.now() - t0,
    samples,
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PER-TICKER REPORT GENERATOR — calls Claude Haiku with rich technical context
// ────────────────────────────────────────────────────────────────────────────
async function generateStockReport(r: any): Promise<any> {
  const tickerLine = [
    `${r.ticker} · ${r.sector || 'Unknown sector'} · price $${(+r.price).toFixed(2)}`,
    `RSI(14): ${(+r.rsi || 0).toFixed(1)}`,
    `MACD histogram: ${(+r.macd_h || 0).toFixed(3)}`,
    `ADX(14): ${(+r.adx14 || 0).toFixed(1)}`,
    `Stoch %K: ${(+r.stoch_k || 0).toFixed(1)}`,
    `5-bar momentum: ${(+r.mom5 || 0).toFixed(2)}%`,
    `SMA20: $${(+r.sma20 || 0).toFixed(2)}`,
    `SMA50: $${(+r.sma50 || 0).toFixed(2)}`,
    `SMA200: $${(+r.sma200 || 0).toFixed(2)}`,
    `52w high: $${(+r.high52 || 0).toFixed(2)} (${(+r.pct_from_52h || 0).toFixed(1)}% from high)`,
    `52w low: $${(+r.low52 || 0).toFixed(2)}`,
    `Avg 20d volume: ${(+r.avg_vol20 / 1e6).toFixed(2)}M shares`,
    `VizSignal Smart-Candle state: ${r.sc_state || 'unknown'}`,
  ].join('\n');

  const system = `You are a senior equity research analyst writing concise stock briefs for retail investors at StockVizor. Each brief is 300-500 words. Be specific. Use the technical snapshot as ground truth — do NOT invent values.

OUTPUT FORMAT — return ONLY a single JSON object, no preamble, no markdown fence:

{
  "title":   "<8-12 word headline that frames the read>",
  "summary": "<1-sentence executive read, 20-30 words>",
  "body_md": "<300-500 words plain markdown. NO headers (#). 3-4 paragraphs covering: (1) technical state — what the indicators are saying, (2) fundamental context — sector, recent price behavior near key MAs and 52w high/low, (3) what to watch — concrete price levels for entry/exit/invalidation, (4) honest risks. Quote specific numbers from the snapshot.>",
  "chart_concepts": [
    // Single-series:
    {"title": "<chart title>", "type": "line|bar|area", "description": "<what it shows>", "x_label": "...", "y_label": "...", "data": [{"x": "...", "y": 0}, ...]}
    // Multi-series alternative (use for "price vs SMA50", "stock vs sector", etc.):
    // {"title": "...", "type": "line|area", "description": "...", "x_label": "...", "y_label": "...", "series": [
    //   {"name": "Price",  "data": [{"x":"...","y":0}, ...]},
    //   {"name": "SMA50",  "data": [{"x":"...","y":0}, ...]}
    // ]}
  ]
}

Rules:
- Body 300-500 words. No filler. No disclaimers — those live in the app footer.
- Use the SMA20/50/200 levels, RSI, MACD, ADX, momentum, and 52w high/low as ground truth.
- 1-2 chart concepts with 5-10 illustrative data points each.
- If the chart compares anything (price vs SMA, stock vs sector, current vs prior period), use the multi-series "series" shape. Otherwise use "data".
- For bar charts comparing indicator readings, you can add a threshold row like {"x":"Overbought (70)","y":70} and the renderer will draw it as a dashed reference line.
- Be direct: "Trading 18% from the 52-week high with momentum cooling" not "appears to potentially be showing some signs of weakness."`;

  const userMsg = `Today is ${new Date().toISOString().slice(0,10)}.

Technical snapshot for this ticker:
${tickerLine}

Generate the brief now.`;

  const r2 = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTH_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 6000,
      system,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!r2.ok) throw new Error(`Anthropic ${r2.status}: ${(await r2.text()).slice(0,200)}`);
  const j = await r2.json();
  const rawText = (j.content?.[0]?.text || '').trim();
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  let parsed: any;
  try { parsed = JSON.parse(cleaned); }
  catch { throw new Error(`JSON parse failed: ${cleaned.slice(0,150)}`); }
  if (!parsed?.title || !parsed?.body_md) throw new Error('Model response missing required fields');

  // Cost: Haiku 4.5 ~ $1/1M input + $5/1M output
  let cost_usd = 0;
  if (j.usage?.input_tokens) cost_usd += (j.usage.input_tokens / 1_000_000) * 1.0;
  if (j.usage?.output_tokens) cost_usd += (j.usage.output_tokens / 1_000_000) * 5.0;

  return {
    title:   String(parsed.title).slice(0, 300),
    summary: String(parsed.summary || '').slice(0, 500),
    body_md: String(parsed.body_md),
    charts:  Array.isArray(parsed.chart_concepts) ? parsed.chart_concepts.slice(0, 2) : null,
    cost_usd,
  };
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function round4(v: number) { return Math.round(v * 10000) / 10000; }
function jres(b: any, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }); }
function jerr(msg: string, s = 500) { return jres({ ok: false, error: msg }, s); }
