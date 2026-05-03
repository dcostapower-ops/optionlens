// ═══════════════════════════════════════════════════════════════════
// StockVizor — ai-summary Edge Function v2
// ═══════════════════════════════════════════════════════════════════
// Two AI summaries:
//   1. Market thesis (cache_key='market') — for ALL users, daily 5am ET
//   2. Personal watchlist analysis (cache_key='fdcosta-watchlist')
//      — ONLY for user_id matching FDCOSTA_UUID, daily 5am ET
//
// Triggers:
//   - Cron at 5am ET (9 UTC) — refreshes market + fdcosta watchlist
//   - news-fan-out event-driven on Fed/CPI/Jobs/GDP/geopolitical news
//   - Frontend GET (no force) — returns cached values
//
// Output: 800-1000 word market thesis, 600-800 word watchlist analysis,
// in markdown with embedded [CHART:XXX] and [IMAGE:topic=...] tokens
// for frontend rendering of charts and images.
//
// Approach: single-pass — Haiku marks where charts/images belong,
// frontend renders them deterministically.
// ═══════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANTHROPIC_KEY = Deno.env.get('FRANK-API-ANTHROPIC') ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MODEL = 'claude-haiku-4-5-20251001';
// Haiku 4.5 pricing per million tokens
const PRICE_INPUT_PER_M = 0.80;
const PRICE_OUTPUT_PER_M = 4.00;

// The one user (by UUID) who gets personal watchlist analysis
const FDCOSTA_UUID = 'bca7572d-c59f-4cf0-85e6-9ba5faf4ef36';
const FDCOSTA_CACHE_KEY = 'fdcosta-watchlist';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface NewsRow {
  id: string;
  publisher: string | null;
  headline: string;
  description: string | null;
  tickers: string[] | null;
  sentiment: string | null;
  category: string;
  published_at: string;
}

// ── Fetch recent world news for market overview ──
async function fetchWorldNews(limit = 25): Promise<NewsRow[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('news_cache')
    .select('id, publisher, headline, description, tickers, sentiment, category, published_at')
    .eq('category', 'world')
    .gte('published_at', since)
    .order('published_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`world news: ${error.message}`);
  return (data ?? []) as NewsRow[];
}

async function fetchUserWatchlist(userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('user_watchlists')
    .select('ticker')
    .eq('user_id', userId);
  if (error) return [];
  return [...new Set((data ?? []).map(r => r.ticker))];
}

async function fetchTickerNews(tickers: string[], limit = 40): Promise<NewsRow[]> {
  if (tickers.length === 0) return [];
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('news_cache')
    .select('id, publisher, headline, description, tickers, sentiment, category, published_at')
    .eq('category', 'stock')
    .overlaps('tickers', tickers)
    .gte('published_at', since)
    .order('published_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('ticker news err:', error.message);
    return [];
  }
  return (data ?? []) as NewsRow[];
}

function formatNewsForPrompt(articles: NewsRow[]): string {
  return articles.map((a, i) => {
    const tk = (a.tickers ?? []).slice(0, 5).join(',');
    const tkPart = tk ? ` [${tk}]` : '';
    const desc = a.description ? a.description.slice(0, 250) : '';
    return `${i + 1}. ${a.publisher || '?'}${tkPart}: ${a.headline}${desc ? ' — ' + desc : ''}`;
  }).join('\n');
}

// ── Build market thesis prompt (Option B — sharper, analyst-thesis tone) ──
function buildMarketPrompt(world: NewsRow[]): string {
  const newsText = formatNewsForPrompt(world);
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return `You are a senior market strategist writing today's morning thesis for a sophisticated retail investor.

Today's date: ${today}.

Today's political, economic, and macro news (last 24 hours):

${newsText}

Write a comprehensive market thesis in markdown that synthesizes these headlines into actionable analysis. Length: 800-1000 words.

STRUCTURE:
1. Opening paragraph (~80 words) — the dominant narrative shaping markets today.
2. Three sections, one per major catalyst, using ### headers. Each section (~200-250 words):
   - The catalyst (concrete: who, what, when)
   - Market read (what it implies for US equities, rates, dollar)
   - Sectors most exposed (specific: name 2-3 sectors and why)
   - One inline chart token where a chart would illustrate the point
3. Closing paragraph (~100 words) — risk sentiment summary, trades to watch (NOT recommend), key data on the calendar.

CHART/IMAGE TOKENS — embed these in your output where visuals would strengthen the narrative:
- \`[CHART:SPY]\` — S&P 500 chart for general equity sentiment
- \`[CHART:VIX]\` — volatility chart when discussing risk/fear
- \`[CHART:DXY]\` — dollar index when discussing currency
- \`[CHART:TLT]\` — 20+ year Treasury chart for rates discussion
- \`[CHART:XLE]\`, \`[CHART:XLF]\`, \`[CHART:XLK]\`, \`[CHART:XLV]\`, \`[CHART:XLI]\`, \`[CHART:XLY]\`, \`[CHART:XLP]\`, \`[CHART:XLU]\` — sector ETFs
- \`[CHART:GLD]\`, \`[CHART:USO]\` — gold, oil
- \`[IMAGE:topic=fed]\`, \`[IMAGE:topic=ecb]\`, \`[IMAGE:topic=earnings]\`, \`[IMAGE:topic=geopolitics]\`, \`[IMAGE:topic=inflation]\` — illustrative photos

Place each token on its OWN LINE between paragraphs. Include 3-5 chart tokens total (one per section ideally) and EXACTLY 2-3 image tokens (mandatory — choose topics that match the narrative). Don't cluster.

GUIDELINES:
- Be analytical, not promotional.
- Do NOT give buy/sell recommendations or price targets.
- Use sentence-case headers, not Title Case.
- Bold key terms with **markdown**.
- End with: "**Updated**: ${today}"`;
}

// ── Build personal watchlist prompt (only for fdcosta) ──
function buildWatchlistPrompt(world: NewsRow[], tickerNews: NewsRow[], tickers: string[]): string {
  const worldText = world.length > 0 ? formatNewsForPrompt(world.slice(0, 10)) : '(no major world news)';
  const tickerText = tickerNews.length > 0
    ? formatNewsForPrompt(tickerNews)
    : '(no recent news for these tickers)';
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return `You are a senior equity analyst writing today's personal watchlist briefing for an investor tracking these tickers: ${tickers.join(', ')}.

Today's date: ${today}.

## Today's macro context (top 10 world headlines)

${worldText}

## News on watched tickers (last 48 hours)

${tickerText}

Write a comprehensive watchlist analysis in markdown. Length: 600-800 words.

STRUCTURE:
1. Opening paragraph (~60 words) — the macro lens through which to view your portfolio today.
2. Per-ticker analysis using ### headers, ordered by news significance (most material first):
   - For each ticker WITH news: 80-120 words on what the news is, why it matters, second-order effects (sector peers, suppliers, customers).
   - Include one [CHART:XXX] token per ticker section to visualize.
   - Tickers with NO news: group at the end in one paragraph: "**Quiet today:** TICKER1, TICKER2, ... — no material news; watch for [specific catalyst, e.g., next earnings, sector rotation]."
3. Closing paragraph (~80 words) — portfolio-level themes (concentration risks, sector tilt, what to monitor).

CHART/IMAGE TOKENS:
- \`[CHART:SYMBOL]\` — for any ticker, embed a price chart of that ticker
- \`[CHART:SPY]\` — for broader market context
- \`[IMAGE:topic=earnings]\` if discussing earnings
- \`[IMAGE:topic=technology]\` if discussing AI/tech
- \`[IMAGE:topic=fed]\` if discussing rates context

Place each token on its OWN LINE between paragraphs. One chart per ticker section (so ~5-8 charts total). Also include EXACTLY 2-3 image tokens distributed through the briefing where the topic is relevant.

GUIDELINES:
- Speak directly to the investor: "Your" position, "Your" exposure.
- Be analytical, not promotional. No buy/sell advice or price targets.
- Use sentence-case headers.
- Bold key terms with **markdown**.
- End with: "**Updated**: ${today}"`;
}

// ── Call Anthropic ──
interface ClaudeResp {
  text: string;
  input_tokens: number;
  output_tokens: number;
}
async function callClaude(prompt: string, maxTokens = 2000): Promise<ClaudeResp> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Anthropic API ${r.status}: ${err.slice(0, 300)}`);
  }
  const j = await r.json();
  const text = (j.content?.[0]?.text ?? '').trim();
  const usage = j.usage ?? {};
  return {
    text,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
  };
}

function computeCost(input: number, output: number): number {
  return (input * PRICE_INPUT_PER_M / 1e6) + (output * PRICE_OUTPUT_PER_M / 1e6);
}

async function getCached(cacheKey: string): Promise<any | null> {
  const { data } = await supabase
    .from('dashboard_ai_cache')
    .select('*')
    .eq('cache_key', cacheKey)
    .maybeSingle();
  if (!data) return null;
  if (new Date(data.expires_at) < new Date()) return null;
  return data;
}

async function generateMarketThesis(): Promise<any> {
  const world = await fetchWorldNews(25);
  if (world.length === 0) {
    return {
      summary_md: '_No recent market news available right now. Check back shortly._',
      source_news_ids: [],
      cost: 0, input_tokens: 0, output_tokens: 0,
    };
  }
  const prompt = buildMarketPrompt(world);
  const resp = await callClaude(prompt, 2400);  // higher max for 1000-word output
  return {
    summary_md: resp.text,
    source_news_ids: world.map(n => n.id),
    cost: computeCost(resp.input_tokens, resp.output_tokens),
    input_tokens: resp.input_tokens,
    output_tokens: resp.output_tokens,
  };
}

async function generateWatchlistAnalysis(userId: string): Promise<any> {
  const tickers = await fetchUserWatchlist(userId);
  if (tickers.length === 0) {
    return {
      summary_md: '_No tickers in watchlist. Add some to see personalized analysis._',
      source_news_ids: [],
      watchlist_tickers: [],
      cost: 0, input_tokens: 0, output_tokens: 0,
    };
  }
  const [world, tickerNews] = await Promise.all([
    fetchWorldNews(10),
    fetchTickerNews(tickers, 40),
  ]);
  const prompt = buildWatchlistPrompt(world, tickerNews, tickers);
  const resp = await callClaude(prompt, 2000);  // 800-word output
  const newsIds = [...world.map(n => n.id), ...tickerNews.map(n => n.id)];
  return {
    summary_md: resp.text,
    source_news_ids: newsIds,
    watchlist_tickers: tickers,
    cost: computeCost(resp.input_tokens, resp.output_tokens),
    input_tokens: resp.input_tokens,
    output_tokens: resp.output_tokens,
  };
}

async function saveCache(cacheKey: string, userId: string | null, gen: any): Promise<void> {
  const now = new Date();
  // Daily expiry; cron runs at 5am ET. Set expires_at to ~25h from now so a missed
  // cron doesn't immediately invalidate. Event-driven regen will replace as needed.
  const expires = new Date(now.getTime() + 25 * 60 * 60 * 1000);
  await supabase.from('dashboard_ai_cache').upsert({
    cache_key: cacheKey,
    user_id: userId,
    summary_md: gen.summary_md,
    source_news_ids: gen.source_news_ids ?? null,
    watchlist_tickers: gen.watchlist_tickers ?? null,
    ticker_count: (gen.watchlist_tickers ?? []).length,
    generated_at: now.toISOString(),
    expires_at: expires.toISOString(),
    cost_usd: gen.cost,
    input_tokens: gen.input_tokens,
    output_tokens: gen.output_tokens,
    model: MODEL,
  }, { onConflict: 'cache_key' });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!ANTHROPIC_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Anthropic key not configured' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  let body: any = {};
  try {
    if (req.method === 'POST' && req.headers.get('content-length') !== '0') {
      body = await req.json();
    }
  } catch (e) {}

  const userId: string | null = body?.user_id ?? null;
  const force: boolean = body?.force === true;
  const eventTrigger: string | null = body?.event_trigger ?? null;
  const t0 = Date.now();

  try {
    // Always check / generate market thesis
    const marketKey = 'market';
    let market = force ? null : await getCached(marketKey);
    let marketGenerated = false;
    if (!market) {
      const gen = await generateMarketThesis();
      await saveCache(marketKey, null, gen);
      market = {
        cache_key: marketKey, summary_md: gen.summary_md,
        generated_at: new Date().toISOString(),
        cost_usd: gen.cost, input_tokens: gen.input_tokens, output_tokens: gen.output_tokens,
      };
      marketGenerated = true;
    }

    // Watchlist analysis: ONLY for fdcosta UUID, both for cron (no userId in body but force=true) and direct calls
    // When triggered by cron or event with no user_id, generate watchlist for fdcosta automatically
    let user: any = null;
    let userGenerated = false;
    const shouldGenerateWatchlist = (force && !userId) || (userId === FDCOSTA_UUID);

    if (shouldGenerateWatchlist) {
      const wlKey = FDCOSTA_CACHE_KEY;
      user = force ? null : await getCached(wlKey);
      if (!user) {
        const gen = await generateWatchlistAnalysis(FDCOSTA_UUID);
        await saveCache(wlKey, FDCOSTA_UUID, gen);
        user = {
          cache_key: wlKey, summary_md: gen.summary_md,
          generated_at: new Date().toISOString(),
          watchlist_tickers: gen.watchlist_tickers,
          cost_usd: gen.cost, input_tokens: gen.input_tokens, output_tokens: gen.output_tokens,
        };
        userGenerated = true;
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      duration_ms: Date.now() - t0,
      event_trigger: eventTrigger,
      market: {
        summary_md: market.summary_md,
        generated_at: market.generated_at,
        cached: !marketGenerated,
      },
      user: user ? {
        summary_md: user.summary_md,
        generated_at: user.generated_at,
        watchlist_tickers: user.watchlist_tickers,
        cached: !userGenerated,
      } : null,
    }, null, 2), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });

  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      duration_ms: Date.now() - t0,
      error: String(e).slice(0, 500),
    }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
