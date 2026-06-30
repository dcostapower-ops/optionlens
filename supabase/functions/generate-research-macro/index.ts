// StockVizor — Daily Macro Research Report Generator
// Deploy as: generate-research-macro (--no-verify-jwt)
//
// Runs once daily at ~09:00 UTC (5 AM ET). Calls Claude Haiku 4.5 to produce
// a structured macro brief covering economic + economy-related political news.
// Output: 800-1200 words, 2-3 chart concepts, 3 image concepts, sources.
// Result stored in research_macro_reports (one row per date).
//
// Cost target: ~$0.015 per run with Haiku 4.5 (input + output tokens).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://hkamukkkkpqhdpcradau.supabase.co';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
// Anthropic key is stored as FRANK-API-ANTHROPIC in Supabase function secrets.
// (Hyphens in env var names need bracket-notation access in Deno.)
const ANTH_KEY     = Deno.env.get('FRANK-API-ANTHROPIC') ?? Deno.env.get('ANTHROPIC_API_KEY') ?? '';

// Pinned model. Update when newer Haiku ships.
const MODEL = 'claude-haiku-4-5-20251001';

Deno.serve(async (req: Request) => {
  if (!SUPABASE_KEY) return jerr('SUPABASE_SERVICE_ROLE_KEY not set');
  if (!ANTH_KEY)     return jerr('ANTHROPIC_API_KEY not set');

  const url = new URL(req.url);
  const force = url.searchParams.get('force') === '1';
  const amend = url.searchParams.get('amend') === '1';   // mid-day amendment
  const t0 = Date.now();

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── 1. Today's date (US Eastern). Skip if already generated unless forced. ─
  const todayISO = new Date().toISOString().slice(0, 10);
  if (!force) {
    const { data: existing } = await supabase
      .from('research_macro_reports')
      .select('id, generated_at, amended')
      .eq('report_date', todayISO)
      .maybeSingle();
    if (existing && !amend) {
      return jres({
        ok: true, skipped: true,
        reason: 'Already generated for today; pass ?force=1 to override or ?amend=1 for amendment',
        report_id: existing.id, generated_at: existing.generated_at,
      });
    }
  }

  // ── 2. Pull market snapshot from ta_cache to ground the AI in real values ─
  const tapeTickers = ['SPY', 'QQQ', 'IWM', 'VIX', 'TLT', 'GLD', 'DXY'];
  const { data: tapeRows } = await supabase
    .from('ta_cache')
    .select('ticker, price, sma50, sma200, rsi, trading_date')
    .in('ticker', tapeTickers)
    .order('trading_date', { ascending: false })
    .limit(20);
  const tape = (tapeRows || []).reduce((acc: Record<string, any>, r) => {
    if (!acc[r.ticker]) acc[r.ticker] = r;
    return acc;
  }, {});
  const tapeBlock = tapeTickers.map(t => {
    const r = tape[t];
    return r ? `${t}: $${(+r.price).toFixed(2)}  RSI=${(+r.rsi||0).toFixed(1)}` : `${t}: (no data)`;
  }).join('\n');

  // ── 3. Build prompt + call Claude Haiku ──────────────────────────────────
  const system = `You are a senior macro economist writing a daily research brief for retail investors at StockVizor. Your job is to translate today's economic and political environment into clear, actionable market context — the kind of brief a buy-side analyst writes before market open.

OUTPUT FORMAT — return ONLY a single JSON object, no preamble, no markdown fence. The frontend parses on the exact keys below.

{
  "title":         "Daily Macro Brief — <8-12 word theme of the day>",
  "summary":       "<2-sentence executive summary, 25-40 words>",
  "body_md":       "<5-7 paragraphs of plain markdown. NO headers (#). 800-1200 words total. Cover: (1) what changed in the last 24 hours, (2) Fed/macro indicator readings, (3) economy-related political news ONLY if it affects markets, (4) sector rotation themes, (5) the forward-looking implication for retail investors. Quote specific levels (DXY 105.40, 10Y at 4.32%) and use the market snapshot below as ground truth.>",
  "image_concepts": [
    {"description": "<concrete scene/subject for a stylized illustration>", "alt": "<short alt text>"},
    {"description": "...", "alt": "..."},
    {"description": "...", "alt": "..."}
  ],
  "chart_concepts": [
    // For a SINGLE-series chart use this shape:
    {"title": "<chart title>", "type": "line|bar|area", "description": "<what it shows>", "x_label": "...", "y_label": "...", "data": [{"x": "...", "y": 0}, ...]},
    // For a MULTI-series comparison (e.g. "Market vs Fed Guidance") use this shape instead:
    {"title": "...", "type": "line|area", "description": "...", "x_label": "...", "y_label": "...", "series": [
      {"name": "Market pricing", "data": [{"x": "May 2025", "y": 5.33}, ...]},
      {"name": "Fed guidance",   "data": [{"x": "May 2025", "y": 5.30}, ...]}
    ]}
  ],
  "sources":       ["<source url or descriptive label>", "..."]
}

Rules:
- Body must be 800-1200 words. Be specific. No hedging-only "could/might/possibly" prose.
- Image concepts: NO copyrighted/specific people. Stylized scenes only ("dawn over the Federal Reserve building", "currency exchange rate visualization", "trading floor at market open"). 3 images.
- Chart concepts: 2-3 charts. Include sample/illustrative data arrays (5-12 points each).
  · If the chart compares two or more things (any title with "vs", "compared", "divergence", "actual vs forecast", etc.), you MUST use the multi-series shape with a "series" array. NEVER cram two stories into one line.
  · Single-series charts: use the "data" array.
  · BAR chart for category comparison (e.g. "RSI across indices"): use "data" with x = category name. If you want to mark a threshold (e.g. overbought 70, neutral 50), add an extra entry with x like "Overbought (70)" — the renderer will draw it as a dashed reference line, not a bar.
  · Make sure each series shares the SAME x-axis values in the same order.
- Sources: 2-5 references (can be descriptive labels like "Bureau of Labor Statistics CPI release" if no URL).
- Address political news ONLY when it has direct market implications (rate decisions, budget, trade policy, tariffs). Skip pure-politics.`;

  const userMsg = `Today is ${todayISO}.

Latest market snapshot from our database (use these as ground truth for current levels):
${tapeBlock}

Generate today's macro brief covering the most important economic developments and their market implications. Return the structured JSON now.`;

  let parsed: any = null;
  let rawText = '';
  let usage: any = null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTH_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    if (!r.ok) {
      const errBody = await r.text();
      return jerr(`Anthropic ${r.status}: ${errBody.slice(0, 400)}`);
    }
    const j = await r.json();
    rawText = (j.content?.[0]?.text || '').trim();
    usage = j.usage;
    // Strip any accidental markdown fence
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    try { parsed = JSON.parse(cleaned); }
    catch (e) {
      return jerr(`Could not parse JSON from model. Raw first 400 chars: ${cleaned.slice(0, 400)}`);
    }
  } catch (e: any) {
    return jerr(`Anthropic call failed: ${String(e?.message || e)}`);
  }

  if (!parsed?.title || !parsed?.body_md) {
    return jerr('Model response missing required fields (title, body_md)');
  }

  // ── 4. Cost calculation (rough Haiku 4.5 pricing) ────────────────────────
  // Input $1/1M tokens, output $5/1M tokens (approximate; update as pricing evolves)
  let cost_usd: number | null = null;
  if (usage?.input_tokens && usage?.output_tokens) {
    cost_usd = (usage.input_tokens / 1_000_000) * 1.0 + (usage.output_tokens / 1_000_000) * 5.0;
  }

  // ── 5. Upsert into research_macro_reports ───────────────────────────────
  const row = {
    report_date: todayISO,
    title:       String(parsed.title).slice(0, 500),
    summary:     String(parsed.summary || '').slice(0, 1000),
    body_md:     String(parsed.body_md),
    charts:      Array.isArray(parsed.chart_concepts) ? parsed.chart_concepts : null,
    images:      Array.isArray(parsed.image_concepts) ? parsed.image_concepts : null,
    sources:     Array.isArray(parsed.sources)        ? parsed.sources.map((s: any) => String(s)).slice(0, 10) : null,
    model:       MODEL,
    cost_usd,
    amended:     !!amend,
  };
  const { data: upserted, error: upErr } = await supabase
    .from('research_macro_reports')
    .upsert(row, { onConflict: 'report_date' })
    .select('id, report_date, generated_at')
    .single();
  if (upErr) return jerr(`Upsert error: ${upErr.message}`);

  // ── 6. Auto-generate images (fire-and-forget — doesn't block this response) ─
  fetch(`${SUPABASE_URL}/functions/v1/generate-research-images?type=macro&report_date=${encodeURIComponent(todayISO)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
  }).catch(() => {});

  return jres({
    ok: true,
    report_id: upserted?.id,
    report_date: upserted?.report_date,
    generated_at: upserted?.generated_at,
    cost_usd,
    word_count: row.body_md.split(/\s+/).filter(Boolean).length,
    n_images: row.images?.length ?? 0,
    n_charts: row.charts?.length ?? 0,
    duration_ms: Date.now() - t0,
    amended: !!amend,
  });
});

function jres(b: any, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
}
function jerr(msg: string, s = 500) { return jres({ ok: false, error: msg }, s); }
