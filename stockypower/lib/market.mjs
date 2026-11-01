// Market data and sanity checks for Stockypower.
//
// - Timeframes and Massive (Polygon-compatible) candle fetching
// - ATR, used to judge whether Stocky's levels are a sensible distance from price
// - validateLevels(): consistency checks on targets / stops / forecast high
// - Track record: every call is saved locally and later scored against real bars

import fs from "node:fs";
import path from "node:path";

export const TIMEFRAMES = [
  { key: "15m", label: "15 min", mult: 15, span: "minute", lookbackDays: 10, next: "next 15 minutes" },
  { key: "1h", label: "1 hour", mult: 1, span: "hour", lookbackDays: 60, next: "next hour" },
  { key: "4h", label: "4 hours", mult: 4, span: "hour", lookbackDays: 240, next: "next 4 hours" },
  { key: "1D", label: "1 day", mult: 1, span: "day", lookbackDays: 730, next: "next trading day" },
  { key: "1W", label: "1 week", mult: 1, span: "week", lookbackDays: 365 * 6, next: "next week" },
  { key: "1M", label: "1 month", mult: 1, span: "month", lookbackDays: 365 * 20, next: "next month" },
];
export const TF_KEYS = TIMEFRAMES.map((t) => t.key);
const MAX_BARS = 500;

const ymd = (d) => d.toISOString().slice(0, 10);

// Candles for one timeframe: [{ t (unix seconds), o, h, l, c, v }], oldest first.
export async function fetchCandles({ base, apiKey, symbol, tf }) {
  const to = new Date();
  const from = new Date(to.getTime() - tf.lookbackDays * 864e5);
  const url =
    `${base}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${tf.mult}/${tf.span}/${ymd(from)}/${ymd(to)}` +
    `?adjusted=true&sort=asc&limit=50000`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(25_000) });
  if (r.status === 401 || r.status === 403) throw new Error(`Massive rejected the API key (HTTP ${r.status})`);
  if (!r.ok) throw new Error(`Massive HTTP ${r.status} for ${tf.label} bars`);
  const body = await r.json();
  return (body.results ?? [])
    .slice(-MAX_BARS)
    .map((b) => ({ t: Math.floor(b.t / 1000), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 }));
}

export function candlesToCsv(bars) {
  const lines = ["t,datetime_utc,open,high,low,close,volume"];
  for (const b of bars) lines.push([b.t, new Date(b.t * 1000).toISOString(), b.o, b.h, b.l, b.c, b.v].join(","));
  return lines.join("\n") + "\n";
}

// Wilder's ATR(14). Returns null if there aren't enough bars.
export function atr(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const { h, l } = bars[i];
    const pc = bars[i - 1].c;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let a = tr.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
  return a;
}

// ── Stocky's per-timeframe output ────────────────────────────────────────────

const num = (x) => (x === null || x === undefined || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null);

// Accepts unix seconds, unix ms, or an ISO date/time string.
function toUnix(t) {
  if (typeof t === "number" || /^\d+$/.test(String(t))) {
    const n = Number(t);
    return n > 1e12 ? Math.floor(n / 1000) : n;
  }
  const ms = Date.parse(String(t));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function cleanSeries(arr, valueKey) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  return arr
    .map((p) => ({ t: toUnix(p?.t ?? p?.time ?? p?.date), v: num(p?.[valueKey] ?? p?.v ?? p?.value) }))
    .filter((p) => p.t !== null && p.v !== null && !seen.has(p.t) && seen.add(p.t))
    .sort((a, b) => a.t - b.t)
    .slice(-MAX_BARS);
}

function cleanForecast(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  return arr
    .map((p) => ({ t: toUnix(p?.t ?? p?.time ?? p?.date), price: num(p?.price), low: num(p?.low), high: num(p?.high) }))
    .filter((p) => p.t !== null && p.price !== null && !seen.has(p.t) && seen.add(p.t))
    .sort((a, b) => a.t - b.t)
    .slice(0, 200);
}

const SIGNALS = ["BUY", "SELL", "HOLD"];

// Normalises Stocky's stockypower.json (or the timeframes inside VERDICT_JSON).
export function cleanAnalysis(raw) {
  if (!raw || typeof raw !== "object") return null;
  const tfsIn = raw.timeframes && typeof raw.timeframes === "object" ? raw.timeframes : {};
  const timeframes = {};
  for (const key of TF_KEYS) {
    const x = tfsIn[key] ?? tfsIn[key.toLowerCase()];
    if (!x || typeof x !== "object") continue;
    const signal = String(x.signal ?? "").toUpperCase();
    timeframes[key] = {
      signal: SIGNALS.includes(signal) ? signal : null,
      confidence: num(x.confidence),
      price: num(x.price ?? x.last_close),
      target1: num(x.target1 ?? x.target_1),
      target2: num(x.target2 ?? x.target_2),
      stop1: num(x.stop1 ?? x.stop_loss1 ?? x.stop_loss_1),
      stop2: num(x.stop2 ?? x.stop_loss2 ?? x.stop_loss_2),
      forecast_high: num(x.forecast_high),
      forecast_low: num(x.forecast_low),
      rationale: typeof x.rationale === "string" ? x.rationale.slice(0, 600) : "",
      forecast: cleanForecast(x.forecast),
      indicators: (Array.isArray(x.indicators) ? x.indicators : []).slice(0, 8).map((ind) => ({
        name: String(ind?.name ?? "Indicator").slice(0, 60),
        pane: ind?.pane === "price" ? "price" : "separate",
        value: ind?.value ?? null,
        reading: String(ind?.reading ?? "").slice(0, 40),
        series: cleanSeries(ind?.series, "v"),
      })),
    };
  }
  return {
    indicators_used: Array.isArray(raw.indicators_used) ? raw.indicators_used.map(String).slice(0, 8) : [],
    timeframes,
  };
}

// ── Accuracy checks ──────────────────────────────────────────────────────────

const fmt = (v) => (v === null || v === undefined ? "?" : Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2));

// Checks one timeframe's levels against the real last close and ATR.
// Returns { ok, issues: [string], lastClose, atr, rr }.
export function validateLevels(a, bars) {
  const issues = [];
  const last = bars?.length ? bars[bars.length - 1].c : null;
  const A = atr(bars);
  if (!a) return { ok: false, issues: ["Stocky returned no levels for this timeframe."], lastClose: last, atr: A, rr: null };
  const { signal, target1: t1, target2: t2, stop1: s1, stop2: s2, forecast_high: fh, forecast_low: fl, price } = a;

  for (const [name, v] of [["Target 1", t1], ["Target 2", t2], ["Stop loss 1", s1], ["Stop loss 2", s2], ["Forecast high", fh]]) {
    if (v === null) issues.push(`${name} is missing.`);
    else if (v <= 0) issues.push(`${name} (${fmt(v)}) is not a valid price.`);
  }

  if (last !== null && price !== null && Math.abs(price - last) / last > 0.005)
    issues.push(`Stocky used a price of ${fmt(price)}, but Massive's latest close is ${fmt(last)}. Its levels may be based on stale data.`);

  const P = last ?? price;
  if (P !== null) {
    if (signal === "BUY") {
      if (t1 !== null && t1 <= P) issues.push(`BUY Target 1 (${fmt(t1)}) should be above the price (${fmt(P)}).`);
      if (t1 !== null && t2 !== null && t2 <= t1) issues.push(`Target 2 (${fmt(t2)}) should be above Target 1 (${fmt(t1)}).`);
      if (s1 !== null && s1 >= P) issues.push(`BUY Stop loss 1 (${fmt(s1)}) should be below the price (${fmt(P)}).`);
      if (s1 !== null && s2 !== null && s2 >= s1) issues.push(`Stop loss 2 (${fmt(s2)}) should be below Stop loss 1 (${fmt(s1)}).`);
    } else if (signal === "SELL") {
      if (t1 !== null && t1 >= P) issues.push(`SELL Target 1 (${fmt(t1)}) should be below the price (${fmt(P)}).`);
      if (t1 !== null && t2 !== null && t2 >= t1) issues.push(`Target 2 (${fmt(t2)}) should be below Target 1 (${fmt(t1)}).`);
      if (s1 !== null && s1 <= P) issues.push(`SELL Stop loss 1 (${fmt(s1)}) should be above the price (${fmt(P)}).`);
      if (s1 !== null && s2 !== null && s2 <= s1) issues.push(`Stop loss 2 (${fmt(s2)}) should be above Stop loss 1 (${fmt(s1)}).`);
    } else if (!signal) {
      issues.push("No BUY/SELL signal for this timeframe.");
    }
    if (fh !== null && fh < P) issues.push(`Forecast high (${fmt(fh)}) is below the current price (${fmt(P)}).`);
    if (fh !== null && fl !== null && fl > fh) issues.push(`Forecast low (${fmt(fl)}) is above the forecast high (${fmt(fh)}).`);

    if (A) {
      const far = (v, max, name) => {
        if (v === null) return;
        const k = Math.abs(v - P) / A;
        if (k > max) issues.push(`${name} (${fmt(v)}) is ${k.toFixed(1)}× this timeframe's average bar range (ATR ${fmt(A)}) away from price. That's unusually far.`);
      };
      far(t1, 6, "Target 1");
      far(t2, 10, "Target 2");
      far(s1, 6, "Stop loss 1");
      far(s2, 10, "Stop loss 2");
      if (fh !== null && fh - P > 3 * A)
        issues.push(`Forecast high (${fmt(fh)}) is more than 3× ATR (${fmt(A)}) above price for a single bar. That's an unusually large move.`);
      if (s1 !== null && Math.abs(P - s1) < 0.2 * A)
        issues.push(`Stop loss 1 (${fmt(s1)}) is within 0.2× ATR of price. Normal noise will likely trigger it.`);
    }
  }

  let rr = null;
  if (P !== null && t1 !== null && s1 !== null && P !== s1) {
    const reward = signal === "SELL" ? P - t1 : t1 - P;
    const risk = signal === "SELL" ? s1 - P : P - s1;
    if (risk > 0) rr = reward / risk;
  }
  return { ok: issues.length === 0, issues, lastClose: last, atr: A, rr };
}

// ── Track record ─────────────────────────────────────────────────────────────

export function trackStore(dir) {
  const file = path.join(dir, "predictions.jsonl");
  return {
    save(records) {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    },
    load(symbol) {
      if (!fs.existsSync(file)) return [];
      return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((r) => r && r.symbol === symbol);
    },
  };
}

// Scores one saved call against the bars that came after it.
export function scorePrediction(p, bars) {
  const after = bars.filter((b) => b.t > p.asOfT);
  if (!after.length) return { status: "open", fhHeld: null };
  const next = after[0];
  const fhHeld = p.forecast_high != null ? next.h <= p.forecast_high : null;
  if (p.signal !== "BUY" && p.signal !== "SELL") return { status: "n/a", fhHeld };
  for (const b of after) {
    const stopHit = p.signal === "BUY" ? b.l <= p.stop1 : b.h >= p.stop1;
    const targetHit = p.signal === "BUY" ? b.h >= p.target1 : b.l <= p.target1;
    // Same bar: we can't know which came first, so count it against the call.
    if (stopHit) return { status: "stop", fhHeld };
    if (targetHit) {
      const t2Hit = after.some((x) => x.t >= b.t && (p.signal === "BUY" ? x.h >= p.target2 : x.l <= p.target2));
      return { status: t2Hit ? "target2" : "target1", fhHeld };
    }
  }
  return { status: "open", fhHeld };
}

// Summary per timeframe for one symbol: { tfKey: { calls, target1, target2, stop, open, fhHeld, fhChecked } }
export function trackRecord(predictions, candlesByTf) {
  const out = {};
  for (const p of predictions) {
    const bars = candlesByTf[p.tf];
    if (!bars?.length) continue;
    const s = scorePrediction(p, bars);
    const r = (out[p.tf] ??= { calls: 0, target1: 0, target2: 0, stop: 0, open: 0, fhHeld: 0, fhChecked: 0 });
    r.calls++;
    if (s.status === "target1") r.target1++;
    else if (s.status === "target2") (r.target1++, r.target2++);
    else if (s.status === "stop") r.stop++;
    else if (s.status === "open") r.open++;
    if (s.fhHeld !== null) (r.fhChecked++, s.fhHeld && r.fhHeld++);
  }
  return out;
}
