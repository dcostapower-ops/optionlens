import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const POLYGON_KEY = Deno.env.get('POLYGON_API_KEY')!;
const POLY = 'https://api.polygon.io';

const ETF_MAP: Record<string, string> = {
  'XLK':  'technology',
  'XLF':  'financials',
  'XLV':  'health-care',
  'XLY':  'consumer-discretionary',
  'XLP':  'consumer-staples',
  'XLE':  'energy',
  'XLI':  'industrials',
  'XLB':  'materials',
  'XLU':  'utilities',
  'XLRE': 'real-estate',
  'XLC':  'communication-services',
};

async function polyGet(path: string): Promise<Record<string, unknown>> {
  const url = `${POLY}${path}${path.includes('?') ? '&' : '?'}apiKey=${POLYGON_KEY}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'StockVizor/1.0' } });
  if (!r.ok) throw new Error(`Polygon ${r.status}: ${path}`);
  return r.json();
}

async function pullEtf(
  ticker: string,
  sectorSlug: string,
  supabase: ReturnType<typeof createClient>,
): Promise<{ ticker: string; ok: boolean; error?: string }> {
  // 1. Get shares outstanding from Polygon reference data
  let sharesOutstanding: number;
  let refDate: string;
  try {
    const ref = await polyGet(`/v3/reference/tickers/${encodeURIComponent(ticker)}`);
    const res = ref.results as Record<string, unknown>;
    sharesOutstanding = res.share_class_shares_outstanding as number;
    if (!sharesOutstanding) throw new Error('share_class_shares_outstanding missing');
    // Use today's date as the reference date (Polygon reference data is "as of today")
    const now = new Date();
    refDate = now.toISOString().slice(0, 10);
  } catch (e) {
    return { ticker, ok: false, error: `reference: ${e.message}` };
  }

  // 2. Get previous close price as NAV proxy
  let nav: number;
  let priceDate: string;
  try {
    const snap = await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(ticker)}`);
    const t = (snap.ticker as Record<string, unknown>);
    const prevDay = t.prevDay as Record<string, unknown>;
    nav = prevDay.c as number;
    if (!nav) throw new Error('prevDay.c missing');
    // prevDay date is the last trading day
    const prevTs = (t.updated as number) / 1e6; // nanoseconds to ms
    const d = new Date(prevTs);
    // Use yesterday's date for the NAV price
    d.setDate(d.getDate() - 1);
    priceDate = d.toISOString().slice(0, 10);
  } catch (e) {
    return { ticker, ok: false, error: `snapshot: ${e.message}` };
  }

  const aum_usd = Math.round(sharesOutstanding * nav);

  // 3. Check if shares outstanding changed vs last stored row
  const { data: prevRows } = await supabase
    .from('sector_rotation_flow_raw')
    .select('date, shares_outstanding, nav')
    .eq('ticker', ticker)
    .order('date', { ascending: false })
    .limit(1);

  const prev = prevRows?.[0] ?? null;

  // net_flow vs previous row (use the row before today if we already have today's)
  const prevForFlow = (prev && prev.date === refDate)
    ? null // today already inserted; flow was computed on first insert
    : prev;
  const net_flow_usd = prevForFlow
    ? Math.round((sharesOutstanding - prevForFlow.shares_outstanding) * (prevForFlow.nav ?? nav))
    : null;

  // 4. Upsert today's row (onConflict = no-op update keeps existing net_flow_usd)
  const { error: upsertErr } = await supabase.from('sector_rotation_flow_raw').upsert(
    {
      ticker,
      date: refDate,
      shares_outstanding: sharesOutstanding,
      nav,
      aum_usd,
      net_flow_usd,
      source: 'polygon-reference',
      is_stale: false,
      stale_reason: null,
    },
    { onConflict: 'ticker,date' },
  );
  if (upsertErr) return { ticker, ok: false, error: `upsert: ${upsertErr.message}` };

  // 5. Rolling windows (5d, 20d, 60d) from last 65 rows with non-null flow
  const { data: history } = await supabase
    .from('sector_rotation_flow_raw')
    .select('date, net_flow_usd')
    .eq('ticker', ticker)
    .not('net_flow_usd', 'is', null)
    .order('date', { ascending: false })
    .limit(65);

  const flows = (history ?? []).map((r: { net_flow_usd: number }) => r.net_flow_usd);
  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

  const etf_flow_5d_usd  = flows.length >= 5  ? sum(flows.slice(0, 5))  : null;
  const etf_flow_20d_usd = flows.length >= 20 ? sum(flows.slice(0, 20)) : null;
  const etf_flow_60d_usd = flows.length >= 60 ? sum(flows.slice(0, 60)) : null;

  // 6. UPDATE sector_rotation_daily (most recent row for this sector — PK: date+sector_slug)
  const { data: dailyRows } = await supabase
    .from('sector_rotation_daily')
    .select('date')
    .eq('sector_slug', sectorSlug)
    .order('date', { ascending: false })
    .limit(1);

  const latestDate = dailyRows?.[0]?.date;
  if (latestDate) {
    await supabase
      .from('sector_rotation_daily')
      .update({ etf_flow_5d_usd, etf_flow_20d_usd, etf_flow_60d_usd, pipeline_phase: 1 })
      .eq('sector_slug', sectorSlug)
      .eq('date', latestDate);
  }

  console.log(`${ticker}: shares=${sharesOutstanding.toLocaleString()}, nav=$${nav}, flow=${net_flow_usd != null ? '$' + (net_flow_usd / 1e6).toFixed(0) + 'M' : 'null (first row)'}`);
  return { ticker, ok: true };
}

serve(async (req) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!POLYGON_KEY) {
    return new Response(JSON.stringify({ error: 'POLYGON_API_KEY not set' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const url = new URL(req.url);
  const singleTicker = url.searchParams.get('ticker')?.toUpperCase().trim();

  const targets = singleTicker
    ? (ETF_MAP[singleTicker] ? { [singleTicker]: ETF_MAP[singleTicker] } : {})
    : ETF_MAP;

  if (Object.keys(targets).length === 0) {
    return new Response(JSON.stringify({ error: 'Unknown ticker' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const results = await Promise.all(
    Object.entries(targets).map(([t, slug]) => pullEtf(t, slug, supabase)),
  );

  const ok     = results.filter(r => r.ok).map(r => r.ticker);
  const failed = results.filter(r => !r.ok).map(r => ({ ticker: r.ticker, error: r.error }));

  console.log(`etf-shares-pull: ${ok.length} ok, ${failed.length} failed`);

  return new Response(
    JSON.stringify({ ok, failed, ts: new Date().toISOString() }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
});
