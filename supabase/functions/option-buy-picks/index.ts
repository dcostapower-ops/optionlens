// Option Buy Picks — Supabase Edge Function
// Deploy as function name: option-buy-picks
//
// Long call / long put picks for the dashboard. pg_cron calls this every
// minute during the US session:
//   * on 5-minute marks (or when today's picks are missing) it runs the full
//     selection funnel over the option chains (lib/selector.js),
//   * on the other minutes it refreshes bid / ask / IV / delta / spot of the
//     contracts already on the dashboard with one unified-snapshot call.
// Results go to public.option_buy_picks (id = 'latest'); browsers receive
// them through Supabase Realtime.
//
// ?mode=select|quotes forces a mode; ?force=1 runs outside market hours.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { addDays, marketStatus } from './lib/market-hours.js'
import { fetchEarningsDate } from './lib/earnings.js'
import { bestAcross, DEFAULTS, normaliseContract, priceScore, selectForUnderlying } from './lib/selector.js'

const MASSIVE = 'https://api.massive.com'
const API_KEY = Deno.env.get('POLYGON_API_KEY') ?? ''
const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')

const UNIVERSE = ['NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'AVGO', 'TSLA']
const RULES = { ...DEFAULTS }
const STRIKE_RANGE = 0.5
const CONCURRENCY = 4
const PAGE_LIMIT = 250
const MAX_PAGES = 40
const ROW_FIELDS = [
  'symbol', 'expiry', 'dte', 'strike', 'bid', 'ask', 'iv', 'delta', 'volume', 'openInterest',
  'liquidity', 'spreadPct', 'timeValue', 'costPerDayPct', 'cost', 'earningsDate', 'exDividendDate',
  'rank', 'highlight',
]
const pick = (r: any) => Object.fromEntries(ROW_FIELDS.map(k => [k, r[k]]))

async function getJson(url: string) {
  const u = new URL(url)
  u.searchParams.set('apiKey', API_KEY)
  const r = await fetch(u, { signal: AbortSignal.timeout(20000) })
  if (!r.ok) throw new Error(`Massive ${r.status} ${u.pathname}: ${(await r.text()).slice(0, 160)}`)
  return r.json()
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]) }
  }))
  return out
}

async function fetchChain(underlying: string, minExpiry: string, maxExpiry: string) {
  const path = `${MASSIVE}/v3/snapshot/options/${encodeURIComponent(underlying)}`
  const params = new URLSearchParams({ 'expiration_date.gte': minExpiry, 'expiration_date.lte': maxExpiry, limit: String(PAGE_LIMIT) })
  const probe = await getJson(`${path}?expiration_date.gte=${minExpiry}&expiration_date.lte=${maxExpiry}&limit=1`)
  const spot = probe.results?.[0]?.underlying_asset?.price
  if (spot > 0) {
    params.set('strike_price.gte', (spot * (1 - STRIKE_RANGE)).toFixed(2))
    params.set('strike_price.lte', (spot * (1 + STRIKE_RANGE)).toFixed(2))
  }
  const results: any[] = []
  let next: string | undefined = `${path}?${params}`
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const j = await getJson(next)
    results.push(...(j.results ?? []))
    next = j.next_url
  }
  return results
}

async function nextExDividend(underlying: string, fromDate: string) {
  const p = new URLSearchParams({ ticker: underlying, 'ex_dividend_date.gte': fromDate, sort: 'ex_dividend_date', order: 'asc', limit: '1' })
  const j = await getJson(`${MASSIVE}/v3/reference/dividends?${p}`)
  return j.results?.[0]?.ex_dividend_date ?? null
}

async function readRow(id: string) {
  const { data } = await supabase.from('option_buy_picks').select('payload').eq('id', id).maybeSingle()
  return data?.payload ?? null
}

async function writeRow(id: string, payload: unknown) {
  const { error } = await supabase.from('option_buy_picks').upsert({ id, payload, updated_at: new Date().toISOString() })
  if (error) throw new Error(`write ${id}: ${error.message}`)
}

// Earnings (Nasdaq/Zacks) and ex-dividend (Massive) dates, once per trading day.
async function loadEvents(triggerDate: string) {
  const cached = await readRow('events')
  if (cached?.date === triggerDate) return cached.bySymbol
  const bySymbol: Record<string, any> = {}
  await mapLimit(UNIVERSE, CONCURRENCY, async sym => {
    const ev: any = {}
    try {
      const e = await fetchEarningsDate({}, sym)
      if (e) { ev.earningsDate = e.date; ev.earningsEstimated = e.estimated }
    } catch (e) { console.error(`[option-buy-picks] earnings ${sym}:`, (e as Error).message) }
    try { ev.exDividendDate = await nextExDividend(sym, triggerDate) }
    catch (e) { console.error(`[option-buy-picks] dividends ${sym}:`, (e as Error).message) }
    bySymbol[sym] = ev
  })
  await writeRow('events', { date: triggerDate, bySymbol })
  return bySymbol
}

async function runSelection(market: any) {
  const triggerDate = market.date
  const minExpiry = addDays(triggerDate, RULES.minDte)
  const maxExpiry = addDays(triggerDate, RULES.maxDte)
  const events = await loadEvents(triggerDate)

  const stocks = await mapLimit(UNIVERSE, CONCURRENCY, async underlying => {
    const ev = events[underlying] ?? {}
    try {
      const raw = await fetchChain(underlying, minExpiry, maxExpiry)
      const contracts = raw.map(r => normaliseContract(r, triggerDate)).filter(Boolean)
      const { calls, puts } = selectForUnderlying(contracts, RULES, ev, triggerDate)
      return {
        underlying,
        spot: contracts.find((c: any) => c.spot)?.spot ?? null,
        earningsDate: ev.earningsDate ?? null,
        earningsEstimated: ev.earningsEstimated ?? null,
        exDividendDate: ev.exDividendDate ?? null,
        calls: calls.rows.map(pick),
        puts: puts.rows.map(pick),
        qualified: { calls: calls.qualified, puts: puts.qualified },
        scanned: { calls: calls.scanned, puts: puts.scanned },
      }
    } catch (e) {
      console.error(`[option-buy-picks] ${underlying}:`, (e as Error).message)
      return { underlying, error: (e as Error).message, calls: [], puts: [],
        earningsDate: ev.earningsDate ?? null, earningsEstimated: ev.earningsEstimated ?? null, exDividendDate: ev.exDividendDate ?? null }
    }
  })

  const now = new Date().toISOString()
  const payload = {
    generatedAt: now,
    quotesAt: now,
    triggerDate, minExpiry, maxExpiry,
    rules: { ...RULES, strikeRange: STRIKE_RANGE },
    best: { calls: bestAcross(stocks, 'calls'), puts: bestAcross(stocks, 'puts') },
    stocks,
  }
  await writeRow('latest', payload)
  return { mode: 'select', stocks: stocks.map(s => ({ s: s.underlying, calls: s.calls.length, puts: s.puts.length, error: s.error })) }
}

// One unified-snapshot call refreshes every contract on the dashboard.
// Rank order stays as of the last 5-minute selection.
async function refreshQuotes(latest: any) {
  const rows = latest.stocks.flatMap((s: any) => [...s.calls, ...s.puts])
  const symbols = [...new Set(rows.map((r: any) => r.symbol))] as string[]
  if (!symbols.length) return { mode: 'quotes', updated: 0 }
  const byTicker = new Map<string, any>()
  for (let i = 0; i < symbols.length; i += 250) {
    const j = await getJson(`${MASSIVE}/v3/snapshot?ticker.any_of=${symbols.slice(i, i + 250).join(',')}&limit=250`)
    for (const r of j.results ?? []) if (!r.error) byTicker.set(r.ticker, r)
  }
  const apply = (r: any, spot: number | null) => {
    const s = byTicker.get(r.symbol)
    if (!s) return
    if (s.last_quote?.bid != null) r.bid = s.last_quote.bid
    if (s.last_quote?.ask != null) r.ask = s.last_quote.ask
    if (s.implied_volatility) r.iv = s.implied_volatility
    if (s.greeks?.delta != null) r.delta = s.greeks.delta
    if (s.session?.volume != null) r.volume = s.session.volume
    Object.assign(r, priceScore({ ...r, type: r.delta > 0 ? 'call' : 'put', spot }))
  }
  for (const st of latest.stocks) {
    const anyRow = [...st.calls, ...st.puts].map((r: any) => byTicker.get(r.symbol)).find(Boolean)
    const spot = anyRow?.underlying_asset?.price ?? st.spot
    st.spot = spot
    for (const r of [...st.calls, ...st.puts]) apply(r, spot)
  }
  const spotOf = Object.fromEntries(latest.stocks.map((s: any) => [s.underlying, s.spot]))
  for (const side of ['calls', 'puts']) for (const r of latest.best?.[side] ?? []) apply(r, spotOf[r.underlying])
  latest.quotesAt = new Date().toISOString()
  await writeRow('latest', latest)
  return { mode: 'quotes', updated: byTicker.size }
}

// ?mode=diagnose — which Massive data the stored key is entitled to. Each
// probe maps to a plan tier, so the pattern shows what the key is on.
async function diagnose() {
  const probe = async (name: string, url: string) => {
    const u = new URL(url)
    u.searchParams.set('apiKey', API_KEY)
    const r = await fetch(u, { signal: AbortSignal.timeout(15000) })
    const body = await r.text()
    let message: string | undefined
    try { message = JSON.parse(body).message } catch { /* non-JSON */ }
    return { name, status: r.status, ok: r.ok, message, body: r.ok ? body : undefined }
  }
  const ref = await probe('options reference (all plans)', `${MASSIVE}/v3/reference/options/contracts?underlying_ticker=NVDA&limit=1`)
  const contract = ref.ok ? JSON.parse(ref.body!).results?.[0]?.ticker : null
  const out = [ref]
  if (contract) {
    out.push(await probe('option daily bars (all plans)', `${MASSIVE}/v2/aggs/ticker/${contract}/prev`))
    out.push(await probe('option single snapshot (Starter+)', `${MASSIVE}/v3/snapshot/options/NVDA/${contract}`))
    out.push(await probe('option quotes (Advanced)', `${MASSIVE}/v3/quotes/${contract}?limit=1`))
  }
  out.push(await probe('option chain snapshot (Starter+)', `${MASSIVE}/v3/snapshot/options/NVDA?limit=1`))
  out.push(await probe('stock snapshot (stocks plan)', `${MASSIVE}/v2/snapshot/locale/us/markets/stocks/tickers/NVDA`))
  out.push(await probe('dividends reference', `${MASSIVE}/v3/reference/dividends?ticker=MSFT&limit=1`))
  return { mode: 'diagnose', contract, probes: out.map(({ body, ...p }) => p) }
}

Deno.serve(async req => {
  const url = new URL(req.url)
  const force = url.searchParams.get('force') === '1'
  const market = marketStatus()
  try {
    if (!API_KEY) throw new Error('POLYGON_API_KEY secret missing')
    if (url.searchParams.get('mode') === 'diagnose') return Response.json(await diagnose())
    if (!market.open && !force) return Response.json({ skipped: 'market closed', market })
    const latest = await readRow('latest')
    let mode = url.searchParams.get('mode')
    if (!mode) {
      const fresh = latest?.triggerDate === market.date && latest.stocks?.length
      mode = !fresh || market.minutes % 5 === 0 ? 'select' : 'quotes'
    }
    const result = mode === 'quotes' && latest ? await refreshQuotes(latest) : await runSelection(market)
    return Response.json({ ok: true, market, ...result })
  } catch (e) {
    console.error('[option-buy-picks]', (e as Error).message)
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
})
