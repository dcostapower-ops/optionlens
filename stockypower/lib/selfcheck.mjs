// Self-check for Best Option Chains: re-verifies a live scan against Massive and
// recomputes every number with formulas written separately from lib/options.mjs
// (different normal-CDF approximation, own Black-Scholes, own probability maths).
// Produces a list of checks: { area, item, status: "pass"|"warn"|"fail", detail }.

const DAY = 864e5;

// ── Independent maths ────────────────────────────────────────────────────────

// erf via Abramowitz-Stegun 7.1.26 (options.mjs uses 26.2.17 for the CDF directly).
function erf(x) {
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const Phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

function bs(type, S, K, T, r, v) {
  if (T <= 0 || v <= 0) return Math.max(0, type === "call" ? S - K : K - S);
  const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * Math.sqrt(T));
  const d2 = d1 - v * Math.sqrt(T);
  return type === "call" ? S * Phi(d1) - K * Math.exp(-r * T) * Phi(d2) : K * Math.exp(-r * T) * Phi(-d2) - S * Phi(-d1);
}
const touch = (S, K, v, T) => Math.min(1, 2 * (1 - Phi(Math.abs(Math.log(K / S)) / (v * Math.sqrt(T)))));
const beyond = (type, S, L, v, T) => {
  const z = (Math.log(S / L) - 0.5 * v * v * T) / (v * Math.sqrt(T));
  return type === "call" ? Phi(z) : 1 - Phi(z);
};
function hvMix(short, long, days) {
  if (!short) return long ?? null;
  if (!long) return short;
  const w = Math.min(1, Math.max(0, (days - 30) / 335));
  return short + (long - short) * w;
}
function realized(closes, n) {
  if (closes.length < n + 1) return null;
  const r = [];
  for (let i = closes.length - n; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt((r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)) * 252);
}

// ── Massive ──────────────────────────────────────────────────────────────────

async function get(base, apiKey, path) {
  const r = await fetch(base + path, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function chainSummary(base, apiKey, symbol, fromDate) {
  let url = `/v3/snapshot/options/${encodeURIComponent(symbol)}?expiration_date.gte=${fromDate}&limit=250`;
  let count = 0, pages = 0, minExp = null;
  for (; url && pages < 80; pages++) {
    const body = await get(base, apiKey, url);
    for (const x of body.results ?? []) {
      count++;
      const e = x?.details?.expiration_date;
      if (e && (!minExp || e < minExp)) minExp = e;
    }
    if (body.next_url) {
      const n = new URL(body.next_url);
      n.searchParams.delete("apiKey"); // the key goes in the header, never the URL
      url = n.pathname + n.search;
    } else url = null;
  }
  return { count, pages, minExp };
}

// ── The check ────────────────────────────────────────────────────────────────

const close = (a, b, absTol, relTol = 0) => Math.abs(a - b) <= Math.max(absTol, Math.abs(b) * relTol);
const f2 = (v, d = 2) => (v == null || !Number.isFinite(v) ? "n/a" : Number(v).toFixed(d));

export async function selfCheck({ base, apiKey, result, now = Date.now() }) {
  const checks = [];
  const add = (area, item, status, detail) => checks.push({ area, item, status, detail });
  const o = result.settings;
  const picks = [...result.calls.map((c) => ({ ...c, side: "call" })), ...result.puts.map((c) => ({ ...c, side: "put" }))];

  // 1. Completeness of the scan.
  const fromDate = new Date(now + o.minDays * DAY).toISOString().slice(0, 10);
  for (const sym of result.symbols) {
    try {
      const s = await chainSummary(base, apiKey, sym, fromDate);
      const scanned = result.underlying?.[sym]?.contracts;
      const diff = scanned != null ? Math.abs(s.count - scanned) : null;
      add("Coverage", `${sym} option chain`, diff == null ? "warn" : diff === 0 ? "pass" : diff <= Math.max(5, s.count * 0.01) ? "warn" : "fail",
        `Massive lists ${s.count.toLocaleString()} contracts expiring ${fromDate} or later across ${s.pages} page(s); the scan read ${scanned?.toLocaleString() ?? "?"}` +
          (diff ? ` (difference ${diff}; listings change during the day)` : ""));
      add("Coverage", `${sym} nothing inside ${o.minDays - 1} days`, !s.minExp || s.minExp >= fromDate ? "pass" : "fail", `earliest expiry returned: ${s.minExp ?? "none"}`);
    } catch (err) {
      add("Coverage", `${sym} option chain`, "warn", `couldn't re-read the chain (${err.message})`);
    }
  }

  // 2. Realised volatility from fresh daily prices.
  for (const sym of result.symbols) {
    try {
      const to = new Date(now + DAY).toISOString().slice(0, 10);
      const from = new Date(now - 400 * DAY).toISOString().slice(0, 10);
      const body = await get(base, apiKey, `/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=5000`);
      const closes = (body.results ?? []).map((b) => b.c).filter((c) => c > 0);
      const s30 = realized(closes, 30), s1y = realized(closes, Math.min(252, closes.length - 1));
      const u = result.underlying?.[sym] ?? {};
      const ok = close(s30 ?? 0, u.hv ?? 0, 0.002) && close(s1y ?? 0, u.hvLong ?? 0, 0.002);
      add("Inputs", `${sym} realized volatility`, ok ? "pass" : "fail", `recomputed 30-day ${f2(s30 * 100, 1)}% / 1-year ${f2(s1y * 100, 1)}%; app used ${f2(u.hv * 100, 1)}% / ${f2(u.hvLong * 100, 1)}%`);
    } catch (err) {
      add("Inputs", `${sym} realized volatility`, "warn", `couldn't re-read daily prices (${err.message})`);
    }
  }

  // 3. Per pick: live data, filters, maths.
  for (const c of picks) {
    const name = `${c.underlying} ${c.strike} ${c.side} ${c.expiration}`;
    // Live data
    try {
      const body = await get(base, apiKey, `/v3/snapshot/options/${encodeURIComponent(c.underlying)}/${encodeURIComponent(c.ticker)}`);
      const x = body.results ?? {};
      const d = x.details ?? {};
      const same = Number(d.strike_price) === c.strike && d.expiration_date === c.expiration && String(d.contract_type).toLowerCase() === c.side;
      add("Live data", `${name}: contract`, same ? "pass" : "fail", same ? `${c.ticker} confirmed` : `Massive says ${d.contract_type} ${d.strike_price} ${d.expiration_date}`);
      const q = x.last_quote ?? {};
      const tol = Math.max(0.05, c.ask * 0.03);
      const qOk = close(Number(q.bid), c.bid, tol) && close(Number(q.ask), c.ask, tol);
      add("Live data", `${name}: bid/ask`, qOk ? "pass" : "warn", `now ${f2(q.bid)} / ${f2(q.ask)}; shown ${f2(c.bid)} / ${f2(c.ask)}${qOk ? "" : " (moved since the scan, live market)"}`);
      const dOk = close(Number(x.greeks?.delta), c.delta, 0.05);
      const ivOk = close(Number(x.implied_volatility), c.iv, 0.03);
      add("Live data", `${name}: delta / IV`, dOk && ivOk ? "pass" : "warn", `now delta ${f2(x.greeks?.delta)}, IV ${f2(x.implied_volatility * 100, 1)}%; shown ${f2(c.delta)}, ${f2(c.iv * 100, 1)}%`);
      const oi = Number(x.open_interest), vol = Number(x.day?.volume);
      add("Live data", `${name}: open interest / volume`, oi === c.openInterest && vol >= c.volume ? "pass" : "warn",
        `now OI ${oi.toLocaleString()}, volume ${vol.toLocaleString()}; shown ${c.openInterest.toLocaleString()}, ${c.volume.toLocaleString()}`);
    } catch (err) {
      add("Live data", `${name}`, "warn", `couldn't fetch this contract from Massive (${err.message})`);
    }

    // Filters
    const dte = Math.round((Date.parse(c.expiration + "T21:00:00Z") - now) / DAY);
    const spread = ((c.ask - c.bid) / ((c.ask + c.bid) / 2)) * 100;
    const filters = [
      [`more than ${o.minDays - 1} days`, dte >= o.minDays, `${dte} days`],
      ...(o.maxDays ? [[`at most ${o.maxDays} days`, dte <= o.maxDays, `${dte} days`]] : []),
      ["two-sided quote", c.bid > 0 && c.ask >= c.bid, `${f2(c.bid)} / ${f2(c.ask)}`],
      [`|delta| ${o.deltaMin}-${o.deltaMax}`, Math.abs(c.delta) >= o.deltaMin && Math.abs(c.delta) <= o.deltaMax, f2(c.delta)],
      [`open interest >= ${o.minOpenInterest}`, c.openInterest >= o.minOpenInterest, c.openInterest.toLocaleString()],
      [`volume >= ${o.minVolume}`, c.volume >= o.minVolume, c.volume.toLocaleString()],
      [`spread < ${o.maxSpreadPct}%`, spread <= o.maxSpreadPct, `${f2(spread)}%`],
    ];
    const itmPct = ((c.side === "call" ? c.underlyingPrice - c.strike : c.strike - c.underlyingPrice) / c.underlyingPrice) * 100;
    if (c.shortTerm) {
      const t = c.shortTerm.target;
      filters.push([`5 sessions: strike not beyond Stocky's target ${t}`, c.side === "call" ? c.strike <= t : c.strike >= t, `strike ${c.strike}`]);
    }
    if (o.excludeMoneyness === "itm") filters.push([`strike preference "${o.strikePrefLabel}": not in the money`, itmPct <= 2, `${f2(itmPct, 1)}% in the money`]);
    if (o.excludeMoneyness === "otm") filters.push([`strike preference "${o.strikePrefLabel}": not out of the money`, itmPct >= -2, `${f2(-itmPct, 1)}% out of the money`]);
    const S = c.underlyingPrice, T = c.dte / 365;
    const otm = c.side === "call" ? c.strike > S : c.strike < S;
    const v = hvMix(result.underlying?.[c.underlying]?.hv, result.underlying?.[c.underlying]?.hvLong, c.dte) ?? c.iv;
    const tch = otm ? touch(S, c.strike, v, T) : 1;
    if (otm) filters.push([`OTM: >= ${Math.round(o.minTouchProb * 100)}% chance to reach strike`, tch >= o.minTouchProb - 1e-6, `${f2(tch * 100, 1)}%`]);
    const failed = filters.filter(([, ok]) => !ok);
    add("Filters", name, failed.length ? "fail" : "pass", failed.length ? failed.map(([n, , d]) => `${n}: ${d}`).join("; ") : `all ${filters.length} filters met`);

    // Maths, recomputed independently
    const be = c.side === "call" ? c.strike + c.ask : c.strike - c.ask;
    const fair = bs(c.side, S, c.strike, T, o.riskFree, v);
    // Events before an exit: their variance is added to the move and removed from the IV.
    const evs = result.underlying?.[c.underlying]?.events || [];
    const evVar = (days) => evs.filter((e) => c.expiration >= e.by && e.afterDays < days).reduce((a, e) => a + e.eventVar, 0);
    const ivAfter = (ev) => (ev > 0 ? Math.sqrt(Math.max(c.iv * c.iv * T - ev, 0.25 * c.iv * c.iv * T) / T) : c.iv);
    const evH = evVar(o.holdDays), ivH = ivAfter(evH);
    const vMove = hvMix(result.underlying?.[c.underlying]?.hv, result.underlying?.[c.underlying]?.hvLong, o.holdDays) ?? c.iv;
    const mv = Math.sqrt(vMove * vMove * (o.holdDays / 365) + evH);
    const S1 = S * Math.exp(c.side === "call" ? mv : -mv);
    const Tl = Math.max(0, (c.dte - o.holdDays) / 365);
    const proj = ((bs(c.side, S1, c.strike, Tl, o.riskFree, ivH) - c.ask) / c.ask) * 100;
    const flat = ((bs(c.side, S, c.strike, Tl, o.riskFree, ivH) - c.ask) / c.ask) * 100;
    const be2 = beyond(c.side, S, be, v, T);
    let wSum = 0, tot = 0;
    for (const [k, w] of Object.entries(c.weightSet === "short" ? o.weightsShort : o.weights)) {
      if (c.scores?.[k] == null) continue;
      wSum += w;
      tot += w * c.scores[k];
    }
    const score = wSum ? tot / wSum : 0;
    const hasHv = result.underlying?.[c.underlying]?.hv != null;
    const maths = [
      ["spread %", spread, c.spreadPct, 0.01],
      ["cost per contract", c.ask * c.sharesPerContract, c.costPerContract, 0.01],
      ["breakeven", be, c.breakeven, 0.005],
      ...(hasHv ? [["fair value", fair, c.fairValue, 0.02, 0.002], ["premium vs fair", c.ask / fair, c.premiumVsFair, 0.005]] : []),
      ...(otm ? [["chance to reach strike", tch, c.touchProb, 0.002]] : []),
      ["chance of profit at expiry", be2, c.beProb, 0.002],
      ...(evH > 0 ? [["IV after events before a 30-day exit", ivH, c.ivExitHold, 1e-6]] : []),
      ["estimated return %", proj, c.projectedReturnPct, 0.1, 0.002],
      ["if flat 30 days %", flat, c.flatReturnPct, 0.1, 0.002],
      ["score from factor weights", score, c.score, 0.0005],
    ];
    if (c.shortTerm) {
      const st = c.shortTerm;
      const vS = hvMix(result.underlying?.[c.underlying]?.hv, result.underlying?.[c.underlying]?.hvLong, st.days) ?? c.iv;
      const Ta = Math.max(0, (c.dte - st.days) / 365);
      const evS = evVar(st.days), ivS = ivAfter(evS);
      const p = touch(S, st.target, vS, st.days / 365);
      const rT = ((bs(c.side, st.target, c.strike, Ta, o.riskFree, ivS) - c.ask) / c.ask) * 100;
      const rF = ((bs(c.side, S, c.strike, Ta, o.riskFree, ivS) - c.ask) / c.ask) * 100;
      maths.push(
        ...(evS > 0 ? [["IV after events before the 5-session exit", ivS, st.ivExit, 1e-6]] : []),
        ["chance to reach Stocky's target in 5 sessions", p, st.pReach, 0.002],
        ["return if target reached %", rT, st.retTargetPct, 0.1, 0.002],
        ["return if flat 5 sessions %", rF, st.retFlatPct, 0.1, 0.002],
        ...(st.method === "target" ? [["expected 5-session return %", p * rT + (1 - p) * rF, st.expectedPct, 0.1, 0.002]] : []),
      );
      if (st.method === "forecast") {
        // Simpson's rule over -6..6 sd (the app uses a 161-point grid over -4..4).
        const sg = st.forecastSigma, F = st.forecastPrice, n = 240, h = 12 / n;
        let ev = 0, pp = 0, wsum = 0;
        for (let i = 0; i <= n; i++) {
          const z = -6 + i * h;
          const coef = i === 0 || i === n ? 1 : i % 2 ? 4 : 2;
          const wi = coef * Math.exp(-0.5 * z * z);
          const v = bs(c.side, F * Math.exp(sg * z), c.strike, Ta, o.riskFree, ivS);
          ev += wi * v;
          wsum += wi;
          if (v > c.ask) pp += wi;
        }
        const sg0 = st.forecastLow > 0 && st.forecastHigh > st.forecastLow ? Math.log(st.forecastHigh / st.forecastLow) / 2 : st.forecastSigmaStocky;
        const ext = st.forecastDaysAhead != null && st.forecastDaysAhead < st.days - 0.5 ? (vS * vS * (st.days - st.forecastDaysAhead)) / 365 : 0;
        const sgExpected = Math.sqrt(sg0 * sg0 + ext + evS);
        maths.push(
          ["forecast spread (log sd)", sgExpected, sg, 1e-9],
          ["return at Stocky's forecast price %", ((bs(c.side, F, c.strike, Ta, o.riskFree, ivS) - c.ask) / c.ask) * 100, st.retAtForecastPct, 0.1, 0.002],
          ["expected 5-session return from forecast %", ((ev / wsum - c.ask) / c.ask) * 100, st.expectedPct, 0.3, 0.005],
          ["chance in profit after 5 sessions", pp / wsum, st.pProfit, 0.03],
        );
      }
    }
    const bad = maths.filter(([, mine, app, abs, rel]) => !(Number.isFinite(app) && close(mine, app, abs, rel || 0)));
    add("Maths", name, bad.length ? "fail" : "pass",
      bad.length ? bad.map(([n, mine, app]) => `${n}: recomputed ${f2(mine, 4)} vs app ${f2(app, 4)}`).join("; ") : `${maths.length} numbers recomputed independently and match`);
  }

  // 3b. Events from the IV term structure, recomputed independently.
  for (const [sym, u] of Object.entries(result.underlying || {})) {
    const term = u.eventTerm || [];
    if (term.length < 4) {
      add("Inputs", `${sym}: events (earnings) from IV term structure`, "warn", `only ${term.length} expiries near the money; can't look for events`);
      continue;
    }
    let pw = 0, pt = 0;
    const fv = term.map((p) => { const T = p.days / 365, w = p.iv * p.iv * T, f = (w - pw) / (T - pt); pw = w; pt = T; return f; });
    const base = [...fv].sort((a, b) => a - b)[Math.floor((fv.length - 1) / 2)];
    let pT = 0;
    const flagged = term.map((p, i) => { const T = p.days / 365, dT = T - pT; pT = T; return fv[i] > base * 1.3 && (fv[i] - base) * dT >= 0.03 ** 2 ? (fv[i] - base) * dT : 0; });
    const mineTotal = flagged.reduce((a, b) => a + b, 0);
    const appTotal = (u.events || []).reduce((a, e) => a + e.eventVar, 0);
    const ok = Math.abs(mineTotal - appTotal) < 1e-9 && (u.events || []).every((e) => Math.abs(e.movePct - Math.sqrt(e.eventVar) * 100) < 1e-9);
    add("Inputs", `${sym}: events (earnings) from IV term structure`, ok ? "pass" : "fail",
      `${term.length} expiries; normal IV ${(Math.sqrt(base) * 100).toFixed(1)}%; ` +
        ((u.events || []).length ? u.events.map((e) => `event between ${e.after || "today"} and ${e.by}, about ±${e.movePct.toFixed(1)}%`).join("; ") : "no event found") +
        (ok ? "" : ` (recomputed event variance ${mineTotal.toFixed(6)} vs app ${appTotal.toFixed(6)})`));
  }

  // 4. Selection and ordering.
  for (const [label, list, byExp, side] of [["calls", result.calls, result.callsByExpiry, "call"], ["puts", result.puts, result.putsByExpiry, "put"]]) {
    if (!list.length) {
      const h = result.horizon?.[side];
      if (h?.mode === "none") add("Selection", label, "pass", `no 5-session ${side} trade, as intended: ${h.reason}`);
      else add("Selection", label, "warn", "no contracts passed the filters");
      continue;
    }
    if (o.horizon === "short") {
      const all = list.every((c) => c.shortTerm);
      add("Selection", `${label}: all ranked on Stocky's 5-session target`, all ? "pass" : "fail", all ? `target ${list[0].shortTerm.target}` : "some picks have no 5-session scenario");
    }
    const sorted = list.every((c, i) => i === 0 || list[i - 1].rankReturnPct >= c.rankReturnPct);
    add("Selection", `${label}: most profitable first (${list[0].weightSet === "short" ? "expected 5-session return" : "estimated 30-day return"})`, sorted ? "pass" : "fail", list.map((c) => `${f2(c.rankReturnPct, 1)}%`).join(" > "));
    const per = {};
    for (const c of list) per[c.expiration] = (per[c.expiration] || 0) + 1;
    const maxPer = Math.max(...Object.values(per));
    add("Selection", `${label}: at most ${o.maxPerExpiry} per expiry date`, maxPer <= o.maxPerExpiry ? "pass" : "fail", Object.entries(per).map(([e, n]) => `${e}: ${n}`).join(", "));
    // No better-scoring contract was skipped, except where its expiry date was already full.
    const minPicked = Math.min(...list.map((c) => c.score));
    const skipped = (byExp || []).filter((c) => !c.picked && c.score > minPicked + 1e-9 && (per[c.expiration] || 0) < o.maxPerExpiry);
    add("Selection", `${label}: no better contract skipped`, skipped.length ? "fail" : "pass",
      skipped.length ? skipped.map((c) => `${c.strike} ${c.expiration} scored ${Math.round(c.score * 100)} but wasn't picked`).join("; ") : `lowest picked score ${Math.round(minPicked * 100)}; every higher-scoring expiry was picked or already had ${o.maxPerExpiry}`);
  }

  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.status]++;
  return { at: now, counts, checks };
}
