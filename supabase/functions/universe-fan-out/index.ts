// ═══════════════════════════════════════════════════════════════════
// StockVizor — universe-fan-out Edge Function
// ═══════════════════════════════════════════════════════════════════
// Purpose: Daily refresh of ta_ticker_universe.
//
// Logic:
//   1. Fetch all active US tickers from Massive /v3/reference/tickers (paginated)
//   2. Filter to: type ∈ {CS, ADR, ETF}, exchange ∈ {NYSE, NASDAQ, AMEX}
//   3. For all candidates: fetch snapshot for current price + volume
//   4. Apply liquid filter: price >= $2 AND dollar volume >= $5M
//   5. Compute additions: new symbols (not currently in universe) that meet criteria
//   6. Compute potential removals: symbols in universe missing from active reference list
//      - Mark as `missing_since` = today
//      - Only REMOVE after 3 consecutive days of missing (delisting confirmation)
//   7. Safety cap: skip removals if > 1% of universe would be removed in one run
//   8. Update ta_ticker_universe (app_config), log to universe_changes
//
// Schedule: daily at 1am ET = 6am UTC
// ═══════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const POLYGON_BASE = 'https://api.polygon.io';
const POLYGON_KEY  = Deno.env.get('POLYGON_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Filter constants
const ALLOWED_TYPES     = new Set(['CS', 'ADRC', 'ADRP', 'ADRR', 'ETF']);  // CS=Common Stock, ADR variants, ETF
const ALLOWED_EXCHANGES = new Set(['XNAS', 'XNYS', 'XASE', 'ARCX', 'BATS']); // Massive uses MIC codes
const EXCHANGE_LABELS: Record<string,string> = {
  XNAS: 'NASDAQ', XNYS: 'NYSE', XASE: 'AMEX', ARCX: 'NYSE Arca', BATS: 'BATS',
};
const MIN_PRICE          = 2.00;
const MIN_DOLLAR_VOLUME  = 5_000_000;
const MAX_REMOVE_PERCENT = 0.01;   // safety cap — never remove >1% per run
const MISSING_DAYS_BEFORE_DELIST = 3;

interface RefTicker {
  ticker: string;
  name?: string;
  type?: string;
  primary_exchange?: string;
  active?: boolean;
}

// Fetch all active US tickers from Massive reference, with pagination.
async function fetchAllReferenceTickers(): Promise<RefTicker[]> {
  const all: RefTicker[] = [];
  let url: string | null = `${POLYGON_BASE}/v3/reference/tickers?market=stocks&active=true&limit=1000&apiKey=${POLYGON_KEY}`;
  let pages = 0;
  const maxPages = 60; // ~60K cap, prevents runaway loops

  while (url && pages < maxPages) {
    pages++;
    const r = await fetch(url, { headers: { 'User-Agent': 'StockVizor/1.0' } });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Reference fetch failed page ${pages}: HTTP ${r.status} ${txt.slice(0,200)}`);
    }
    const j = await r.json();
    const results: RefTicker[] = j?.results ?? [];
    all.push(...results);

    // Massive returns next_url for pagination; need to append apiKey
    if (j?.next_url) {
      url = `${j.next_url}&apiKey=${POLYGON_KEY}`;
    } else {
      url = null;
    }
  }

  console.log(`[universe] Fetched ${all.length} reference tickers in ${pages} pages`);
  return all;
}

// Bulk fetch snapshot for a list of symbols — Massive supports comma-separated bulk.
// Limit: ~250 symbols per URL to keep query string manageable.
async function fetchSnapshotsBulk(symbols: string[]): Promise<Map<string, { last_price: number; volume: number }>> {
  const result = new Map<string, { last_price: number; volume: number }>();
  const CHUNK = 200;

  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    const url = `${POLYGON_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${chunk.join(',')}&apiKey=${POLYGON_KEY}`;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'StockVizor/1.0' } });
      if (!r.ok) {
        console.warn(`[universe] snapshot bulk failed for chunk ${i}: HTTP ${r.status}`);
        continue;
      }
      const j = await r.json();
      const tickers = j?.tickers ?? [];
      for (const t of tickers) {
        const sym = t.ticker;
        if (!sym) continue;
        const day = t.day ?? {};
        const prev = t.prevDay ?? {};
        // Weekend handling: prefer day.c, fall back to prev.c
        const last_price = (day.c ?? 0) > 0 ? day.c : (prev.c ?? 0);
        const volume     = (day.v ?? 0) > 0 ? day.v : (prev.v ?? 0);
        if (last_price > 0) {
          result.set(sym, { last_price, volume });
        }
      }
    } catch (e) {
      console.warn(`[universe] snapshot bulk exception chunk ${i}:`, e);
    }
  }

  return result;
}

// Load current universe from app_config
async function loadCurrentUniverse(): Promise<string[]> {
  const { data, error } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'ta_ticker_universe')
    .limit(1);
  if (error || !data?.length) return [];
  const raw = data[0].value;
  const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(arr) ? arr : [];
}

async function saveUniverse(symbols: string[]): Promise<void> {
  const sorted = [...new Set(symbols)].sort();
  const { error } = await supabase
    .from('app_config')
    .update({ value: JSON.stringify(sorted) })
    .eq('key', 'ta_ticker_universe');
  if (error) throw new Error(`Save universe failed: ${error.message}`);
}

async function logChanges(rows: any[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabase.from('universe_changes').insert(rows);
  if (error) console.warn(`[universe] log changes failed: ${error.message}`);
}

async function recordHealth(opts: {
  attempted: number; updated: number; failed: number; durationMs: number; error?: string;
}) {
  const status = opts.failed === 0 ? 'healthy' : (opts.updated > 0 ? 'partial' : 'failed');
  await supabase.from('cache_health').upsert({
    cache_name: 'universe_fan_out',
    last_run_at: new Date().toISOString(),
    last_success_at: opts.updated > 0 ? new Date().toISOString() : null,
    symbols_attempted: opts.attempted,
    symbols_updated: opts.updated,
    symbols_failed: opts.failed,
    duration_ms: opts.durationMs,
    last_error: opts.error ?? null,
    status,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'cache_name' });
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dry') === '1';

  if (!POLYGON_KEY || !SUPABASE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'missing keys' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    // Step 1: fetch reference list (~all active US tickers)
    const refTickers = await fetchAllReferenceTickers();

    // Step 2: filter by type + exchange
    const candidates = refTickers.filter(t =>
      t.type && ALLOWED_TYPES.has(t.type) &&
      t.primary_exchange && ALLOWED_EXCHANGES.has(t.primary_exchange) &&
      t.active === true
    );
    console.log(`[universe] ${candidates.length} candidates after type+exchange filter`);

    // Step 3: bulk-fetch snapshots for all candidates
    const candidateSymbols = candidates.map(t => t.ticker);
    const snapshots = await fetchSnapshotsBulk(candidateSymbols);
    console.log(`[universe] ${snapshots.size} snapshots fetched`);

    // Step 4: apply liquid filter (price >= $2 AND dollar_volume >= $5M)
    const liquidSymbols = new Set<string>();
    const liquidMeta: Record<string, { price: number; volume: number; dollar_volume: number; type: string; exchange: string; name: string }> = {};
    for (const c of candidates) {
      const snap = snapshots.get(c.ticker);
      if (!snap) continue;
      const dollarVol = snap.last_price * snap.volume;
      if (snap.last_price >= MIN_PRICE && dollarVol >= MIN_DOLLAR_VOLUME) {
        liquidSymbols.add(c.ticker);
        liquidMeta[c.ticker] = {
          price: snap.last_price,
          volume: snap.volume,
          dollar_volume: dollarVol,
          type: c.type ?? '',
          exchange: c.primary_exchange ?? '',
          name: c.name ?? '',
        };
      }
    }
    console.log(`[universe] ${liquidSymbols.size} liquid symbols after price+volume filter`);

    // Step 5: load current universe
    const currentUniverse = await loadCurrentUniverse();
    const currentSet = new Set(currentUniverse);

    // Step 6a: compute additions — liquid symbols not currently in universe
    const additions = [...liquidSymbols].filter(s => !currentSet.has(s));

    // Step 6b: compute potential removals — symbols in universe NOT in active reference set
    // (i.e. truly delisted, not just illiquid)
    const activeReferenceSet = new Set(refTickers.filter(t => t.active === true).map(t => t.ticker));
    const missingFromReference = currentUniverse.filter(s => !activeReferenceSet.has(s));

    // For each missing symbol, check ticker_reference to see how long it's been missing
    const today = new Date().toISOString().slice(0, 10);
    const toRemove: string[] = [];
    const toMarkMissing: { symbol: string; first_missing: string }[] = [];

    if (missingFromReference.length > 0) {
      const { data: refRows } = await supabase
        .from('ticker_reference')
        .select('symbol, missing_since')
        .in('symbol', missingFromReference);

      const refMap = new Map((refRows ?? []).map(r => [r.symbol, r.missing_since]));

      for (const sym of missingFromReference) {
        const firstMissing = refMap.get(sym);
        if (!firstMissing) {
          // First time missing — mark missing_since but don't remove yet
          toMarkMissing.push({ symbol: sym, first_missing: today });
        } else {
          const daysMissing = Math.floor((Date.parse(today) - Date.parse(firstMissing)) / 86400000);
          if (daysMissing >= MISSING_DAYS_BEFORE_DELIST) {
            toRemove.push(sym);
          }
        }
      }
    }

    // Safety cap: never remove > 1% of universe in one run
    const maxRemovals = Math.max(1, Math.floor(currentUniverse.length * MAX_REMOVE_PERCENT));
    let safetyCapHit = false;
    let actualRemovals = toRemove;
    if (toRemove.length > maxRemovals) {
      console.warn(`[universe] SAFETY CAP HIT: would remove ${toRemove.length} symbols (>${maxRemovals}), skipping all removals`);
      actualRemovals = [];
      safetyCapHit = true;
    }

    // Step 7: build new universe
    const newUniverse = [
      ...currentUniverse.filter(s => !actualRemovals.includes(s)),
      ...additions,
    ];

    // Step 8: update ticker_reference table (refresh state for all known tickers)
    // Upsert all current liquid + active symbols, mark missing ones
    const referenceRows = candidates.map(c => ({
      symbol: c.ticker,
      name: c.name ?? null,
      asset_type: c.type ?? null,
      primary_exchange: c.primary_exchange ?? null,
      exchange_label: EXCHANGE_LABELS[c.primary_exchange ?? ''] ?? null,
      active: true,
      missing_since: null,
      last_seen: today,
      fetched_at: new Date().toISOString(),
    }));
    // chunk upsert (10K refs is too big for one call)
    if (!dryRun && referenceRows.length > 0) {
      const REF_CHUNK = 1000;
      for (let i = 0; i < referenceRows.length; i += REF_CHUNK) {
        await supabase.from('ticker_reference').upsert(
          referenceRows.slice(i, i + REF_CHUNK),
          { onConflict: 'symbol' }
        );
      }
    }
    // Mark newly missing symbols
    if (!dryRun && toMarkMissing.length > 0) {
      for (const m of toMarkMissing) {
        await supabase.from('ticker_reference').update({
          missing_since: m.first_missing,
        }).eq('symbol', m.symbol);
      }
    }

    // Step 9: write changes & new universe
    const changeRows: any[] = [];
    const nowIso = new Date().toISOString();
    for (const sym of additions) {
      const m = liquidMeta[sym];
      changeRows.push({
        symbol: sym,
        change_type: 'add',
        reason: 'liquid_threshold_met',
        price_at_change: m?.price ?? null,
        volume_at_change: m?.volume ? Math.trunc(m.volume) : null,
        dollar_volume_at_change: m?.dollar_volume ?? null,
        exchange: m?.exchange ?? null,
        asset_type: m?.type ?? null,
        notes: m?.name ?? null,
        changed_at: nowIso,
      });
    }
    for (const sym of actualRemovals) {
      changeRows.push({
        symbol: sym,
        change_type: 'remove',
        reason: 'delisted',
        notes: 'Missing from reference for >= 3 consecutive days',
        changed_at: nowIso,
      });
    }

    if (!dryRun) {
      if (changeRows.length > 0) await logChanges(changeRows);
      await saveUniverse(newUniverse);
    }

    const dur = Date.now() - t0;
    await recordHealth({
      attempted: candidates.length,
      updated: liquidSymbols.size,
      failed: candidates.length - snapshots.size,
      durationMs: dur,
    });

    return new Response(JSON.stringify({
      ok: true,
      duration_ms: dur,
      dry_run: dryRun,
      summary: {
        reference_total: refTickers.length,
        candidates_after_type_exchange_filter: candidates.length,
        snapshots_fetched: snapshots.size,
        liquid_count: liquidSymbols.size,
        current_universe_size: currentUniverse.length,
        new_universe_size: newUniverse.length,
        additions: additions.length,
        marked_missing_first_time: toMarkMissing.length,
        actual_removals: actualRemovals.length,
        potential_removals_blocked_by_safety: toRemove.length - actualRemovals.length,
        safety_cap_hit: safetyCapHit,
      },
      sample_additions: additions.slice(0, 20),
      sample_removals:  actualRemovals.slice(0, 20),
    }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (e) {
    const dur = Date.now() - t0;
    const errMsg = String(e).slice(0, 500);
    await recordHealth({ attempted: 0, updated: 0, failed: 1, durationMs: dur, error: errMsg });
    return new Response(JSON.stringify({ ok: false, error: errMsg, duration_ms: dur }),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
