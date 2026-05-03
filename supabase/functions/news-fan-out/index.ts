// ═══════════════════════════════════════════════════════════════════
// StockVizor — news-fan-out Edge Function
// ═══════════════════════════════════════════════════════════════════
// Purpose: Fetch financial news from EODHD, categorize into world/stock
//          buckets, UPSERT to news_cache.
//
// Logic:
//   1. Fetch ~50 latest articles from EODHD general news endpoint
//   2. For each article:
//      - Extract US tickers from `symbols` (strip .US suffix)
//      - If any US ticker is in our 3,983 universe → category='stock'
//      - Else → category='world'
//   3. Map sentiment polarity → 'positive' | 'neutral' | 'negative' label
//   4. Derive publisher from the link domain
//   5. UPSERT on external_id (deduped across runs)
//   6. Update cache_health
//
// Schedule: every 15 min (handles 24/7 since news flow regardless of market)
// ═══════════════════════════════════════════════════════════════════
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const EODHD_KEY = Deno.env.get('EODHD_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const FETCH_LIMIT = 50; // Articles per cron run
// Map polarity to a sentiment label
function sentimentLabel(polarity) {
  if (polarity == null) return 'neutral';
  if (polarity > 0.15) return 'positive';
  if (polarity < -0.15) return 'negative';
  return 'neutral';
}
// Extract publisher name from URL domain
// Examples:
//   https://uk.finance.yahoo.com/news/... → "Yahoo Finance"
//   https://seekingalpha.com/...           → "Seeking Alpha"
//   https://www.reuters.com/...            → "Reuters"
function publisherFromUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^uk\./, '').replace(/^.+?finance\./, 'finance.'); // yahoo finance subdomain handling
    const map = {
      'finance.yahoo.com': 'Yahoo Finance',
      'yahoo.com': 'Yahoo',
      'seekingalpha.com': 'Seeking Alpha',
      'reuters.com': 'Reuters',
      'bloomberg.com': 'Bloomberg',
      'cnbc.com': 'CNBC',
      'marketwatch.com': 'MarketWatch',
      'wsj.com': 'WSJ',
      'ft.com': 'FT',
      'investing.com': 'Investing.com',
      'forbes.com': 'Forbes',
      'businessinsider.com': 'Business Insider',
      'thestreet.com': 'TheStreet',
      'fool.com': 'Motley Fool',
      'zacks.com': 'Zacks',
      'barrons.com': "Barron's",
      'benzinga.com': 'Benzinga',
      'kiplinger.com': 'Kiplinger',
      'morningstar.com': 'Morningstar',
      'investopedia.com': 'Investopedia',
      'fxstreet.com': 'FXStreet',
      'u.today': 'U.Today',
      'coindesk.com': 'CoinDesk',
      'cointelegraph.com': 'Cointelegraph',
      'theblock.co': 'The Block',
      'crypto.news': 'Crypto.news'
    };
    if (map[host]) return map[host];
    // Fallback: if first segment is too short (1-2 chars) use whole host with first letter capitalized
    const root = host.split('.')[0];
    if (root.length <= 2) {
      // "u.today" -> "U.today"
      return host.charAt(0).toUpperCase() + host.slice(1);
    }
    return root.charAt(0).toUpperCase() + root.slice(1);
  } catch  {
    return 'Unknown';
  }
}
// Strip exchange suffix to get ticker
//   "AAPL.US" -> "AAPL"
//   "BP.LSE"  -> null (non-US)
function usTickerOnly(symWithSuffix) {
  if (!symWithSuffix) return null;
  if (symWithSuffix.endsWith('.US')) return symWithSuffix.slice(0, -3);
  // No suffix at all — assume US
  if (!symWithSuffix.includes('.')) return symWithSuffix;
  return null;
}
// Fetch latest news from EODHD
async function fetchEodhdNews() {
  const url = `https://eodhd.com/api/news?api_token=${EODHD_KEY}&limit=${FETCH_LIMIT}&fmt=json`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'StockVizor/1.0'
    }
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`EODHD news fetch failed: HTTP ${r.status} ${txt.slice(0, 200)}`);
  }
  // EODHD's content sometimes has bad control chars in JSON — try to parse defensively
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch  {
    // Strip control chars (except tabs/newlines/CR) and retry
    const cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');
    return JSON.parse(cleaned);
  }
}
// Load universe (set of US tickers we track)
async function loadUniverse() {
  const { data } = await supabase.from('app_config').select('value').eq('key', 'ta_ticker_universe').limit(1);
  if (!data?.length) return new Set();
  const raw = data[0].value;
  const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return new Set(Array.isArray(arr) ? arr : []);
}
async function recordHealth(opts) {
  const status = opts.failed === 0 && opts.updated > 0 ? 'healthy' : opts.updated > 0 ? 'partial' : 'failed';
  await supabase.from('cache_health').upsert({
    cache_name: 'news_cache',
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
  if (!EODHD_KEY || !SUPABASE_KEY) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'missing keys'
    }), {
      status: 500
    });
  }
  try {
    // 1. Fetch news + universe in parallel
    const [articles, universe] = await Promise.all([
      fetchEodhdNews(),
      loadUniverse()
    ]);
    if (!Array.isArray(articles)) {
      throw new Error('EODHD returned non-array response');
    }
    // 2. Process each article
    const rows = [];
    const fetched = new Date().toISOString();
    let world = 0, stock = 0;
    for (const a of articles){
      const link = a.link ?? '';
      // external_id: stable hash of link (since EODHD doesn't provide an explicit ID).
      // Using link + date as the dedup key.
      const externalId = a.id ?? `${link}::${a.date ?? ''}`;
      if (!a.title || !link) continue;
      // Extract symbols, dedup, US-only, intersect with universe
      const symbols = Array.isArray(a.symbols) ? a.symbols : [];
      const usTickersAll = symbols.map(usTickerOnly).filter((t)=>t !== null);
      const universeTickers = usTickersAll.filter((t)=>universe.has(t));
      const category = universeTickers.length > 0 ? 'stock' : 'world';
      if (category === 'stock') stock++;
      else world++;
      const polarity = a.sentiment?.polarity != null ? Number(a.sentiment.polarity) : null;
      const sentLabel = sentimentLabel(polarity);
      const pub = publisherFromUrl(link);
      // Use universe tickers for stock category, all-symbol-for-display for context
      const tickersToStore = category === 'stock' ? universeTickers : usTickersAll;
      // Description: first 200 chars of content (or null if missing)
      let desc = null;
      if (typeof a.content === 'string' && a.content.length > 0) {
        const trimmed = a.content.replace(/\s+/g, ' ').trim();
        desc = trimmed.slice(0, 280) + (trimmed.length > 280 ? '…' : '');
      }
      rows.push({
        external_id: String(externalId).slice(0, 500),
        publisher: pub,
        headline: String(a.title).slice(0, 500),
        description: desc,
        url: link,
        source_link: link,
        tickers: tickersToStore,
        sentiment: sentLabel,
        sentiment_polarity: polarity,
        category,
        published_at: a.date ? new Date(a.date).toISOString() : new Date().toISOString(),
        fetched_at: fetched
      });
    }
    // 3. UPSERT to news_cache (dedup via external_id UNIQUE)
    let written = 0;
    if (rows.length > 0) {
      const { error } = await supabase.from('news_cache').upsert(rows, {
        onConflict: 'external_id'
      });
      if (error) {
        throw new Error(`UPSERT failed: ${error.message}`);
      }
      written = rows.length;
    }
    // 3b. ─── HIGH-IMPACT EVENT DETECTION ───
    // Scan newly-written articles for major macro / geopolitical signals.
    // If matched AND debounce window elapsed, trigger ai-summary regen.
    let eventTrigger: string | null = null;
    try {
      // Patterns ordered by specificity. First match wins.
      const patterns: Array<[string, RegExp]> = [
        ['fed-decision', /\b(federal reserve|fomc|powell)\b.*\b(decision|rate|hike|cut|meeting|minutes|holds|raised|lowered)\b/i],
        ['cpi-print', /\b(cpi|ppi|consumer prices|core prices|core cpi|core ppi|inflation report)\b/i],
        ['jobs-report', /\b(nonfarm|payrolls|jobs report|unemployment rate|jobless claims)\b/i],
        ['gdp-release', /\b(gdp|gross domestic product)\b.*\b(quarter|q[1-4]|release|reading|revised|advance|preliminary)\b/i],
        ['ecb-decision', /\b(ecb|european central bank|lagarde)\b.*\b(decision|rate|hike|cut|meeting)\b/i],
        ['boj-intervention', /\b(boj|bank of japan|yen intervention|usd\/jpy)\b/i],
        ['geopolitical', /\b(war|invasion|sanctions imposed|tariff|trade war|strait of hormuz|red sea attacks|missile strike)\b/i],
      ];
      for (const r of rows) {
        if (r.category !== 'world') continue;
        const text = (r.headline || '') + ' ' + (r.description || '');
        for (const [tag, pattern] of patterns) {
          if (pattern.test(text)) {
            eventTrigger = tag;
            break;
          }
        }
        if (eventTrigger) break;
      }
      if (eventTrigger) {
        // Debounce: check last trigger time stored in cache_health.last_error
        // (re-using a free string field; no schema change needed for v1)
        const { data: ch } = await supabase
          .from('cache_health').select('last_error, last_run_at')
          .eq('cache_name', 'ai_summary_event_trigger').maybeSingle();
        const lastTriggerIso = ch?.last_run_at;
        const hoursSince = lastTriggerIso
          ? (Date.now() - new Date(lastTriggerIso).getTime()) / (60 * 60 * 1000)
          : 999;
        if (hoursSince > 2) {
          // Fire-and-forget call to ai-summary with force=true
          const ANON_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
          const aiUrl = (Deno.env.get('SUPABASE_URL') ?? '') + '/functions/v1/ai-summary';
          // Don't await — let it run in the background; news-fan-out shouldn't block
          fetch(aiUrl, {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + ANON_KEY,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ force: true, event_trigger: eventTrigger }),
          }).catch(e => console.warn('[news] ai-summary trigger failed:', e.message));
          // Record trigger time for debounce
          await supabase.from('cache_health').upsert({
            cache_name: 'ai_summary_event_trigger',
            last_run_at: new Date().toISOString(),
            last_error: eventTrigger,
            status: 'healthy',
            updated_at: new Date().toISOString(),
          }, { onConflict: 'cache_name' });
          console.log(`[news] event-trigger fired: ${eventTrigger}`);
        } else {
          console.log(`[news] event '${eventTrigger}' detected but debounced (${hoursSince.toFixed(1)}h ago)`);
          eventTrigger = null;  // signal for response that no trigger fired
        }
      }
    } catch (e) {
      console.warn('[news] event-detection error:', (e as Error).message);
    }
    // 4. Trim retention: delete articles older than 3 days to keep table lean
    const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('news_cache').delete().lt('published_at', cutoff);
    const dur = Date.now() - t0;
    await recordHealth({
      attempted: articles.length,
      updated: written,
      failed: articles.length - written,
      durationMs: dur
    });
    return new Response(JSON.stringify({
      ok: true,
      duration_ms: dur,
      articles_received: articles.length,
      written,
      breakdown: {
        world,
        stock
      },
      event_trigger: eventTrigger,
      sample_world: rows.find((r)=>r.category === 'world')?.headline?.slice(0, 80),
      sample_stock: rows.find((r)=>r.category === 'stock')?.headline?.slice(0, 80)
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