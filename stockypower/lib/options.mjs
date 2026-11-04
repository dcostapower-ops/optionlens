// "Best Option Chains": scans every listed contract more than N days out for the
// requested symbols (Massive options chain snapshot), keeps liquid ones, scores
// them on delta, IV cheapness, open interest, volume and spread, takes the best 5
// calls and 5 puts, and orders those by an estimated return on premium.
// Factors: delta 15%, IV cheapness 15%, premium vs fair value 15%, chance of profit
// at expiry 15%, agreement with Stocky 15% (when available), liquidity 15% (open
// interest + volume + spread, full marks once comfortably tradable), time decay 10%.
//
// Profit can't be known in advance, so "most profitable" uses one comparable
// scenario for every contract: the stock makes a typical favourable move (one
// standard deviation of its recent realised volatility) over HOLD_DAYS, the
// option is repriced with Black-Scholes at its current IV, bought at the ask.

export const DEFAULTS = {
  minDays: 61, // "more than 60 days"
  maxDays: null, // optional upper limit
  maxPerExpiry: 2, // spread the picks across expiry dates
  oiGood: 1000, // open interest at/above this counts as fully tradable
  volGood: 200, // volume at/above this counts as fully tradable
  weights: { delta: 0.15, iv: 0.15, premium: 0.15, profit: 0.15, stocky: 0.15, liquidity: 0.15, decay: 0.1 },
  // "Next 5 sessions" profit horizon: judged on reaching Stocky's 1-day Target 1 soon,
  // so time to expiry matters less (decay 5%) and the short-term payoff counts most.
  horizon: "30d", // "30d" (typical move) or "short" (Stocky's target within shortDays)
  shortDays: 7, // calendar days, about 5 trading sessions
  shortSessions: 5, // which point of Stocky's daily forecast path to use
  weightsShort: { delta: 0.15, iv: 0.1, premium: 0.1, profit: 0.1, stocky: 0.15, liquidity: 0.15, decay: 0.05, short: 0.2 },
  minTouchProb: 0.7, // out-of-the-money: required chance of reaching the strike before expiry
  holdDays: 30,
  minOpenInterest: 500,
  minVolume: 10,
  maxSpreadPct: 15,
  deltaMin: 0.25,
  deltaMax: 0.75,
  deltaSweet: 0.55,
  riskFree: 0.04,
  top: 5,
};

const ymd = (d) => d.toISOString().slice(0, 10);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// ── Black-Scholes ────────────────────────────────────────────────────────────

function normCdf(x) {
  // Abramowitz-Stegun 26.2.17, |error| < 7.5e-8
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export function bsPrice(type, S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) return Math.max(0, type === "call" ? S - K : K - S);
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / sq;
  const d2 = d1 - sq;
  return type === "call"
    ? S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2)
    : K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

// Chance the price touches `level` at any time within T years (driftless log price,
// reflection principle): 2 * N(-|ln(level/S)| / (sigma * sqrt(T))).
export function probTouch(S, level, sigma, T) {
  if (!(S > 0 && level > 0 && sigma > 0 && T > 0)) return null;
  const d = Math.abs(Math.log(level / S)) / (sigma * Math.sqrt(T));
  return Math.min(1, 2 * normCdf(-d));
}

// Chance the price finishes above (call) / below (put) `level` at T, with no expected
// gain or loss (log price drift -sigma^2/2).
export function probBeyond(type, S, level, sigma, T) {
  if (!(S > 0 && level > 0 && sigma > 0 && T > 0)) return null;
  const sq = sigma * Math.sqrt(T);
  const z = (Math.log(S / level) - (sigma * sigma * T) / 2) / sq;
  return type === "call" ? normCdf(z) : normCdf(-z);
}

// ── Events (earnings and the like) from the implied-volatility term structure ──
//
// No earnings calendar is needed: before a known event, options expiring after it carry extra
// implied volatility for the event day. Total implied variance (IV² × T) then jumps between the
// last expiry before the event and the first one after it. Forward variance between consecutive
// expiries shows the jump; the excess over the normal level is the event's variance, and its
// square root is the one-day move the market is pricing.
export const EVENT_RULES = { minDays: 2, minRatio: 1.3, minMove: 0.03 };

export function detectEvents(contracts, S, now = Date.now(), rules = EVENT_RULES) {
  const byExp = new Map();
  for (const c of contracts) {
    if (!c || !(c.iv > 0) || !c.expiration || !(c.strike > 0)) continue;
    const days = (Date.parse(c.expiration + "T21:00:00Z") - now) / 864e5;
    if (days < rules.minDays) continue; // the last couple of days are too noisy
    if (!byExp.has(c.expiration)) byExp.set(c.expiration, { days, items: [] });
    byExp.get(c.expiration).items.push(c);
  }
  const term = [];
  for (const [expiration, { days, items }] of byExp) {
    // At-the-money IV: the strike closest to the stock price, calls and puts averaged.
    const dist = Math.min(...items.map((c) => Math.abs(c.strike - S)));
    const atm = items.filter((c) => Math.abs(c.strike - S) <= dist + 1e-9);
    term.push({ expiration, days, iv: atm.reduce((a, c) => a + c.iv, 0) / atm.length });
  }
  term.sort((a, b) => a.days - b.days);
  return { term, ...eventsFromTerm(term, rules) };
}

export function eventsFromTerm(term, rules = EVENT_RULES) {
  if (term.length < 4) return { baseVol: null, events: [] };
  const fwd = [];
  let pw = 0, pt = 0, pexp = null, pdays = 0;
  for (const p of term) {
    const T = p.days / 365, w = p.iv * p.iv * T;
    fwd.push({ after: pexp, by: p.expiration, afterDays: pdays, byDays: p.days, dT: T - pt, fv: (w - pw) / (T - pt) });
    pw = w; pt = T; pexp = p.expiration; pdays = p.days;
  }
  const sorted = fwd.map((f) => f.fv).sort((a, b) => a - b);
  const base = sorted[Math.floor((sorted.length - 1) / 2)]; // normal (non-event) variance rate
  if (!(base > 0)) return { baseVol: null, events: [] };
  const events = [];
  for (const f of fwd) {
    const extra = (f.fv - base) * f.dT;
    if (!(f.fv > base * rules.minRatio && extra >= rules.minMove ** 2)) continue;
    const last = events.at(-1);
    if (last && last.by === f.after) Object.assign(last, { by: f.by, byDays: f.byDays, eventVar: last.eventVar + extra }); // merge neighbours
    else events.push({ after: f.after, by: f.by, afterDays: f.afterDays, byDays: f.byDays, eventVar: extra });
  }
  for (const e of events) e.movePct = Math.sqrt(e.eventVar) * 100;
  return { baseVol: Math.sqrt(base), events };
}

// Events an option is exposed to before an exit `exitDays` from now: the option must expire
// after the event window, and the window must start before the exit ("maybe" if it ends after).
export function eventsBeforeExit(events, c, exitDays) {
  return (events || []).filter((e) => c.expiration >= e.by && e.afterDays < exitDays).map((e) => ({ ...e, sure: e.byDays <= exitDays }));
}

// IV left after the events have passed: their variance comes out of the option's total.
// Floored at half the current IV so a noisy reading can't produce nonsense.
export function ivAfterEvents(iv, dte, eventVar) {
  if (!(eventVar > 0)) return iv;
  const T = dte / 365;
  return Math.sqrt(Math.max(iv * iv * T - eventVar, 0.25 * iv * iv * T) / T);
}

// The point of Stocky's daily forecast path `sessions` bars ahead (or the last one if shorter).
export function forecastPoint(path, sessions) {
  if (!Array.isArray(path) || !path.length) return null;
  const p = path[Math.min(sessions, path.length) - 1];
  if (!p || !(Number(p.price) > 0)) return null;
  return { price: Number(p.price), low: Number(p.low) || null, high: Number(p.high) || null };
}

// The point of a forecast path about `days` calendar days after `asOfT` (unix seconds): the first
// point at or past that time, else the last one. Falls back to `fallbackIndex` bars ahead when
// the path has no usable times. Returns the point plus how far ahead it really is.
export function forecastPointAt(path, asOfT, days, fallbackIndex) {
  if (!Array.isArray(path) || !path.length) return null;
  const pts = path.filter((p) => Number(p?.price) > 0);
  if (!pts.length) return null;
  const timed = asOfT > 0 && pts.every((p) => Number(p.t) > asOfT);
  let p;
  if (timed) {
    const want = asOfT + days * 86400 - 12 * 3600;
    p = [...pts].sort((a, b) => a.t - b.t).find((x) => x.t >= want) ?? pts.reduce((a, b) => (b.t > a.t ? b : a));
  } else p = pts[Math.min(fallbackIndex, pts.length) - 1];
  return { price: Number(p.price), low: Number(p.low) || null, high: Number(p.high) || null, t: Number(p.t) || null, daysAhead: timed ? (p.t - asOfT) / 86400 : null };
}

export const TF_LABEL = { "1h": "1-hour", "4h": "4-hour", "1D": "1-day", "1W": "1-week" };

// Expected option value and chance of profit when the stock price is lognormal around
// `center` with log-sd `sig` (center = median). 161-point grid over -4..4 sd.
export function expectedValue(valueAt, center, sig, cost) {
  let w = 0, ev = 0, pw = 0;
  for (let i = 0; i <= 160; i++) {
    const z = -4 + i * 0.05;
    const wi = Math.exp((-z * z) / 2);
    const v = valueAt(center * Math.exp(sig * z));
    w += wi;
    ev += wi * v;
    if (v > cost) pw += wi;
  }
  return { ev: ev / w, pProfit: pw / w };
}

// Annualised realised volatility from daily closes (last `days` returns).
export function realizedVol(dailyBars, days = 30) {
  const closes = (dailyBars || []).map((b) => b.c).filter((c) => c > 0);
  if (closes.length < days + 1) return null;
  const rets = [];
  for (let i = closes.length - days; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v * 252);
}

// ── Massive options chain snapshot ───────────────────────────────────────────

// Every contract for `symbol` expiring on/after minDays from today, following pages.
export async function fetchChain({ base, apiKey, symbol, minDays }) {
  const from = ymd(new Date(Date.now() + minDays * 864e5));
  return fetchSnapshotPages({ base, apiKey, symbol, url: `${base}/v3/snapshot/options/${encodeURIComponent(symbol)}?expiration_date.gte=${from}&limit=250`, maxPages: 80 });
}

// Near-the-money contracts of every expiry in the next `maxDays` days: enough to read the
// implied-volatility term structure (used to spot earnings and other events).
export async function fetchAtmTerm({ base, apiKey, symbol, price, maxDays = 150 }) {
  if (!(price > 0)) return [];
  const to = ymd(new Date(Date.now() + maxDays * 864e5));
  const url = `${base}/v3/snapshot/options/${encodeURIComponent(symbol)}?strike_price.gte=${(price * 0.95).toFixed(2)}&strike_price.lte=${(price * 1.05).toFixed(2)}&expiration_date.lte=${to}&limit=250`;
  return fetchSnapshotPages({ base, apiKey, symbol, url, maxPages: 20 }).catch(() => []);
}

async function fetchSnapshotPages({ base, apiKey, symbol, url, maxPages }) {
  const out = [];
  for (let page = 0; page < maxPages && url; page++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30_000) });
    if (r.status === 401 || r.status === 403)
      throw new Error(`Massive refused the options chain for ${symbol} (HTTP ${r.status}). Check that this API key includes your options plan.`);
    if (r.status === 404) throw new Error(`No options found for ${symbol}.`);
    if (!r.ok) throw new Error(`Massive HTTP ${r.status} for ${symbol} options`);
    const body = await r.json();
    out.push(...(body.results ?? []));
    url = body.next_url ? body.next_url.replace(/([?&])apiKey=[^&]*&?/, "$1").replace(/[?&]$/, "") : null;
    if (url && base && !url.startsWith(base)) url = base + new URL(url).pathname + new URL(url).search;
  }
  return out;
}

// Flattens one snapshot result into what we score. Returns null if unusable.
// underlyingForce: when the market is closed, option quotes are frozen at the close, so the
// stock price used with them must be the official close too (not an after-hours trade).
export function normalizeContract(x, underlyingFallback, underlyingForce = null) {
  const d = x?.details ?? {};
  const type = String(d.contract_type || "").toLowerCase();
  if (type !== "call" && type !== "put") return null;
  const q = x.last_quote ?? {};
  const bid = Number(q.bid), ask = Number(q.ask);
  const mid = Number.isFinite(q.midpoint) ? q.midpoint : bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  return {
    ticker: d.ticker,
    underlying: x.underlying_asset?.ticker,
    type,
    strike: Number(d.strike_price),
    expiration: d.expiration_date,
    sharesPerContract: Number(d.shares_per_contract) || 100,
    delta: Number(x.greeks?.delta),
    gamma: Number(x.greeks?.gamma),
    theta: Number(x.greeks?.theta),
    vega: Number(x.greeks?.vega),
    iv: Number(x.implied_volatility),
    openInterest: Number(x.open_interest) || 0,
    volume: Number(x.day?.volume) || 0,
    bid,
    ask,
    mid,
    last: Number(x.last_trade?.price) || Number(x.day?.close) || null,
    underlyingPrice: underlyingForce || Number(x.underlying_asset?.price) || underlyingFallback || null,
  };
}

// ── Selection ────────────────────────────────────────────────────────────────

// Percentile rank of v within sorted values (0..1).
function pctRank(sorted, v) {
  if (!sorted.length) return 0.5;
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m] < v) lo = m + 1;
    else hi = m;
  }
  return sorted.length === 1 ? 0.5 : lo / (sorted.length - 1);
}

// contracts: normalized; hv: realised vol by underlying; returns { calls, puts, stats }.
// Realised volatility matched to a horizon: near-dated options are judged against the
// last 30 days of movement, longer-dated ones increasingly against the last year.
// hv[symbol] is { short: 30-day, long: 1-year } (a plain number is used as-is).
export function hvFor(hvEntry, days) {
  if (hvEntry == null) return null;
  if (typeof hvEntry === "number") return hvEntry;
  const { short, long } = hvEntry;
  if (!short) return long ?? null;
  if (!long) return short;
  const w = Math.max(0, Math.min(1, (days - 30) / 335)); // 30 days -> all short, 365+ -> all long
  return short * (1 - w) + long * w;
}

// stocky: { SYMBOL: { d1: "BUY"|"SELL"|..., w1: ..., at } } from Stocky's latest saved run (optional).
// Strike preference: which part of the chain to consider, and where delta is "best".
export const STRIKE_PREFS = {
  balanced: { label: "Balanced", deltaMin: 0.25, deltaMax: 0.75, deltaSweet: 0.55 },
  otm: { label: "At / out of the money", deltaMin: 0.25, deltaMax: 0.6, deltaSweet: 0.45, exclude: "itm" },
  itm: { label: "In the money", deltaMin: 0.45, deltaMax: 0.85, deltaSweet: 0.65, exclude: "otm" },
};

export function pickBest(contracts, { hv = {}, stocky = {}, events = {}, now = Date.now(), ...opts } = {}) {
  const pref = STRIKE_PREFS[opts.strikePref] ? opts.strikePref : "balanced";
  const { label: _l, exclude: _e, ...prefDelta } = STRIKE_PREFS[pref];
  const o = { ...DEFAULTS, ...prefDelta, ...opts, strikePref: pref, strikePrefLabel: STRIKE_PREFS[pref].label, excludeMoneyness: STRIKE_PREFS[pref].exclude ?? null };
  const stats = { scanned: contracts.length, rejected: {} };
  const reject = (why) => (stats.rejected[why] = (stats.rejected[why] || 0) + 1);

  const usable = [];
  for (const c of contracts) {
    if (!c) { reject("unreadable"); continue; }
    const dte = Math.round((Date.parse(c.expiration + "T21:00:00Z") - now) / 864e5);
    if (!(dte >= o.minDays)) { reject(`expires within ${o.minDays - 1} days`); continue; }
    if (o.maxDays && dte > o.maxDays) { reject(`expires after ${o.maxDays} days`); continue; }
    if (!(c.bid > 0 && c.ask > 0 && c.ask >= c.bid)) { reject("no two-sided quote"); continue; }
    if (!Number.isFinite(c.delta) || !Number.isFinite(c.iv) || c.iv <= 0) { reject("no delta/IV"); continue; }
    if (!(c.underlyingPrice > 0)) { reject("no underlying price"); continue; }
    // Next 5 sessions: a strike beyond Stocky's Target 1 would still be out of the money even if
    // Stocky is exactly right, so it isn't considered for the side Stocky points to.
    if (o.horizon === "short") {
      const sh = stocky[c.underlying]?.short;
      const tgt = sh?.target1;
      const sideWanted = c.type === "call" ? "BUY" : "SELL";
      if (sh?.signal === sideWanted && Number.isFinite(tgt)) {
        const beyond = c.type === "call" ? c.strike > tgt : c.strike < tgt;
        if (beyond) { reject(`strike beyond Stocky's target (${tgt})`); continue; }
      }
    }
    // Strike preference: leave out the side of the chain the user doesn't want (ATM, within 2%, is always kept).
    const itmPct = ((c.type === "call" ? c.underlyingPrice - c.strike : c.strike - c.underlyingPrice) / c.underlyingPrice) * 100;
    if (o.excludeMoneyness === "itm" && itmPct > 2) { reject("in the money (preference: at / out of the money)"); continue; }
    if (o.excludeMoneyness === "otm" && itmPct < -2) { reject("out of the money (preference: in the money)"); continue; }
    const absDelta = Math.abs(c.delta);
    if (absDelta < o.deltaMin || absDelta > o.deltaMax) { reject(`delta outside ${o.deltaMin}-${o.deltaMax}`); continue; }
    if (c.openInterest < o.minOpenInterest) { reject(`open interest under ${o.minOpenInterest}`); continue; }
    if (c.volume < o.minVolume) { reject(`volume under ${o.minVolume}`); continue; }
    const spreadPct = ((c.ask - c.bid) / ((c.ask + c.bid) / 2)) * 100;
    if (spreadPct > o.maxSpreadPct) { reject(`spread over ${o.maxSpreadPct}%`); continue; }
    // Premium: the time value you pay per day held, as % of the stock price. Comparable
    // across expiries (a later expiry costs more in total but often less per day).
    const intrinsic = Math.max(0, c.type === "call" ? c.underlyingPrice - c.strike : c.strike - c.underlyingPrice);
    const timeValue = Math.max(0, c.ask - intrinsic);
    const timeValuePerDayPct = (timeValue / dte / c.underlyingPrice) * 100;
    // Premium vs fair value: the price this option would have if priced at the stock's
    // actual recent (realised) volatility. Time value grows with the square root of
    // time, so this compares short and long expiries fairly; per-day cost does not
    // (it always makes long-dated options look cheaper).
    const hvU = hvFor(hv[c.underlying], dte); // matched to this option's time to expiry
    const fair = hvU ? bsPrice(c.type, c.underlyingPrice, c.strike, dte / 365, o.riskFree, hvU) : null;
    const premiumVsFair = fair > 0 ? c.ask / fair : null;
    // Chances, using how much the stock actually moves (realised vol; IV if missing):
    //  - reaching the strike at any time before expiry ("probability of touch")
    //  - finishing beyond breakeven at expiry (i.e. the option pays off if held)
    const sigma = hvU || c.iv;
    const T = dte / 365;
    const otm = c.type === "call" ? c.strike > c.underlyingPrice : c.strike < c.underlyingPrice;
    const touchProb = otm ? probTouch(c.underlyingPrice, c.strike, sigma, T) : 1;
    const be = c.type === "call" ? c.strike + c.ask : c.strike - c.ask;
    const beProb = probBeyond(c.type, c.underlyingPrice, be, sigma, T);
    if (otm && touchProb < o.minTouchProb) {
      reject(`out of the money with under ${Math.round(o.minTouchProb * 100)}% chance to reach the strike before expiry`);
      continue;
    }
    usable.push({ ...c, dte, absDelta, spreadPct, hv: hvU, hvMove: hvFor(hv[c.underlying], o.holdDays), intrinsic, timeValue, timeValuePerDayPct, fairValue: fair, premiumVsFair, otm, touchProb, beProb });
  }
  stats.passed = usable.length;

  const byExpiry = { call: [], put: [] };
  const budgetPlans = { call: null, put: null };
  const horizonInfo = { call: { mode: "30d" }, put: { mode: "30d" } };
  const pick = (type) => {
    let list = usable.filter((c) => c.type === type);
    const wantSig = type === "call" ? "BUY" : "SELL";
    // Why a symbol has no 5-session trade on this side (for the page).
    const noShortReason = (sym) => {
      const sv = stocky[sym];
      if (sv?.shortBlock) return sv.shortBlock;
      const sh = sv?.short;
      if (!sh) return `Stocky hasn't analysed ${sym} on the 4-hour or 1-day timeframe in the last 7 days (see the status under the stock price above)`;
      const lbl = TF_LABEL[sh.tf] || sh.tf;
      if (sh.signal !== wantSig) return `Stocky's latest ${lbl} call for ${sym} is ${sh.signal}, so there's no ${type === "call" ? "upside" : "downside"} target to trade${sh.signal === (type === "call" ? "SELL" : "BUY") ? `; see the ${type === "call" ? "puts" : "calls"}` : ""}`;
      return `Stocky's ${lbl} target for ${sym} isn't ${type === "call" ? "above" : "below"} the current price`;
    };
    if (!list.length) {
      if (o.horizon === "short") horizonInfo[type] = { mode: "none", reason: [...new Set(contracts.filter(Boolean).map((c) => c.underlying))].map(noShortReason).join(". ") };
      return [];
    }
    const ivs = list.map((c) => c.iv).sort((a, b) => a - b);
    // Fallback when realised volatility is missing: time value per sqrt(day), also expiry-neutral.
    const tvRoot = (c) => c.timeValue / Math.sqrt(c.dte) / c.underlyingPrice;
    const ratios = list.map((c) => c.premiumVsFair ?? tvRoot(c)).sort((a, b) => a - b);
    const want = type === "call" ? "BUY" : "SELL";
    const shortMode = o.horizon === "short";
    for (const c of list) {
      const S = c.underlyingPrice;

      // Short-term scenario: Stocky's 1-day Target 1 reached within shortDays (if Stocky's
      // latest daily call points this option's way and its target is on the right side).
      c.shortTerm = null;
      // Events (e.g. earnings) between now and the exit: the price can jump on the day, and the
      // option's IV drops afterwards. Both are priced in.
      const evShort = eventsBeforeExit(events[c.underlying], c, o.shortDays);
      const evHold = eventsBeforeExit(events[c.underlying], c, o.holdDays);
      const evVarShort = evShort.reduce((a, e) => a + e.eventVar, 0);
      const evVarHold = evHold.reduce((a, e) => a + e.eventVar, 0);
      const ivExitShort = ivAfterEvents(c.iv, c.dte, evVarShort);
      const ivExitHold = ivAfterEvents(c.iv, c.dte, evVarHold);
      const evAll = (events[c.underlying] || []).filter((e) => c.expiration >= e.by);
      const exitDays = shortMode ? o.shortDays : o.holdDays;
      const evExit = shortMode ? evShort : evHold;
      c.event = evAll.length
        ? { by: evAll[0].by, after: evAll[0].after, movePct: evAll[0].movePct, beforeExit: evExit.length ? (evExit.every((e) => e.sure) ? "yes" : "maybe") : "no", exitDays, ivExit: shortMode ? ivExitShort : ivExitHold }
        : null;
      c.ivExitHold = ivExitHold;
      c.eventVarHold = evVarHold;
      const sh0 = stocky[c.underlying]?.short;
      const tgt = sh0?.target1;
      if (shortMode && sh0?.signal === want && Number.isFinite(tgt) && (type === "call" ? tgt > S : tgt < S)) {
        const days = o.shortDays;
        const vol = hvFor(hv[c.underlying], days) ?? c.iv;
        const Tafter = Math.max(0, (c.dte - days) / 365);
        const pReach = probTouch(S, tgt, vol, days / 365);
        const retTarget = ((bsPrice(type, tgt, c.strike, Tafter, o.riskFree, ivExitShort) - c.ask) / c.ask) * 100;
        const retFlat = ((bsPrice(type, S, c.strike, Tafter, o.riskFree, ivExitShort) - c.ask) / c.ask) * 100;
        c.shortTerm = { method: "target", target: tgt, days, pReach, retTargetPct: retTarget, retFlatPct: retFlat, expectedPct: pReach * retTarget + (1 - pReach) * retFlat, targetAt: sh0.at, source: sh0.tf, ivExit: ivExitShort, eventVar: evVarShort };
        // Stocky's forecast: where it expects the price after ~5 sessions, and how sure it is
        // (its low-high range, taken as about one standard deviation). The option is repriced
        // across that spread of prices; the average is the expected return.
        const fp = sh0.point;
        if (fp) {
          const sig0 = fp.low > 0 && fp.high > fp.low ? Math.log(fp.high / fp.low) / 2 : vol * Math.sqrt(days / 365);
          // A forecast that ends before the 5th session (the 1-hour path covers ~1.5 sessions)
          // is held flat from its last point, with normal volatility for the days it doesn't cover.
          const extVar = fp.daysAhead != null && fp.daysAhead < days - 0.5 ? (vol * vol * (days - fp.daysAhead)) / 365 : 0;
          const sig = Math.sqrt(sig0 * sig0 + extVar + evVarShort); // plus the event-day jump, if any
          const { ev, pProfit } = expectedValue((x) => bsPrice(type, x, c.strike, Tafter, o.riskFree, ivExitShort), fp.price, sig, c.ask);
          Object.assign(c.shortTerm, {
            method: "forecast",
            forecastPrice: fp.price,
            forecastLow: fp.low,
            forecastHigh: fp.high,
            forecastDaysAhead: fp.daysAhead,
            forecastSigma: sig,
            forecastSigmaStocky: sig0,
            forecastExtendVar: extVar,
            retAtForecastPct: ((bsPrice(type, fp.price, c.strike, Tafter, o.riskFree, ivExitShort) - c.ask) / c.ask) * 100,
            pProfit,
            expectedPct: ((ev - c.ask) / c.ask) * 100,
          });
        }
      }

      // Profit estimate: favourable 1-sigma move over holdDays, IV unchanged, buy at ask, value at mid.
      // Events before the exit add their jump to the move and take their IV out of the exit price.
      const hm = c.hvMove ?? c.hv ?? c.iv;
      const sigmaMove = Math.sqrt(hm * hm * (o.holdDays / 365) + evVarHold); // typical move over the holding period
      const S1 = S * Math.exp(type === "call" ? sigmaMove : -sigmaMove);
      const Tleft = Math.max(0, (c.dte - o.holdDays) / 365);
      const vMove = bsPrice(type, S1, c.strike, Tleft, o.riskFree, ivExitHold);
      const vFlat = bsPrice(type, S, c.strike, Tleft, o.riskFree, ivExitHold);
      c.scenario = { holdDays: o.holdDays, movePct: (S1 / S - 1) * 100, targetPrice: S1 };
      c.projectedReturnPct = ((vMove - c.ask) / c.ask) * 100;
      c.flatReturnPct = ((vFlat - c.ask) / c.ask) * 100;
      c.costPerContract = c.ask * c.sharesPerContract;
      // "If wrong": the stock moves about one standard deviation the other way over the same
      // period (5 sessions: Stocky's forecast spread; 30 days: the typical move).
      {
        const dirAgainst = type === "call" ? -1 : 1;
        if (shortMode && c.shortTerm) {
          const st = c.shortTerm;
          const sA = st.forecastSigma ?? (hvFor(hv[c.underlying], st.days) ?? c.iv) * Math.sqrt(st.days / 365);
          const Sx = S * Math.exp(dirAgainst * sA);
          const Ta = Math.max(0, (c.dte - st.days) / 365);
          c.adverse = { price: Sx, sigma: sA, pct: ((bsPrice(type, Sx, c.strike, Ta, o.riskFree, st.ivExit) - c.ask) / c.ask) * 100 };
        } else {
          const Sx = S * Math.exp(dirAgainst * sigmaMove);
          c.adverse = { price: Sx, sigma: sigmaMove, pct: ((bsPrice(type, Sx, c.strike, Tleft, o.riskFree, ivExitHold) - c.ask) / c.ask) * 100 };
        }
      }
      c.breakeven = type === "call" ? c.strike + c.ask : c.strike - c.ask;
      c.breakevenMovePct = (c.breakeven / S - 1) * 100;
      // Moneyness: how far the strike is from the stock price. ATM = within 2%.
      const inMoney = type === "call" ? S - c.strike : c.strike - S;
      c.moneynessPct = (Math.abs(S - c.strike) / S) * 100;
      c.moneyness = c.moneynessPct <= 2 ? "ATM" : inMoney > 0 ? "ITM" : "OTM";

      // ── Factor scores, each 0..1 ──
      const deltaScore = clamp01(1 - Math.abs(c.absDelta - o.deltaSweet) / 0.3);
      // IV cheapness: vs the stock's realised volatility (matched horizon), and vs the rest of the chain.
      const ivVsHv = c.hv ? c.iv / c.hv : null;
      const hvScore = ivVsHv == null ? 0.5 : clamp01((1.6 - ivVsHv) / 1.0); // 0.6x -> 1, 1.6x -> 0
      const ivScore = 0.5 * hvScore + 0.5 * (1 - pctRank(ivs, c.iv));
      // Cheap premium: below fair value is good (0.6x fair -> 1, 1.4x fair -> 0), blended with chain rank.
      const ratio = c.premiumVsFair ?? tvRoot(c);
      const fairScore = c.premiumVsFair == null ? 0.5 : clamp01((1.4 - c.premiumVsFair) / 0.8);
      const premiumScore = 0.5 * fairScore + 0.5 * (1 - pctRank(ratios, ratio));
      // Chance of profit at expiry (finishing beyond breakeven): 15% -> 0, 50%+ -> 1.
      const profitScore = c.beProb == null ? 0.5 : clamp01((c.beProb - 0.15) / 0.35);
      // Liquidity, "good enough" scoring: full marks once comfortably tradable, so a
      // giant contract doesn't beat an easily tradable one on size alone.
      const oiS = clamp01(Math.log10(Math.max(1, c.openInterest) / o.minOpenInterest) / Math.log10(o.oiGood / o.minOpenInterest));
      const volS = clamp01(Math.log10(Math.max(1, c.volume) / o.minVolume) / Math.log10(o.volGood / o.minVolume));
      const spreadS = clamp01(1 - c.spreadPct / o.maxSpreadPct);
      const liquidityScore = (oiS + volS + spreadS) / 3;
      // Time-decay cost: premium lost if the stock is flat for holdDays (0% -> 1, -30% or worse -> 0).
      const decayScore = clamp01(1 + c.flatReturnPct / 30);
      // Agreement with Stocky's latest daily / weekly call (if it analysed this stock recently).
      const sv = stocky[c.underlying];
      let stockyScore = null;
      if (sv && (sv.d1 || sv.w1)) {
        const pts = [sv.d1, sv.w1].filter(Boolean).map((sig) => (sig === want ? 1 : sig === "HOLD" ? 0.4 : 0));
        stockyScore = pts.reduce((x, y) => x + y, 0) / pts.length;
      }

      c.scores = { delta: deltaScore, iv: ivScore, premium: premiumScore, profit: profitScore, stocky: stockyScore, liquidity: liquidityScore, decay: decayScore, short: null };
      c.liquidityParts = { openInterest: oiS, volume: volS, spread: spreadS };
      c.ivVsHv = ivVsHv;
    }
    // Short-term payoff score: expected 5-session return, ranked within this side.
    // Next 5 sessions: only contracts with a matching Stocky target qualify. No fallback to
    // the 30-day method: that would recommend long-dated options for a short-term trade.
    const useShort = shortMode;
    if (shortMode) {
      const symbols = [...new Set(list.map((c) => c.underlying))];
      const without = symbols.filter((sym) => !list.some((c) => c.underlying === sym && c.shortTerm));
      list = list.filter((c) => c.shortTerm);
      if (!list.length) {
        horizonInfo[type] = { mode: "none", reason: symbols.map(noShortReason).join(". ") };
        byExpiry[type] = [];
        return [];
      }
      const withF = list.find((c) => c.shortTerm.method === "forecast");
      horizonInfo[type] = {
        mode: "short",
        target: list[0].shortTerm.target,
        source: list[0].shortTerm.source,
        days: o.shortDays,
        forecast: withF ? { price: withF.shortTerm.forecastPrice, low: withF.shortTerm.forecastLow, high: withF.shortTerm.forecastHigh, daysAhead: withF.shortTerm.forecastDaysAhead, extended: withF.shortTerm.forecastExtendVar > 0 } : null,
        ...(without.length ? { skipped: without.map(noShortReason).join(". ") } : {}),
      };
    } else horizonInfo[type] = { mode: "30d" };
    const exps = list.filter((c) => c.shortTerm).map((c) => c.shortTerm.expectedPct).sort((a, b) => a - b);
    const weights = useShort ? o.weightsShort : o.weights;
    for (const c of list) {
      if (useShort && c.shortTerm) c.scores.short = pctRank(exps, c.shortTerm.expectedPct);
      // Weighted sum; a factor without data (e.g. no Stocky view) has its weight shared out.
      let wSum = 0, total = 0;
      for (const [k, w] of Object.entries(weights)) {
        if (c.scores[k] == null) continue;
        wSum += w;
        total += w * c.scores[k];
      }
      c.score = wSum ? total / wSum : 0;
      c.weightSet = useShort ? "short" : "normal";
      // What "most profitable" means for this side.
      c.rankReturnPct = useShort && c.shortTerm ? c.shortTerm.expectedPct : c.projectedReturnPct;
    }
    // With an amount to invest: lower delta / more contracts vs higher delta / fewer contracts.
    budgetPlans[type] = o.budget > 0 ? budgetPlan(list, o.budget, useShort) : null;
    // Best contract on each expiry date, so the page can show why dates won or lost.
    const bestByExpiry = new Map();
    for (const c of list) {
      const k = `${c.underlying}|${c.expiration}`;
      if (!bestByExpiry.has(k) || bestByExpiry.get(k).score < c.score) bestByExpiry.set(k, c);
    }
    byExpiry[type] = [...bestByExpiry.values()].sort((a, b) => a.dte - b.dte || a.underlying.localeCompare(b.underlying));

    // Best 5 by the combined score, at most maxPerExpiry from any one expiry date,
    // then shown most profitable first.
    const perExpiry = {};
    const chosen = [];
    for (const c of list.sort((a, b) => b.score - a.score)) {
      const k = `${c.underlying}|${c.expiration}`;
      if ((perExpiry[k] || 0) >= o.maxPerExpiry) continue;
      perExpiry[k] = (perExpiry[k] || 0) + 1;
      chosen.push(c);
      if (chosen.length >= o.top) break;
    }
    return chosen.sort((a, b) => b.rankReturnPct - a.rankReturnPct);
  };
  const calls = pick("call");
  const puts = pick("put");
  const mark = (arr, chosenList) => arr.map((c) => ({ ...c, picked: chosenList.includes(c) }));
  return { calls, puts, callsByExpiry: mark(byExpiry.call, calls), putsByExpiry: mark(byExpiry.put, puts), horizon: horizonInfo, budget: budgetPlans, stats, settings: o };
}

// Recent daily bars for realised volatility and a fallback underlying price.
export async function fetchDaily({ base, apiKey, symbol, days = 400 }) {
  const to = ymd(new Date(Date.now() + 864e5));
  const from = ymd(new Date(Date.now() - days * 864e5));
  const r = await fetch(`${base}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=5000`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) return [];
  const body = await r.json();
  return (body.results ?? []).map((b) => ({ t: Math.floor(b.t / 1000), c: b.c }));
}

// ── Amount to invest: how many contracts it buys, and the dollar result ─────────
//
// For each delta range, the contract with the highest expected dollar profit for the amount.
// Whole contracts only, so part of the amount can stay unused. Everything is in dollars for
// the whole position: quantity × per-contract cost × the scenario's % return.
export const DELTA_BUCKETS = [
  { label: "Low delta (0.20–0.35)", min: 0.2, max: 0.35 },
  { label: "Lower-mid delta (0.35–0.50)", min: 0.35, max: 0.5 },
  { label: "Upper-mid delta (0.50–0.65)", min: 0.5, max: 0.65 },
  { label: "High delta (0.65+)", min: 0.65, max: 1.01 },
];

export function budgetPosition(c, budget, short) {
  const per = c.ask * c.sharesPerContract;
  const qty = Math.floor(budget / per + 1e-9);
  const invested = qty * per;
  const usd = (pct) => (pct == null || !Number.isFinite(pct) ? null : (invested * pct) / 100);
  const st = short ? c.shortTerm : null;
  return {
    ticker: c.ticker, underlying: c.underlying, type: c.type, strike: c.strike, expiration: c.expiration, dte: c.dte,
    delta: c.delta, ask: c.ask, perContract: per, qty, invested, unused: budget - invested, moneyness: c.moneyness,
    returnPct: c.rankReturnPct,
    expected: usd(c.rankReturnPct),
    target: st ? usd(st.retTargetPct) : null,
    targetPrice: st ? st.target : c.scenario?.targetPrice ?? null,
    atForecast: st?.retAtForecastPct != null ? usd(st.retAtForecastPct) : null,
    forecastPrice: st?.forecastPrice ?? null,
    flat: usd(st ? st.retFlatPct : c.flatReturnPct),
    adverse: usd(c.adverse?.pct),
    adversePrice: c.adverse?.price ?? null,
    chance: st ? st.pProfit ?? null : c.beProb ?? null,
    deltaShares: qty * Math.abs(c.delta) * c.sharesPerContract, // stock-equivalent exposure
    thetaPerDay: Number.isFinite(c.theta) ? qty * c.theta * c.sharesPerContract : null,
    maxLoss: invested,
  };
}

export function budgetPlan(list, budget, short) {
  const rows = [];
  for (const b of DELTA_BUCKETS) {
    let best = null;
    for (const c of list) {
      if (!(c.absDelta >= b.min && c.absDelta < b.max)) continue;
      const p = budgetPosition(c, budget, short);
      if (p.qty < 1 || p.expected == null) continue;
      if (!best || p.expected > best.expected) best = p;
    }
    rows.push({ bucket: b.label, min: b.min, max: b.max, pos: best });
  }
  const filled = rows.filter((r) => r.pos);
  const bestRow = filled.reduce((a, r) => (!a || r.pos.expected > a.pos.expected ? r : a), null);
  const likelyRow = filled.filter((r) => r.pos.chance != null).reduce((a, r) => (!a || r.pos.chance > a.pos.chance ? r : a), null);
  const cheapest = list.reduce((m, c) => Math.min(m, c.ask * c.sharesPerContract), Infinity);
  return {
    budget,
    horizon: short ? "short" : "30d",
    rows,
    best: bestRow ? rows.indexOf(bestRow) : null,
    mostLikely: likelyRow ? rows.indexOf(likelyRow) : null,
    tooSmall: !filled.length && Number.isFinite(cheapest) ? cheapest : null,
  };
}

// ── Market session ───────────────────────────────────────────────────────────

const nyParts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
function ny(ms) {
  const p = Object.fromEntries(nyParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute, weekday: p.weekday };
}

// Regular US session (09:30-16:00 New York, Mon-Fri). Holidays aren't detected; on a holiday
// the latest daily bar is the previous session anyway, so the close used is still right.
export function regularSessionOpen(ms = Date.now()) {
  const t = ny(ms);
  return !["Sat", "Sun"].includes(t.weekday) && t.min >= 9 * 60 + 30 && t.min < 16 * 60;
}

export const nyDate = (unixSeconds) => ny(unixSeconds * 1000).date;

// Official regular-session close for a date, plus after-hours / pre-market prices.
export async function fetchOfficialClose({ base, apiKey, symbol, date }) {
  try {
    const r = await fetch(`${base}/v1/open-close/${encodeURIComponent(symbol)}/${date}?adjusted=true`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const b = await r.json();
    return Number(b.close) > 0 ? { close: Number(b.close), afterHours: Number(b.afterHours) || null, preMarket: Number(b.preMarket) || null, date } : null;
  } catch {
    return null;
  }
}
