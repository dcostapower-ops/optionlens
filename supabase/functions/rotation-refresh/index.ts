// ═══════════════════════════════════════════════════════════════════
// StockVizor — rotation-refresh Edge Function (Phase 0)
// ═══════════════════════════════════════════════════════════════════
// Purpose: Daily refresh of the Sector Rotation Map + Sector Detail.
//          Pulls OHLCV from Polygon, computes Chaikin MFV-based Stock
//          Flow, RS, Momentum, Composite, and sub-sector metrics, then
//          UPSERTs everything into sector_rotation_* tables.
//
// Phase 0: ETF flow (measured) is NOT computed — only Stock Flow
//          (inferred). Composite weights renormalize per
//          /research/methodology/sector-money-flow_v1.md.
//
// Schedule: pg_cron daily at 11pm UTC (≈7pm ET) on trading days.
//           Also invokable manually with { date?, dry_run?, skip_narratives? }.
//
// Auth:    Service-role invoke only — verify_jwt = false in config.toml
// ═══════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Env ──
const POLYGON_KEY    = Deno.env.get('POLYGON_API_KEY')        ?? '';
const ANTHROPIC_KEY  = Deno.env.get('FRANK-API-ANTHROPIC')    ?? '';
const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')           ?? '';
const SUPABASE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const POLYGON_BASE = 'https://api.polygon.io';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

// ── Types ──
interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number; }
interface UniverseRow {
  ticker: string;
  role: 'primary'|'secondary'|'benchmark'|'subsector'|'constituent';
  sector_slug: string;
  subsector_name: string | null;
  parent_ticker: string | null;
  weight_hint: number | null;
}

const SECTOR_SLUGS = [
  'technology','financials','health-care','consumer-discretionary','consumer-staples',
  'energy','industrials','materials','utilities','real-estate','communication-services',
];

const SECTOR_DISPLAY: Record<string,string> = {
  'technology':'Technology','financials':'Financials','health-care':'Health Care',
  'consumer-discretionary':'Consumer Discretionary','consumer-staples':'Consumer Staples',
  'energy':'Energy','industrials':'Industrials','materials':'Materials','utilities':'Utilities',
  'real-estate':'Real Estate','communication-services':'Communication Svcs',
};

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────
function todayUtc(): string { return new Date().toISOString().slice(0,10); }
function ymd(d: Date): string { return d.toISOString().slice(0,10); }
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setUTCDate(x.getUTCDate()+n); return x; }
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function mean(a: number[]) { return a.length === 0 ? 0 : a.reduce((s,x)=>s+x,0)/a.length; }
function stdev(a: number[]) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0) / a.length);
}
function zScore(value: number, all: number[]): number {
  const s = stdev(all);
  if (s === 0) return 0;
  return (value - mean(all)) / s;
}

// Polygon daily bars: /v2/aggs/ticker/{T}/range/1/day/{from}/{to}
async function fetchBars(ticker: string, from: string, to: string): Promise<Bar[]> {
  const safe = encodeURIComponent(ticker);
  const url = `${POLYGON_BASE}/v2/aggs/ticker/${safe}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=5000&apiKey=${POLYGON_KEY}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'StockVizor/1.0' } });
  if (!r.ok) {
    throw new Error(`Polygon ${r.status} for ${ticker}: ${(await r.text()).slice(0,200)}`);
  }
  const j = await r.json();
  const out: Bar[] = (j?.results ?? []).map((b: any) => ({
    date: new Date(b.t).toISOString().slice(0,10),
    open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v ?? 0,
  }));
  return out;
}

// Batched fetch with concurrency cap
async function fetchAllBars(tickers: string[], from: string, to: string, concurrency = 25): Promise<Record<string, Bar[]>> {
  const out: Record<string, Bar[]> = {};
  const queue = [...tickers];
  const errors: { ticker: string; error: string }[] = [];

  async function worker() {
    while (queue.length) {
      const t = queue.shift()!;
      try {
        out[t] = await fetchBars(t, from, to);
      } catch (e) {
        errors.push({ ticker: t, error: String(e) });
        out[t] = [];
      }
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, tickers.length)}, worker));
  if (errors.length) {
    console.log(`[rotation-refresh] ${errors.length} ticker fetch errors:`, errors.slice(0,5));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Math
// ─────────────────────────────────────────────────────────────────────

// Daily RS series for one sector vs benchmark, indexed to 100 at series start.
function buildRsSeries(sectorBars: Bar[], benchBars: Bar[]): { date: string; rs: number }[] {
  const benchByDate = new Map(benchBars.map(b => [b.date, b.close]));
  const aligned: { date: string; ratio: number }[] = [];
  for (const sb of sectorBars) {
    const bp = benchByDate.get(sb.date);
    if (!bp || bp === 0) continue;
    aligned.push({ date: sb.date, ratio: sb.close / bp });
  }
  if (aligned.length === 0) return [];
  const base = aligned[0].ratio;
  return aligned.map(a => ({ date: a.date, rs: (a.ratio / base) * 100 }));
}

// EMA smoothing of an RS series.
function emaSmooth(series: number[], period: number): number[] {
  if (series.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [series[0]];
  for (let i = 1; i < series.length; i++) {
    out.push(series[i] * k + out[i-1] * (1 - k));
  }
  return out;
}

// Slope/rate of change of a series over the last `lookback` points.
function rocPct(series: number[], lookback: number): number {
  if (series.length < lookback + 1) return 0;
  const a = series[series.length - lookback - 1];
  const b = series[series.length - 1];
  if (a === 0) return 0;
  return ((b - a) / a) * 100;
}

// Chaikin Money Flow Volume for one stock series.
// Returns daily MFV (signed dollars) aligned with dates.
function computeMfv(stockBars: Bar[]): { date: string; mfm: number | null; mfv: number; dollarVolume: number }[] {
  return stockBars.map(b => {
    const range = b.high - b.low;
    if (range <= 0 || b.volume === 0) {
      return { date: b.date, mfm: null, mfv: 0, dollarVolume: b.close * b.volume };
    }
    const mfm = ((b.close - b.low) - (b.high - b.close)) / range;
    const typicalPrice = (b.high + b.low + b.close) / 3;
    const mfv = mfm * b.volume * typicalPrice;
    return { date: b.date, mfm, mfv, dollarVolume: b.close * b.volume };
  });
}

function classifyQuadrant(rs: number, mom: number): string {
  if (rs >= 100 && mom >= 100) return 'leading';
  if (rs <  100 && mom >= 100) return 'improving';
  if (rs <  100 && mom <  100) return 'lagging';
  return 'weakening';
}

function classifyArrow(slopePct: number): string {
  if (slopePct >  0.5) return 'double_up';
  if (slopePct >  0.1) return 'up';
  if (slopePct < -0.5) return 'double_down';
  if (slopePct < -0.1) return 'down';
  return 'flat';
}

function scoreTo0to100(z: number): number {
  return Math.round(clamp(50 + 15 * clamp(z, -3, 3), 0, 100));
}

// ─────────────────────────────────────────────────────────────────────
// Anthropic narrative
// ─────────────────────────────────────────────────────────────────────
const NARRATIVE_SYSTEM = `You write a 2-3 sentence factual summary of one US sector's recent performance for a retail investor.

Rules:
- Use only descriptive verbs: led, lagged, accelerated, decelerated, accounted for, contributed.
- Never use predictive verbs: will, should, expect, predict, recommend, suggest.
- Never mention news headlines or specific events you cannot verify.
- Name 1-2 strongest contributors by ticker with approximate % contribution.
- When discussing stock-level flow, always say "implied net buying" or "implied net selling" (never "net buying" alone).
- If the sector recently changed quadrant, mention it.
- 60 words maximum.`;

async function generateNarrative(input: {
  sectorName: string; quadrant: string; composite: number; deltaWeek: number;
  topConstituents: { ticker: string; return_1w: number; weight: number; stock_flow: number }[];
  breadthPct: number;
}): Promise<{ text: string; in: number; out: number }> {
  const userMsg = `Sector: ${input.sectorName}
Quadrant: ${input.quadrant}
Composite score: ${input.composite}/100 (week-over-week delta: ${input.deltaWeek >= 0 ? '+' : ''}${input.deltaWeek})
Implied buying breadth: ${Math.round(input.breadthPct * 100)}% of constituents had net implied inflow over 20 days
Top constituents (ticker, 1w%, weight, 20d implied flow USD):
${input.topConstituents.slice(0,5).map(c => `  ${c.ticker}: ${(c.return_1w*100).toFixed(1)}% / ${(c.weight*100).toFixed(1)}% / ${c.stock_flow >= 0 ? '+' : '-'}$${Math.abs(c.stock_flow/1e6).toFixed(0)}M`).join('\n')}

Write the 2-3 sentence narrative.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 250,
      system: NARRATIVE_SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!r.ok) {
    throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0,300)}`);
  }
  const j = await r.json();
  const text = j?.content?.[0]?.text ?? '';
  return { text, in: j?.usage?.input_tokens ?? 0, out: j?.usage?.output_tokens ?? 0 };
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────
interface Request0 { date?: string; dry_run?: boolean; skip_narratives?: boolean; }

interface SectorRow {
  sector_slug: string;
  rs: number;
  momentum: number;
  composite: number;
  composite_delta_1w: number;
  quadrant: string;
  stock_flow_net_20d_usd: number;
  stock_flow_breadth_pct: number;
  stock_flow_score: number;
  rs_score: number;
  momentum_score: number;
  rank: number;
  ticker: string;
}

async function runRefresh(req: Request0): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const target = req.date || todayUtc();
  const lookback = 90;             // days of history to pull
  const from = ymd(addDays(new Date(target), -lookback - 7));
  const to = target;
  const errors: any[] = [];

  // 1. Load universe
  const { data: univData, error: univErr } = await supabase
    .from('sector_rotation_universe')
    .select('ticker, role, sector_slug, subsector_name, parent_ticker, weight_hint')
    .eq('is_active', true);
  if (univErr) throw new Error(`Universe load failed: ${univErr.message}`);
  const universe = (univData ?? []) as UniverseRow[];

  const benchmarks    = universe.filter(u => u.role === 'benchmark').map(u => u.ticker);
  const primaries     = universe.filter(u => u.role === 'primary');
  const subsectors    = universe.filter(u => u.role === 'subsector');
  const constituents  = universe.filter(u => u.role === 'constituent');
  const allTickers = [...new Set([
    ...benchmarks,
    ...primaries.map(u => u.ticker),
    ...subsectors.map(u => u.ticker),
    ...constituents.map(u => u.ticker),
    // secondaries — pulled to keep parity; not used in Phase 0 math, but cheap
    ...universe.filter(u => u.role === 'secondary').map(u => u.ticker),
  ])];

  // 2. Fetch all bars
  const bars = await fetchAllBars(allTickers, from, to);

  // 3. Compute sector RS + Momentum vs SPY
  const spy = bars['SPY'] ?? [];
  if (spy.length === 0) throw new Error('SPY bars missing — cannot compute relative strength');

  const sectorAnalysis: Record<string, {
    rs_today: number;
    momentum_today: number;
    rs_score_raw: number;
    momentum_score_raw: number;
    composite_5d_ago: number | null;
  }> = {};

  // First pass: build raw RS / Momentum
  for (const p of primaries) {
    const rsSeries = buildRsSeries(bars[p.ticker] ?? [], spy);
    if (rsSeries.length < 30) {
      errors.push({ sector: p.sector_slug, error: 'insufficient RS history' });
      continue;
    }
    const rsVals = rsSeries.map(r => r.rs);
    const rsSmooth = emaSmooth(rsVals, 50);
    const rsToday = rsSmooth[rsSmooth.length - 1];
    const momTodayRaw = rocPct(rsSmooth, 5);              // 5-day ROC %
    sectorAnalysis[p.sector_slug] = {
      rs_today: rsToday,
      momentum_today: 100 + momTodayRaw,                  // re-center
      rs_score_raw: rsToday - 100,                        // pre-normalization
      momentum_score_raw: momTodayRaw,
      composite_5d_ago: null,                              // looked up later
    };
  }

  // 4. Compute Stock Flow per constituent + per sector aggregate
  const perStockMfv: Record<string, ReturnType<typeof computeMfv>> = {};
  for (const c of constituents) {
    const cb = bars[c.ticker];
    if (!cb || cb.length < 20) continue;
    perStockMfv[c.ticker] = computeMfv(cb);
  }

  // Sector-level Stock Flow aggregates over 5d / 20d / 60d windows ending at target date
  function filterWindow(rows: ReturnType<typeof computeMfv>, days: number) {
    return rows.slice(-days);
  }

  const stockFlowBySector: Record<string, {
    net5: number; net20: number; net60: number;
    grossIn20: number; grossOut20: number;
    breadthCount: number; constituentTotal: number;
    breadthPct: number;
    perTickerNet20: Record<string, number>;
  }> = {};

  for (const slug of SECTOR_SLUGS) {
    const sectorTickers = constituents.filter(c => c.sector_slug === slug).map(c => c.ticker);
    const perTickerNet20: Record<string, number> = {};
    let net5 = 0, net20 = 0, net60 = 0, grossIn20 = 0, grossOut20 = 0;
    let breadthCount = 0;
    for (const t of sectorTickers) {
      const rows = perStockMfv[t];
      if (!rows) continue;
      const w5  = filterWindow(rows, 5);
      const w20 = filterWindow(rows, 20);
      const w60 = filterWindow(rows, 60);
      const n20 = w20.reduce((s,r)=>s + r.mfv, 0);
      perTickerNet20[t] = n20;
      if (n20 > 0) breadthCount++;
      net5  += w5.reduce((s,r)=>s + r.mfv, 0);
      net20 += n20;
      net60 += w60.reduce((s,r)=>s + r.mfv, 0);
      grossIn20  += w20.reduce((s,r)=>s + Math.max(r.mfv, 0), 0);
      grossOut20 += w20.reduce((s,r)=>s + Math.max(-r.mfv, 0), 0);
    }
    stockFlowBySector[slug] = {
      net5, net20, net60, grossIn20, grossOut20, breadthCount,
      constituentTotal: sectorTickers.length,
      breadthPct: sectorTickers.length > 0 ? breadthCount / sectorTickers.length : 0,
      perTickerNet20,
    };
  }

  // 5. Cross-sectional normalization (z-scores across the 11 sectors)
  const slugsWithData = SECTOR_SLUGS.filter(s => sectorAnalysis[s]);
  const allRs   = slugsWithData.map(s => sectorAnalysis[s].rs_score_raw);
  const allMom  = slugsWithData.map(s => sectorAnalysis[s].momentum_score_raw);
  const allFlowSizeAdj = slugsWithData.map(s => {
    const f = stockFlowBySector[s];
    // size-adjust by 20d gross dollar activity to compare across sectors fairly
    const denom = Math.max(1, f.grossIn20 + f.grossOut20);
    return f.net20 / denom;
  });

  // 6. Lookup composite from 5 trading days ago for delta
  const fiveDaysAgoDate = ymd(addDays(new Date(target), -7)); // 7 calendar days ≈ 5 trading days
  const { data: prevRows } = await supabase
    .from('sector_rotation_daily')
    .select('sector_slug, composite, date')
    .lte('date', fiveDaysAgoDate)
    .order('date', { ascending: false })
    .limit(50);
  const prevByCompositeBy: Record<string, number> = {};
  if (prevRows) {
    for (const row of prevRows as any[]) {
      if (!(row.sector_slug in prevByCompositeBy)) prevByCompositeBy[row.sector_slug] = row.composite;
    }
  }

  // 7. Build sector rows
  const sectorRows: SectorRow[] = [];
  for (let i = 0; i < slugsWithData.length; i++) {
    const slug = slugsWithData[i];
    const a = sectorAnalysis[slug];
    const f = stockFlowBySector[slug];
    const rs_score      = zScore(a.rs_score_raw,           allRs);
    const momentum_score = zScore(a.momentum_score_raw,    allMom);
    const stock_flow_score = zScore(allFlowSizeAdj[i],     allFlowSizeAdj);

    // Phase 0 weights (renormalized — ETF flow weight = 0)
    const composite_raw =
        0.30 * stock_flow_score
      + 0.45 * rs_score
      + 0.25 * momentum_score;
    const composite = scoreTo0to100(composite_raw);
    const prev = prevByCompositeBy[slug];
    const composite_delta_1w = prev != null ? composite - prev : 0;

    // Display values are 100-centered cross-sectional z-scores × 4 — gives a
    // typical -2σ..+2σ range a visual spread of 92..108, so quadrants are usable.
    // The composite uses the raw z-scores; the chart axes use the scaled ones.
    const display_rs       = 100 + 4 * rs_score;
    const display_momentum = 100 + 4 * momentum_score;

    const primary = primaries.find(p => p.sector_slug === slug);
    sectorRows.push({
      sector_slug: slug,
      ticker: primary?.ticker ?? '',
      rs: display_rs,
      momentum: display_momentum,
      composite,
      composite_delta_1w,
      quadrant: classifyQuadrant(display_rs, display_momentum),
      stock_flow_net_20d_usd: Math.round(f.net20),
      stock_flow_breadth_pct: f.breadthPct,
      stock_flow_score,
      rs_score,
      momentum_score,
      rank: 0, // assigned after sort
    });
  }
  sectorRows.sort((a, b) => b.composite - a.composite).forEach((r, i) => r.rank = i + 1);

  // 8. Sub-sector metrics
  const subsectorRows: any[] = [];
  for (const s of subsectors) {
    const child = bars[s.ticker];
    if (!child || child.length < 10) continue;
    const parentTicker = s.parent_ticker!;
    const parent = bars[parentTicker];
    if (!parent || parent.length < 10) continue;
    const rsSeries = buildRsSeries(child, parent);
    if (rsSeries.length < 5) continue;
    const rsVals = rsSeries.map(r => r.rs);
    const return1w = child.length >= 6 ? (child[child.length-1].close / child[child.length-6].close) - 1 : 0;
    const slope = rocPct(rsVals, 5);
    // Weekly resample for sparkline — last 8 weeks
    const sparkline = rsVals.slice(-40).filter((_, i) => i % 5 === 0).slice(-8);
    subsectorRows.push({
      date: target,
      parent_sector_slug: s.sector_slug,
      ticker: s.ticker,
      display_name: s.subsector_name,
      return_1w: return1w,
      rs_vs_parent: rsVals[rsVals.length - 1],
      momentum_arrow: classifyArrow(slope),
      sparkline,
    });
  }

  // 9. Top constituents per sector
  const constituentRows: any[] = [];
  for (const slug of SECTOR_SLUGS) {
    const sectorCons = constituents
      .filter(c => c.sector_slug === slug)
      .sort((a, b) => (b.weight_hint ?? 0) - (a.weight_hint ?? 0))
      .slice(0, 5);
    for (let i = 0; i < sectorCons.length; i++) {
      const c = sectorCons[i];
      const cb = bars[c.ticker];
      if (!cb || cb.length < 6) continue;
      const return_1w = (cb[cb.length-1].close / cb[cb.length-6].close) - 1;
      const flow20 = stockFlowBySector[slug]?.perTickerNet20[c.ticker] ?? 0;
      constituentRows.push({
        date: target,
        sector_slug: slug,
        ticker: c.ticker,
        name: c.ticker, // we don't have full names in seed; UI can resolve
        weight: c.weight_hint ?? 0,
        return_1w,
        stock_flow_net_20d_usd: Math.round(flow20),
        ta_signal: null, // wired later from ta_cache
        rank: i + 1,
      });
    }
  }

  // 10. Per-stock daily MFV rows (for traceability — store latest 60 days per stock per refresh)
  const stockFlowRows: any[] = [];
  for (const c of constituents) {
    const rows = perStockMfv[c.ticker];
    if (!rows) continue;
    for (const r of rows.slice(-60)) {
      stockFlowRows.push({
        date: r.date,
        ticker: c.ticker,
        sector_slug: c.sector_slug,
        mfm: r.mfm,
        mfv_usd: r.mfv,
        dollar_volume: r.dollarVolume,
        method: 'chaikin-mfv',
      });
    }
  }

  // 11. Stock-flow aggregate rows
  const aggregateRows = SECTOR_SLUGS.map(slug => {
    const f = stockFlowBySector[slug];
    return {
      date: target,
      sector_slug: slug,
      stock_flow_net_5d_usd:    Math.round(f.net5),
      stock_flow_net_20d_usd:   Math.round(f.net20),
      stock_flow_net_60d_usd:   Math.round(f.net60),
      stock_flow_gross_in_20d_usd:  Math.round(f.grossIn20),
      stock_flow_gross_out_20d_usd: Math.round(f.grossOut20),
      stock_flow_breadth_pct:   f.breadthPct,
      stock_flow_breadth_count: f.breadthCount,
      constituent_total:        f.constituentTotal,
    };
  });

  // 12. Narratives (optional, parallel with cap 4)
  let narrativeRows: any[] = [];
  let narrativeTokensIn = 0, narrativeTokensOut = 0;
  if (!req.skip_narratives && ANTHROPIC_KEY) {
    const queue = [...sectorRows];
    const out: any[] = [];
    async function nw() {
      while (queue.length) {
        const sr = queue.shift()!;
        const top = constituentRows
          .filter(c => c.sector_slug === sr.sector_slug)
          .map(c => ({ ticker: c.ticker, return_1w: c.return_1w, weight: c.weight, stock_flow: c.stock_flow_net_20d_usd }));
        try {
          const n = await generateNarrative({
            sectorName: SECTOR_DISPLAY[sr.sector_slug],
            quadrant: sr.quadrant,
            composite: sr.composite,
            deltaWeek: sr.composite_delta_1w,
            topConstituents: top,
            breadthPct: sr.stock_flow_breadth_pct,
          });
          narrativeTokensIn += n.in; narrativeTokensOut += n.out;
          out.push({
            date: target, sector_slug: sr.sector_slug,
            narrative_text: n.text, generated_by: ANTHROPIC_MODEL,
            input_tokens: n.in, output_tokens: n.out,
          });
        } catch (e) {
          errors.push({ sector: sr.sector_slug, narrative_error: String(e) });
          out.push({
            date: target, sector_slug: sr.sector_slug,
            narrative_text: 'Narrative unavailable for this update.',
            generated_by: ANTHROPIC_MODEL,
            input_tokens: 0, output_tokens: 0,
          });
        }
      }
    }
    await Promise.all([nw(), nw(), nw(), nw()]);
    narrativeRows = out;
  }

  // 13. Persist
  if (!req.dry_run) {
    const dailyPayload = sectorRows.map(sr => ({
      date: target,
      sector_slug: sr.sector_slug,
      ticker: sr.ticker,
      rs: sr.rs,
      momentum: sr.momentum,
      composite: sr.composite,
      composite_delta_1w: sr.composite_delta_1w,
      quadrant: sr.quadrant,
      stock_flow_net_20d_usd: sr.stock_flow_net_20d_usd,
      stock_flow_breadth_pct: sr.stock_flow_breadth_pct,
      stock_flow_score: sr.stock_flow_score,
      rs_score: sr.rs_score,
      momentum_score: sr.momentum_score,
      rank: sr.rank,
      pipeline_phase: 0,
    }));

    // Batched upserts
    const upserts: { table: string; rows: any[]; conflict: string }[] = [
      { table: 'sector_rotation_daily',                     rows: dailyPayload,    conflict: 'date,sector_slug' },
      { table: 'sector_rotation_stock_flow',                rows: stockFlowRows,   conflict: 'date,ticker' },
      { table: 'sector_rotation_stock_flow_aggregate',      rows: aggregateRows,   conflict: 'date,sector_slug' },
      { table: 'sector_rotation_subsector',                 rows: subsectorRows,   conflict: 'date,ticker' },
      { table: 'sector_rotation_constituents',              rows: constituentRows, conflict: 'date,sector_slug,ticker' },
      { table: 'sector_rotation_narrative',                 rows: narrativeRows,   conflict: 'date,sector_slug' },
    ];
    for (const u of upserts) {
      if (u.rows.length === 0) continue;
      // Chunk large arrays
      const CHUNK = 500;
      for (let i = 0; i < u.rows.length; i += CHUNK) {
        const slice = u.rows.slice(i, i + CHUNK);
        const { error } = await supabase.from(u.table).upsert(slice, { onConflict: u.conflict });
        if (error) {
          errors.push({ table: u.table, error: error.message, sample: slice[0] });
        }
      }
    }

    // Refresh matview
    const { error: rmvErr } = await supabase.rpc('refresh_sector_rotation_history');
    if (rmvErr) errors.push({ matview_refresh_error: rmvErr.message });
  }

  // 14. Log the run
  const records_written = {
    sector_rotation_daily: sectorRows.length,
    sector_rotation_stock_flow: stockFlowRows.length,
    sector_rotation_stock_flow_aggregate: aggregateRows.length,
    sector_rotation_subsector: subsectorRows.length,
    sector_rotation_constituents: constituentRows.length,
    sector_rotation_narrative: narrativeRows.length,
  };
  const status = errors.length === 0 ? 'success' : (errors.length < 5 ? 'partial' : 'failed');
  if (!req.dry_run) {
    await supabase.from('sector_rotation_run_log').insert({
      pipeline_name: 'rotation-refresh',
      started_at: new Date(t0).toISOString(),
      finished_at: new Date().toISOString(),
      status,
      target_date: target,
      phase: 0,
      records_written,
      errors: errors.length ? errors : null,
    });
  }

  return {
    ok: true,
    target_date: target,
    phase: 0,
    duration_ms: Date.now() - t0,
    status,
    records_written,
    narrative_tokens: { in: narrativeTokensIn, out: narrativeTokensOut },
    errors: errors.length ? errors.slice(0, 10) : [],
    dry_run: !!req.dry_run,
  };
}

// ─────────────────────────────────────────────────────────────────────
// HTTP entry point
// ─────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: Request0 = {};
  if (req.method === 'POST') {
    try { body = await req.json(); } catch { body = {}; }
  } else {
    const url = new URL(req.url);
    body = {
      date: url.searchParams.get('date') ?? undefined,
      dry_run: url.searchParams.get('dry_run') === '1',
      skip_narratives: url.searchParams.get('skip_narratives') === '1',
    };
  }

  if (!POLYGON_KEY) return new Response(JSON.stringify({ ok: false, error: 'POLYGON_API_KEY not configured' }), { status: 500, headers: {'content-type':'application/json'} });
  if (!SUPABASE_URL || !SUPABASE_KEY) return new Response(JSON.stringify({ ok: false, error: 'Supabase env missing' }), { status: 500, headers: {'content-type':'application/json'} });

  try {
    const result = await runRefresh(body);
    return new Response(JSON.stringify(result, null, 2), { headers: {'content-type':'application/json'} });
  } catch (e) {
    console.error('[rotation-refresh] fatal:', e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: {'content-type':'application/json'} });
  }
});
