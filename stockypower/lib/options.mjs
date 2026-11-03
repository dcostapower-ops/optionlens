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
  let url = `${base}/v3/snapshot/options/${encodeURIComponent(symbol)}?expiration_date.gte=${from}&limit=250`;
  const out = [];
  for (let page = 0; page < 80 && url; page++) {
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
export function normalizeContract(x, underlyingFallback) {
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
    underlyingPrice: Number(x.underlying_asset?.price) || underlyingFallback || null,
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

export function pickBest(contracts, { hv = {}, stocky = {}, now = Date.now(), ...opts } = {}) {
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
    // Next 5 sessions: a strike beyond Stocky's 1-day Target 1 would still be out of the money even if
    // Stocky is exactly right, so it isn't considered for the side Stocky points to.
    if (o.horizon === "short") {
      const sv = stocky[c.underlying];
      const tgt = sv?.d1Target1;
      const sideWanted = c.type === "call" ? "BUY" : "SELL";
      if (sv?.d1 === sideWanted && Number.isFinite(tgt)) {
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
  const horizonInfo = { call: { mode: "30d" }, put: { mode: "30d" } };
  const pick = (type) => {
    let list = usable.filter((c) => c.type === type);
    const wantSig = type === "call" ? "BUY" : "SELL";
    // Why a symbol has no 5-session trade on this side (for the page).
    const noShortReason = (sym) => {
      const sv = stocky[sym];
      if (!sv || !sv.d1) return `Stocky hasn't analysed ${sym} on the 1-day timeframe in the last 7 days (run it on Analyze first)`;
      if (sv.d1 !== wantSig) return `Stocky's latest 1-day call for ${sym} is ${sv.d1}, so there's no ${type === "call" ? "upside" : "downside"} target to trade${sv.d1 === (type === "call" ? "SELL" : "BUY") ? `; see the ${type === "call" ? "puts" : "calls"}` : ""}`;
      return `Stocky's 1-day target for ${sym} isn't ${type === "call" ? "above" : "below"} the current price`;
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
      const sv0 = stocky[c.underlying];
      const tgt = sv0?.d1Target1;
      if (shortMode && sv0?.d1 === want && Number.isFinite(tgt) && (type === "call" ? tgt > S : tgt < S)) {
        const days = o.shortDays;
        const vol = hvFor(hv[c.underlying], days) ?? c.iv;
        const Tafter = Math.max(0, (c.dte - days) / 365);
        const pReach = probTouch(S, tgt, vol, days / 365);
        const retTarget = ((bsPrice(type, tgt, c.strike, Tafter, o.riskFree, c.iv) - c.ask) / c.ask) * 100;
        const retFlat = ((bsPrice(type, S, c.strike, Tafter, o.riskFree, c.iv) - c.ask) / c.ask) * 100;
        c.shortTerm = { target: tgt, days, pReach, retTargetPct: retTarget, retFlatPct: retFlat, expectedPct: pReach * retTarget + (1 - pReach) * retFlat, targetAt: sv0.d1At };
      }

      // Profit estimate: favourable 1-sigma move over holdDays, IV unchanged, buy at ask, value at mid.
      const sigmaMove = (c.hvMove ?? c.hv ?? c.iv) * Math.sqrt(o.holdDays / 365); // typical move over the holding period
      const S1 = S * Math.exp(type === "call" ? sigmaMove : -sigmaMove);
      const Tleft = Math.max(0, (c.dte - o.holdDays) / 365);
      const vMove = bsPrice(type, S1, c.strike, Tleft, o.riskFree, c.iv);
      const vFlat = bsPrice(type, S, c.strike, Tleft, o.riskFree, c.iv);
      c.scenario = { holdDays: o.holdDays, movePct: (S1 / S - 1) * 100, targetPrice: S1 };
      c.projectedReturnPct = ((vMove - c.ask) / c.ask) * 100;
      c.flatReturnPct = ((vFlat - c.ask) / c.ask) * 100;
      c.costPerContract = c.ask * c.sharesPerContract;
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
      horizonInfo[type] = {
        mode: "short",
        target: list[0].shortTerm.target,
        days: o.shortDays,
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
  return { calls, puts, callsByExpiry: mark(byExpiry.call, calls), putsByExpiry: mark(byExpiry.put, puts), horizon: horizonInfo, stats, settings: o };
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
