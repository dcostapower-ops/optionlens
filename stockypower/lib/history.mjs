// Grades Stocky's past calls against what the price actually did afterwards.
//
// A "call" is one saved timeframe from one Stocky run: signal, entry (the last
// close when Stocky answered), Target 1/2, Stop loss 1/2, forecast high/low for
// the next bar, and (newer runs) the 10-bar forecast path.

export const RESOLVE_BARS = 30; // a call that hits neither T1 nor SL1 within this many bars "expires"
const DEFAULT_HORIZON = 10; // bars, for the direction check (Stocky forecasts 10 bars)

const pct = (a, b) => ((a - b) / b) * 100;

// Outcome of one call, given that timeframe's bars (oldest first).
export function evaluateCall(p, bars) {
  const after = (bars || []).filter((b) => b.t > p.asOfT);
  const last = after.at(-1) ?? null;
  const dir = p.signal === "BUY" ? 1 : p.signal === "SELL" ? -1 : 0;
  const ret = (exit) => (dir && p.entry ? dir * pct(exit, p.entry) : null);
  const out = {
    status: "open",
    barsElapsed: after.length,
    hitT: null,
    exitPrice: null,
    returnPct: null,
    directionOk: null,
    fhHeld: null,
    flHeld: null,
    pathErrorPct: null,
    lastPrice: last?.c ?? null,
  };

  // Next-bar forecast range.
  if (after.length) {
    if (p.forecast_high != null) out.fhHeld = after[0].h <= p.forecast_high;
    if (p.forecast_low != null) out.flHeld = after[0].l >= p.forecast_low;
  }

  // Direction after the forecast horizon.
  const horizon = p.forecast?.length || DEFAULT_HORIZON;
  if (dir && after.length >= horizon) out.directionOk = dir * (after[horizon - 1].c - p.entry) > 0;

  // Forecast path error where actual bars exist (match the bar at or after each forecast time).
  if (Array.isArray(p.forecast) && p.forecast.length && after.length) {
    const errs = [];
    for (const f of p.forecast) {
      if (f?.t == null || f.price == null || f.t > last.t) continue;
      const bar = after.find((b) => b.t >= f.t);
      if (bar) errs.push(Math.abs(pct(bar.c, f.price)));
    }
    if (errs.length) out.pathErrorPct = errs.reduce((a, b) => a + b, 0) / errs.length;
  }

  if (!dir || p.target1 == null || p.stop1 == null) {
    out.status = "n/a";
    return out;
  }

  // Targets vs stop, bar by bar. If one bar touches both, we can't know which came
  // first, so it counts as stopped out (the cautious reading).
  const window = after.slice(0, RESOLVE_BARS);
  for (const b of window) {
    const stopHit = dir > 0 ? b.l <= p.stop1 : b.h >= p.stop1;
    const t1Hit = dir > 0 ? b.h >= p.target1 : b.l <= p.target1;
    if (stopHit) {
      Object.assign(out, { status: "stop", hitT: b.t, exitPrice: p.stop1 });
      out.returnPct = ret(p.stop1);
      return out;
    }
    if (t1Hit) {
      const rest = after.slice(after.indexOf(b), after.indexOf(b) + RESOLVE_BARS);
      const t2Bar =
        p.target2 != null
          ? rest.find((x, i) => {
              // T2 counts only if reached before the stop.
              const before = rest.slice(0, i + 1);
              const stopped = before.some((y) => (dir > 0 ? y.l <= p.stop1 : y.h >= p.stop1));
              return !stopped && (dir > 0 ? x.h >= p.target2 : x.l <= p.target2);
            })
          : null;
      if (t2Bar) Object.assign(out, { status: "target2", hitT: t2Bar.t, exitPrice: p.target2 });
      else Object.assign(out, { status: "target1", hitT: b.t, exitPrice: p.target1 });
      out.returnPct = ret(out.exitPrice);
      return out;
    }
  }
  if (after.length >= RESOLVE_BARS) {
    const b = after[RESOLVE_BARS - 1];
    Object.assign(out, { status: "expired", hitT: b.t, exitPrice: b.c });
    out.returnPct = ret(b.c);
  } else if (last) {
    out.returnPct = ret(last.c); // still open: return so far
  }
  return out;
}

// Rates over a list of evaluated calls: [{ ...call, outcome }].
export function summarize(calls) {
  const n = (f) => calls.filter(f).length;
  const s = {
    calls: calls.length,
    target1: n((c) => c.outcome.status === "target1"),
    target2: n((c) => c.outcome.status === "target2"),
    stop: n((c) => c.outcome.status === "stop"),
    expired: n((c) => c.outcome.status === "expired"),
    open: n((c) => c.outcome.status === "open"),
  };
  s.wins = s.target1 + s.target2;
  s.decided = s.wins + s.stop; // T1 or SL1 reached
  s.winRate = s.decided ? s.wins / s.decided : null; // Target 1 before Stop loss 1
  s.target2Rate = s.decided ? s.target2 / s.decided : null;
  const dirChecked = calls.filter((c) => c.outcome.directionOk !== null);
  s.directionChecked = dirChecked.length;
  s.directionRate = dirChecked.length ? dirChecked.filter((c) => c.outcome.directionOk).length / dirChecked.length : null;
  const fh = calls.filter((c) => c.outcome.fhHeld !== null);
  s.fhChecked = fh.length;
  s.fhHeldRate = fh.length ? fh.filter((c) => c.outcome.fhHeld).length / fh.length : null;
  const fl = calls.filter((c) => c.outcome.flHeld !== null);
  s.flChecked = fl.length;
  s.flHeldRate = fl.length ? fl.filter((c) => c.outcome.flHeld).length / fl.length : null;
  const pe = calls.map((c) => c.outcome.pathErrorPct).filter((v) => v !== null);
  s.pathChecked = pe.length;
  s.avgPathErrorPct = pe.length ? pe.reduce((a, b) => a + b, 0) / pe.length : null;
  const closed = calls.filter((c) => ["target1", "target2", "stop", "expired"].includes(c.outcome.status) && c.outcome.returnPct !== null);
  s.closed = closed.length;
  s.avgReturnPct = closed.length ? closed.reduce((a, c) => a + c.outcome.returnPct, 0) / closed.length : null;
  return s;
}

// Grouped summaries for the History page.
export function breakdown(calls, keyFn) {
  const groups = new Map();
  for (const c of calls) {
    const k = keyFn(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  return Object.fromEntries([...groups].map(([k, list]) => [k, summarize(list)]));
}
