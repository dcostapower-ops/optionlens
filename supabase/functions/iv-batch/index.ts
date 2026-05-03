// OptionLens IV Batch Job — Supabase Edge Function
// Deploy as function name: iv-batch
// Populates options_iv_cache with IV, greeks, bid/ask for all optionable tickers
// During market hours: uses Polygon real-time options snapshots
// After market close: computes IV via Black-Scholes from last traded prices
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const POLYGON_BASE = 'https://api.polygon.io'
const POLYGON_KEY  = Deno.env.get('POLYGON_API_KEY') ?? ''
const SUPABASE_URL = 'https://hkamukkkkpqhdpcradau.supabase.co'
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const MAX_RUNTIME  = 115000   // 115s budget per invocation
const CALL_GAP_MS  = 700      // 700ms between Polygon calls
const MAX_DTE      = 120      // max days to expiry to cache
const MIN_DTE      = 3        // skip weeklies expiring in <3 days
const STRIKE_RANGE = 0.25     // ±25% of underlying price
const PAGE_LIMIT   = 250      // max contracts per Polygon page
const RISK_FREE    = 0.045    // ~4.5% risk-free rate for BS

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))

// ── US HOLIDAYS ─────────────────────────────────────────────────────────────
const US_HOLIDAYS = new Set([
  '2025-01-01','2025-01-20','2025-02-17','2025-04-18','2025-05-26',
  '2025-06-19','2025-07-04','2025-09-01','2025-11-27','2025-12-25',
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25',
  '2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
  '2027-01-01','2027-01-18','2027-02-15','2027-04-02','2027-05-31',
  '2027-06-19','2027-07-05','2027-09-06','2027-11-25','2027-12-24',
])

function isTrading(d: string) {
  const dow = new Date(d + 'T12:00:00').getDay()
  return dow >= 1 && dow <= 5 && !US_HOLIDAYS.has(d)
}

function todayET(): { date: string, hhmm: number, isOpen: boolean } {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
  const et = new Date(etStr)
  const date = et.toISOString().slice(0, 10)
  const hhmm = et.getHours() * 100 + et.getMinutes()
  const isOpen = isTrading(date) && hhmm >= 930 && hhmm <= 1600
  return { date, hhmm, isOpen }
}

function lastTradingDate(): string {
  const { date, hhmm } = todayET()
  if (isTrading(date) && hhmm >= 930) return date
  const d = new Date(date + 'T12:00:00')
  for (let i = 0; i < 14; i++) {
    d.setDate(d.getDate() - 1)
    const ds = d.toISOString().slice(0, 10)
    if (isTrading(ds)) return ds
  }
  return date
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

// ── BLACK-SCHOLES ───────────────────────────────────────────────────────────
function normCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
  const sign = x < 0 ? -1 : 1
  x = Math.abs(x)
  const t = 1.0 / (1.0 + p * x)
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2.0)
  return 0.5 * (1.0 + sign * y)
}

function bsPrice(S: number, K: number, T: number, r: number, sigma: number, type: string): number {
  if (T <= 0 || sigma <= 0) return Math.max(0, type === 'call' ? S - K : K - S)
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T))
  const d2 = d1 - sigma * Math.sqrt(T)
  if (type === 'call') return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2)
  return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1)
}

function bsVega(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0) return 0
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T))
  return S * Math.sqrt(T) * Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI)
}

function impliedVol(S: number, K: number, T: number, r: number, marketPrice: number, type: string): number | null {
  if (T <= 0 || marketPrice <= 0 || S <= 0 || K <= 0) return null
  const intrinsic = type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S)
  if (marketPrice < intrinsic * 0.95) return null  // below intrinsic — bad data

  let sigma = 0.3
  for (let i = 0; i < 100; i++) {
    const price = bsPrice(S, K, T, r, sigma, type)
    const v = bsVega(S, K, T, r, sigma)
    if (Math.abs(v) < 1e-12) break
    const diff = price - marketPrice
    if (Math.abs(diff) < 0.001) return sigma
    sigma -= diff / v
    if (sigma < 0.005) sigma = 0.005
    if (sigma > 10) return null  // diverged
  }
  return (sigma > 0.005 && sigma < 10) ? sigma : null
}

// ── POLYGON FETCH ───────────────────────────────────────────────────────────
async function polyFetch(url: string) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (r.status === 429) return { _429: true }
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

// ── LOAD TICKER UNIVERSE ────────────────────────────────────────────────────
async function loadIVUniverse(supabase: any): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', 'iv_ticker_universe')
      .limit(1)
    if (error || !data?.length) {
      console.warn('[iv-batch] No iv_ticker_universe — using empty list')
      return []
    }
    const raw = data[0].value
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (Array.isArray(arr)) {
      console.log(`[iv-batch] Loaded ${arr.length} tickers from iv_ticker_universe`)
      return arr
    }
    return []
  } catch (e) {
    console.error('[iv-batch] Error loading universe:', e.message)
    return []
  }
}

// ── LOAD STOCK PRICES FROM ta_cache ─────────────────────────────────────────
async function loadPrices(supabase: any, tradingDate: string): Promise<Record<string, number>> {
  const prices: Record<string, number> = {}
  let offset = 0
  while (true) {
    const { data } = await supabase
      .from('ta_cache')
      .select('ticker,price')
      .eq('trading_date', tradingDate)
      .not('price', 'is', null)
      .range(offset, offset + 999)
    if (!data?.length) break
    for (const r of data) if (r.ticker && r.price) prices[r.ticker] = r.price
    if (data.length < 1000) break
    offset += 1000
  }
  console.log(`[iv-batch] Loaded prices for ${Object.keys(prices).length} tickers`)
  return prices
}

// ── LOAD/SAVE BATCH STATE ───────────────────────────────────────────────────
async function loadState(supabase: any, tradingDate: string) {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'iv_batch_state')
    .limit(1)
  if (data?.length) {
    const state = typeof data[0].value === 'string' ? JSON.parse(data[0].value) : data[0].value
    if (state?.trading_date === tradingDate) return state
  }
  return { trading_date: tradingDate, ticker_index: 0, status: 'running' }
}

async function saveState(supabase: any, state: any) {
  await supabase.from('app_config').upsert(
    { key: 'iv_batch_state', value: JSON.stringify(state) },
    { onConflict: 'key' }
  )
}

// ── FETCH OPTIONS SNAPSHOT FOR ONE TICKER ───────────────────────────────────
async function fetchOptionsSnapshot(ticker: string, price: number, tradingDate: string, marketOpen: boolean) {
  const minStrike = (price * (1 - STRIKE_RANGE)).toFixed(2)
  const maxStrike = (price * (1 + STRIKE_RANGE)).toFixed(2)
  const minExpiry = addDays(tradingDate, MIN_DTE)
  const maxExpiry = addDays(tradingDate, MAX_DTE)

  const url = `${POLYGON_BASE}/v3/snapshot/options/${ticker}` +
    `?strike_price.gte=${minStrike}&strike_price.lte=${maxStrike}` +
    `&expiration_date.gte=${minExpiry}&expiration_date.lte=${maxExpiry}` +
    `&limit=${PAGE_LIMIT}&apiKey=${POLYGON_KEY}`

  const data = await polyFetch(url)
  if (!data || data._429) return data

  const contracts: any[] = []
  const results = data?.results || []

  for (const r of results) {
    const det = r.details
    if (!det) continue

    const expiry = det.expiration_date
    const strike = det.strike_price
    const ctype = det.contract_type  // 'call' or 'put'
    if (!expiry || !strike || !ctype) continue

    // Extract IV — use Polygon's if available, else compute via BS
    let iv = r.implied_volatility ?? null
    const bid = r.last_quote?.bid || 0
    const ask = r.last_quote?.ask || 0
    const lastPrice = r.last_trade?.price || 0
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (r.last_quote?.midpoint || lastPrice || 0)
    const volume = r.day?.volume ?? 0
    const oi = r.open_interest ?? 0

    // Skip contracts with no meaningful price data
    if (mid <= 0 && lastPrice <= 0) continue

    // If IV missing or market closed, compute via Black-Scholes
    const optPrice = mid || lastPrice
    if ((iv === null || iv === 0) && optPrice > 0) {
      const T = (new Date(expiry + 'T16:00:00').getTime() - new Date(tradingDate + 'T16:00:00').getTime()) / (365.25 * 24 * 3600 * 1000)
      const bsIV = impliedVol(price, strike, T, RISK_FREE, optPrice, ctype)
      if (bsIV !== null && bsIV > 0.005 && bsIV < 5) {
        iv = bsIV
      }
    }

    if (iv === null || iv <= 0) continue  // can't determine IV — skip

    contracts.push({
      ticker,
      expiry,
      strike,
      contract_type: ctype,
      iv: Math.round(iv * 10000) / 10000,  // 4 decimal precision
      bid: Math.round(bid * 100) / 100,
      ask: Math.round(ask * 100) / 100,
      mid: Math.round(mid * 100) / 100,
      delta: r.greeks?.delta ? Math.round(r.greeks.delta * 10000) / 10000 : null,
      gamma: r.greeks?.gamma ? Math.round(r.greeks.gamma * 10000) / 10000 : null,
      theta: r.greeks?.theta ? Math.round(r.greeks.theta * 10000) / 10000 : null,
      vega: r.greeks?.vega ? Math.round(r.greeks.vega * 10000) / 10000 : null,
      volume,
      open_interest: oi,
      underlying_price: price,
      cached_at: new Date().toISOString(),
    })
  }

  return { contracts, count: results.length }
}

// ── CORS / RESPONSE ─────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey',
  'Content-Type': 'application/json',
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: CORS })

// ── MAIN HANDLER ────────────────────────────────────────────────────────────
Deno.serve(async (_req) => {
  if (_req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  const startMs = Date.now()

  if (!SUPABASE_KEY) return json({ status: 'error', error: 'SUPABASE_SERVICE_ROLE_KEY not set' }, 500)
  if (!POLYGON_KEY) return json({ status: 'error', error: 'POLYGON_API_KEY not set' }, 500)

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

  // Load universe
  const tickers = await loadIVUniverse(supabase)
  if (!tickers.length) {
    return json({ status: 'error', error: 'No iv_ticker_universe configured' })
  }

  const tradingDate = lastTradingDate()
  const { isOpen } = todayET()
  console.log(`[iv-batch] tradingDate=${tradingDate} marketOpen=${isOpen} tickers=${tickers.length}`)

  if (!isTrading(tradingDate)) {
    return json({ status: 'skipped', reason: 'not_trading_day', trading_date: tradingDate })
  }

  // Load prices from ta_cache
  const prices = await loadPrices(supabase, tradingDate)

  // Load resumable state
  let state = await loadState(supabase, tradingDate)
  if (state.status === 'complete') {
    return json({ status: 'already_complete', trading_date: tradingDate, tickers: tickers.length })
  }

  let tickerIdx = state.ticker_index ?? 0
  let totalContracts = 0, totalTickers = 0, skippedNoPrice = 0

  while (tickerIdx < tickers.length) {
    // Budget check
    if (Date.now() - startMs > MAX_RUNTIME - 10000) {
      console.log(`[iv-batch] budget reached at ticker ${tickerIdx}/${tickers.length}`)
      state.ticker_index = tickerIdx
      state.status = 'running'
      await saveState(supabase, state)
      return json({
        status: 'partial',
        trading_date: tradingDate,
        ticker_index: tickerIdx,
        ticker_count: tickers.length,
        contracts_cached: totalContracts,
        tickers_done: totalTickers
      })
    }

    const tk = tickers[tickerIdx]
    const price = prices[tk]

    if (!price || price <= 0) {
      skippedNoPrice++
      tickerIdx++
      continue
    }

    // Fetch options snapshot
    const result = await fetchOptionsSnapshot(tk, price, tradingDate, isOpen)

    if (result?._429) {
      console.warn(`[iv-batch] 429 on ${tk} — waiting 30s`)
      await sleep(30000)
      continue  // retry same ticker
    }

    if (result?.contracts?.length) {
      // Upsert in chunks of 50
      for (let i = 0; i < result.contracts.length; i += 50) {
        const chunk = result.contracts.slice(i, i + 50)
        const { error } = await supabase
          .from('options_iv_cache')
          .upsert(chunk, { onConflict: 'ticker,expiry,strike,contract_type' })
        if (error) console.error(`[iv-batch] upsert error for ${tk}:`, error.message)
      }
      totalContracts += result.contracts.length
      totalTickers++

      // ── Compute ATM IV and write to iv_daily ──
      try {
        // Find contracts closest to ATM with DTE between 14-60 days
        const now = new Date(tradingDate + 'T16:00:00').getTime()
        const candidates = result.contracts.filter(c => {
          const dte = Math.round((new Date(c.expiry + 'T16:00:00').getTime() - now) / 86400000)
          return dte >= 14 && dte <= 60 && c.iv > 0
        })
        if (candidates.length >= 2) {
          // Group by expiry, pick the expiry closest to 30 DTE
          const byExpiry: Record<string, typeof candidates> = {}
          candidates.forEach(c => {
            if (!byExpiry[c.expiry]) byExpiry[c.expiry] = []
            byExpiry[c.expiry].push(c)
          })
          let bestExpiry = '', bestDist = 999
          for (const exp of Object.keys(byExpiry)) {
            const dte = Math.round((new Date(exp + 'T16:00:00').getTime() - now) / 86400000)
            const dist = Math.abs(dte - 30)
            if (dist < bestDist) { bestDist = dist; bestExpiry = exp }
          }
          const expiryContracts = byExpiry[bestExpiry] || []
          const dte = Math.round((new Date(bestExpiry + 'T16:00:00').getTime() - now) / 86400000)

          // Find ATM strike (closest to current price)
          const strikes = [...new Set(expiryContracts.map(c => c.strike))].sort((a, b) => Math.abs(a - price) - Math.abs(b - price))
          const atmStrike = strikes[0]
          if (atmStrike) {
            const atmCall = expiryContracts.find(c => c.strike === atmStrike && c.contract_type === 'call')
            const atmPut = expiryContracts.find(c => c.strike === atmStrike && c.contract_type === 'put')
            const callIV = atmCall?.iv || 0
            const putIV = atmPut?.iv || 0
            const atmIV = callIV > 0 && putIV > 0 ? (callIV + putIV) / 2 : (callIV || putIV)

            if (atmIV > 0) {
              const { error: ivErr } = await supabase
                .from('iv_daily')
                .upsert({
                  ticker: tk,
                  trading_date: tradingDate,
                  atm_iv: Math.round(atmIV * 10000) / 10000,
                  call_iv: callIV > 0 ? Math.round(callIV * 10000) / 10000 : null,
                  put_iv: putIV > 0 ? Math.round(putIV * 10000) / 10000 : null,
                  iv_skew: callIV > 0 && putIV > 0 ? Math.round((putIV - callIV) * 10000) / 10000 : null,
                  atm_strike: atmStrike,
                  dte,
                  underlying_price: price,
                }, { onConflict: 'ticker,trading_date' })
              if (ivErr) console.error(`[iv-batch] iv_daily error for ${tk}:`, ivErr.message)
            }
          }
        }
      } catch (e) {
        // Non-critical — don't break the batch
        console.warn(`[iv-batch] ATM IV calc error for ${tk}:`, e.message)
      }

      console.log(`[iv-batch] ✓ ${tk}: ${result.contracts.length} contracts (price=$${price.toFixed(2)})`)
    } else {
      console.log(`[iv-batch] — ${tk}: no contracts found`)
    }

    tickerIdx++
    await sleep(CALL_GAP_MS)
  }

  // Done
  console.log(`[iv-batch] ALL DONE tickers=${totalTickers} contracts=${totalContracts} skipped=${skippedNoPrice}`)
  state.ticker_index = tickerIdx
  state.status = 'complete'
  await saveState(supabase, state)

  return json({
    status: 'complete',
    trading_date: tradingDate,
    tickers_done: totalTickers,
    contracts_cached: totalContracts,
    skipped_no_price: skippedNoPrice
  })
})
