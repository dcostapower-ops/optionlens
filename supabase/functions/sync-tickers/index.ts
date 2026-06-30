// StockVizor — Ticker Universe Sync
// Deploy as: sync-tickers (--no-verify-jwt)
//
// Paginates Polygon's /v3/reference/tickers to collect all active US equities
// and ETFs, then upserts the full map into app_config.company_info.
//
// Run once manually to seed, then weekly via cron to keep current.
//
// URL params:
//   ?dry_run=1      — fetch & count tickers but do NOT write to DB
//   ?merge=1        — merge with existing company_info instead of replacing (default: replace)
//   ?types=CS,ETF   — comma-separated Polygon type codes to include (default: CS,ETF,ETV,ETS)
//
// Output:
//   { ok, total, by_type, duration_ms, dry_run? }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://hkamukkkkpqhdpcradau.supabase.co';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const POLY_KEY     = Deno.env.get('POLYGON_API_KEY') ?? Deno.env.get('POLYGON_KEY') ?? '';

// Max pages per type (1000 tickers/page × 25 = 25,000 max)
const MAX_PAGES = 25;

Deno.serve(async (req: Request) => {
  if (!SUPABASE_KEY) return jerr('SUPABASE_SERVICE_ROLE_KEY not set');
  if (!POLY_KEY)     return jerr('POLYGON_API_KEY not set');

  const t0 = Date.now();
  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dry_run') === '1';
  const merge  = url.searchParams.get('merge')   === '1';
  const types  = (url.searchParams.get('types') || 'CS,ETF,ETV,ETS').split(',').map(t => t.trim()).filter(Boolean);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── 1. Optionally fetch existing company_info to merge into ───────────────
  let existing: Record<string, [string, string]> = {};
  if (merge) {
    try {
      const { data } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'company_info')
        .single();
      if (data?.value) {
        for (const [tk, info] of Object.entries(data.value as any)) {
          const name = Array.isArray(info) ? info[0] : (typeof info === 'string' ? info : (info as any)?.name ?? tk);
          const exch = Array.isArray(info) ? (info[1] ?? 'US') : 'US';
          existing[tk] = [name, exch];
        }
      }
    } catch (_) {}
  }

  // ── 2. Paginate Polygon reference tickers ─────────────────────────────────
  // Default mode: fresh Polygon data only (no legacy cruft)
  const merged: Record<string, [string, string]> = { ...existing };
  const byType: Record<string, number> = {};

  for (const type of types) {
    let nextUrl: string | null =
      `https://api.polygon.io/v3/reference/tickers?market=stocks&locale=us&type=${type}&active=true&limit=1000&sort=ticker&apiKey=${POLY_KEY}`;
    let page = 0;
    let count = 0;

    while (nextUrl && page < MAX_PAGES) {
      const resp = await fetch(nextUrl, { headers: { 'User-Agent': 'StockVizor/1.0' } });
      if (!resp.ok) {
        const err = await resp.text().catch(() => '');
        return jerr(`Polygon ${resp.status} (type=${type}): ${err.slice(0, 200)}`);
      }
      const j = await resp.json();
      for (const t of (j.results ?? [])) {
        if (!t.ticker || !t.name) continue;
        // Skip tickers with punctuation (warrants, notes, etc.) — keep clean symbols
        if (/[^A-Z0-9\.]/.test(t.ticker)) continue;
        merged[t.ticker] = [t.name, t.primary_exchange ?? 'US'];
        count++;
      }
      // Polygon returns next_url without the API key — append it
      nextUrl = j.next_url ? `${j.next_url}&apiKey=${POLY_KEY}` : null;
      page++;
    }

    byType[type] = count;
  }

  const total = Object.keys(merged).length;

  // ── 3. Upsert to app_config ────────────────────────────────────────────────
  if (!dryRun) {
    const { error } = await supabase
      .from('app_config')
      .upsert({ key: 'company_info', value: merged }, { onConflict: 'key' });
    if (error) return jerr(`Upsert failed: ${error.message}`);
  }

  return jres({
    ok: true,
    total,
    by_type: byType,
    duration_ms: Date.now() - t0,
    ...(dryRun ? { dry_run: true, note: 'DB not written — remove ?dry_run=1 to persist' } : {}),
  });
});

function jres(b: any, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
}
function jerr(msg: string, s = 500) { return jres({ ok: false, error: msg }, s); }
