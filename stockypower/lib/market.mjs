// Market data and sanity checks for Stockypower.
//
// - Timeframes and Massive (Polygon-compatible) candle fetching
// - ATR, used to judge whether Stocky's levels are a sensible distance from price
// - validateLevels(): consistency checks on targets / stops / forecast high
// - Track record: every call is saved locally and later scored against real bars

import fs from "node:fs";
import path from "node:path";

// Each timeframe says where its bars come from. Intraday timeframes use regular
// trading hours (09:30-16:00 New York) like TradingView's default, and 1h/4h bars
// are built from 30-minute bars anchored at the 09:30 open (9:30, 10:30, ... and
// 9:30 / 13:30), exactly as TradingView draws them. Massive's own hourly bars are
// clock-aligned and include pre/after-market trading, which doesn't match.
const SRC_15M = { mult: 15, span: "minute", lookbackDays: 35, maxRaw: 5000 };
const SRC_30M = { mult: 30, span: "minute", lookbackDays: 230, maxRaw: 12000 };
export const TIMEFRAMES = [
  { key: "15m", label: "15 min", next: "next 15 minutes", source: SRC_15M, intraday: true, aggMinutes: null },
  { key: "1h", label: "1 hour", next: "next hour", source: SRC_30M, intraday: true, aggMinutes: 60 },
  { key: "4h", label: "4 hours", next: "next 4 hours", source: SRC_30M, intraday: true, aggMinutes: 240 },
  { key: "1D", label: "1 day", next: "next trading day", source: { mult: 1, span: "day", lookbackDays: 730, maxRaw: 600 } },
  { key: "1W", label: "1 week", next: "next week", source: { mult: 1, span: "week", lookbackDays: 365 * 10, maxRaw: 600 } },
  { key: "1M", label: "1 month", next: "next month", source: { mult: 1, span: "month", lookbackDays: 365 * 30, maxRaw: 600 } },
];
export const TF_KEYS = TIMEFRAMES.map((t) => t.key);
const MAX_BARS = 500;
const RTH_OPEN = 9 * 60 + 30; // 09:30 New York
const RTH_CLOSE = 16 * 60; // 16:00 New York

const ymd = (d) => d.toISOString().slice(0, 10);

// Raw bars for one source: [{ t (unix seconds), o, h, l, c, v }], oldest first.
//
// Massive (like Polygon) caps each request at 50,000 *base* bars (minutes for
// intraday). Asking oldest-first over a long range returns only the OLDEST part
// and silently drops recent months, so ask newest-first and follow next_url.
async function fetchBars({ base, apiKey, symbol, src, label, lookbackDays }) {
  const to = new Date(Date.now() + 864e5); // include today
  const from = new Date(to.getTime() - (lookbackDays ?? src.lookbackDays) * 864e5);
  let url =
    `${base}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${src.mult}/${src.span}/${ymd(from)}/${ymd(to)}` +
    `?adjusted=true&sort=desc&limit=50000`;
  const byT = new Map();
  for (let page = 0; page < 12 && url && byT.size < src.maxRaw; page++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30_000) });
    if (r.status === 401 || r.status === 403) throw new Error(`Massive rejected the API key or plan for ${label} bars (HTTP ${r.status})`);
    if (!r.ok) throw new Error(`Massive HTTP ${r.status} for ${label} bars`);
    const body = await r.json();
    for (const b of body.results ?? []) {
      const t = Math.floor(b.t / 1000);
      if (!byT.has(t)) byT.set(t, { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 });
    }
    // next_url points at the next (older) page; the key goes in the header, never the URL.
    url = body.next_url ? body.next_url.replace(/([?&])apiKey=[^&]*&?/, "$1").replace(/[?&]$/, "") : null;
    if (url && base && !url.startsWith(base)) url = base + new URL(url).pathname + new URL(url).search;
  }
  return [...byT.values()].sort((x, y) => x.t - y.t);
}

// New York calendar date and minute-of-day for a unix time.
const nyFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
function nyTime(sec) {
  const p = Object.fromEntries(nyFmt.formatToParts(new Date(sec * 1000)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute };
}

// Regular-hours filter and session-anchored aggregation (TradingView style).
export function buildTimeframe(raw, tf, { extendedHours = false } = {}) {
  if (!tf.intraday) return raw.slice(-MAX_BARS);
  const tagged = raw.map((b) => ({ ...b, ny: nyTime(b.t) }));
  const kept = extendedHours ? tagged : tagged.filter((b) => b.ny.min >= RTH_OPEN && b.ny.min < RTH_CLOSE);
  if (!tf.aggMinutes) return kept.map(({ ny, ...b }) => b).slice(-MAX_BARS);
  const anchor = extendedHours ? 0 : RTH_OPEN;
  const out = [];
  let cur = null;
  for (const b of kept) {
    const key = `${b.ny.date}|${Math.floor((b.ny.min - anchor) / tf.aggMinutes)}`;
    if (!cur || cur.key !== key) {
      if (cur) out.push(cur.bar);
      cur = { key, bar: { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v } };
    } else {
      cur.bar.h = Math.max(cur.bar.h, b.h);
      cur.bar.l = Math.min(cur.bar.l, b.l);
      cur.bar.c = b.c;
      cur.bar.v += b.v;
    }
  }
  if (cur) out.push(cur.bar);
  return out.slice(-MAX_BARS);
}

// All timeframes for a symbol. Sources shared by several timeframes are fetched once.
// Returns the raw source bars too, so live updates can fetch just the newest bars.
export async function fetchTimeframes({ base, apiKey, symbol, extendedHours = false }) {
  const raw = {};
  const errors = [];
  const keys = [...new Set(TIMEFRAMES.map(srcKey))];
  await Promise.all(
    keys.map(async (key) => {
      const tf = TIMEFRAMES.find((t) => srcKey(t) === key);
      try {
        raw[key] = await fetchBars({ base, apiKey, symbol, src: tf.source, label: tf.label });
      } catch (err) {
        errors.push(`${TIMEFRAMES.filter((t) => srcKey(t) === key).map((t) => t.label).join("/")}: ${err.message}`);
      }
    }),
  );
  return { candles: buildAll(raw, extendedHours), errors, raw };
}

const srcKey = (tf) => `${tf.source.mult}/${tf.source.span}`;

function buildAll(raw, extendedHours) {
  const candles = {};
  for (const tf of TIMEFRAMES) {
    const bars = raw[srcKey(tf)];
    if (!bars?.length) continue;
    const built = buildTimeframe(bars, tf, { extendedHours });
    if (built.length) candles[tf.key] = built;
  }
  return candles;
}

// How far back a live update re-fetches each source (enough to cover the
// newest bars and any late corrections; delayed data updates the last bars).
const LIVE_LOOKBACK = { minute: 4, day: 20, week: 70, month: 400 };

// Fetches just the newest bars for each source, merges them into `raw`
// (newer data replaces older for the same bar), and rebuilds all timeframes.
export async function refreshTimeframes({ base, apiKey, symbol, raw, extendedHours = false }) {
  const errors = [];
  const merged = { ...raw };
  const keys = [...new Set(TIMEFRAMES.map(srcKey))];
  await Promise.all(
    keys.map(async (key) => {
      const tf = TIMEFRAMES.find((t) => srcKey(t) === key);
      try {
        const fresh = await fetchBars({ base, apiKey, symbol, src: tf.source, label: tf.label, lookbackDays: LIVE_LOOKBACK[tf.source.span] ?? 10 });
        const byT = new Map((raw[key] ?? []).map((b) => [b.t, b]));
        for (const b of fresh) byT.set(b.t, b);
        merged[key] = [...byT.values()].sort((x, y) => x.t - y.t).slice(-tf.source.maxRaw);
      } catch (err) {
        errors.push(`${tf.label}: ${err.message}`);
      }
    }),
  );
  return { candles: buildAll(merged, extendedHours), errors, raw: merged };
}

// How old a timeframe's newest bar may be before we call the data stale (seconds).
const MAX_AGE = { "15m": 4 * 86400, "1h": 4 * 86400, "4h": 5 * 86400, "1D": 6 * 86400, "1W": 16 * 86400, "1M": 62 * 86400 };

// Returns a warning if the newest bar is too old, else null.
export function staleWarning(tfKey, bars, nowSec = Date.now() / 1000) {
  if (!bars?.length) return null;
  const last = bars[bars.length - 1].t;
  if (nowSec - last <= (MAX_AGE[tfKey] ?? 7 * 86400)) return null;
  return `Massive's data for this timeframe ends on ${new Date(last * 1000).toISOString().slice(0, 10)}, so it is out of date.`;
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

// OHLC series for indicators drawn as candles (e.g. smoothed Heikin-Ashi).
function cleanCandles(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  return arr
    .map((p) => ({
      t: toUnix(p?.t ?? p?.time ?? p?.date),
      o: num(p?.o ?? p?.open),
      h: num(p?.h ?? p?.high),
      l: num(p?.l ?? p?.low),
      c: num(p?.c ?? p?.close),
    }))
    .filter((p) => p.t !== null && [p.o, p.h, p.l, p.c].every((v) => v !== null) && !seen.has(p.t) && seen.add(p.t))
    .map((p) => ({ ...p, h: Math.max(p.h, p.o, p.c), l: Math.min(p.l, p.o, p.c) }))
    .sort((a, b) => a.t - b.t)
    .slice(-MAX_BARS);
}

// Upper/lower (and optional middle) series for indicators drawn as bands.
function cleanBand(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  return arr
    .map((p) => ({ t: toUnix(p?.t ?? p?.time ?? p?.date), upper: num(p?.upper ?? p?.top ?? p?.u), lower: num(p?.lower ?? p?.bottom ?? p?.l), mid: num(p?.mid ?? p?.middle ?? p?.m) }))
    .filter((p) => p.t !== null && p.upper !== null && p.lower !== null && !seen.has(p.t) && seen.add(p.t))
    .sort((a, b) => a.t - b.t)
    .slice(-MAX_BARS);
}

// Buy/sell events from Stocky's strategy, for markers on the chart.
function cleanSignals(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p) => {
      const raw = String(p?.type ?? p?.signal ?? p?.side ?? "").toUpperCase();
      const side = /BUY|LONG|BULL/.test(raw) ? "BUY" : /SELL|SHORT|BEAR/.test(raw) ? "SELL" : null;
      const strong = /STRONG/.test(raw) || /strong/i.test(String(p?.strength ?? ""));
      return { t: toUnix(p?.t ?? p?.time ?? p?.date), side, strong, label: String(p?.label ?? "").slice(0, 16) };
    })
    .filter((p) => p.t !== null && p.side)
    .sort((a, b) => a.t - b.t)
    .slice(-150);
}

const STYLES = ["line", "histogram", "baseline", "candles", "band"];
const okColor = (c) => (typeof c === "string" && /^#[0-9a-f]{3,8}$/i.test(c) ? c : null);

// Indicator settings as reported by Stocky: simple key -> value pairs only.
function cleanSettings(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj).slice(0, 14)) {
    if (["string", "number", "boolean"].includes(typeof v)) out[String(k).slice(0, 30)] = typeof v === "string" ? v.slice(0, 30) : v;
  }
  return out;
}

// Named colours (e.g. bull, bear, bull_weak, bear_weak, line, signal, overbought, oversold).
function cleanColors(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj).slice(0, 12)) {
    const c = okColor(v);
    if (c) out[normKey(k)] = c;
  }
  return out;
}

function cleanIndicator(ind) {
  const style = STYLES.includes(String(ind?.style ?? "").toLowerCase()) ? String(ind.style).toLowerCase() : "line";
  const raw = ind?.series ?? ind?.values ?? ind?.data;
  return {
    name: String(ind?.name ?? ind?.indicator ?? "Indicator").slice(0, 60),
    pane: /price|overlay|main/i.test(String(ind?.pane ?? ind?.panel ?? "")) ? "price" : "separate",
    group: ind?.group != null ? String(ind.group).slice(0, 40) : null,
    style,
    color: okColor(ind?.color),
    colors: cleanColors(ind?.colors),
    settings: cleanSettings(ind?.settings ?? ind?.params ?? ind?.parameters ?? ind?.inputs),
    base: num(ind?.base ?? ind?.centerline ?? ind?.center),
    levels: (Array.isArray(ind?.levels) ? ind.levels : []).map(num).filter((v) => v !== null).slice(0, 6),
    value: ind?.value ?? null,
    reading: String(ind?.reading ?? ind?.signal ?? "").slice(0, 40),
    series: style === "candles" || style === "band" ? [] : cleanSeries(raw, "v"),
    candles: style === "candles" ? cleanCandles(raw) : [],
    band: style === "band" ? cleanBand(raw) : [],
  };
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

// Many ways Stocky might name a timeframe -> our key. ("1m" means 1 month here:
// there is no 1-minute timeframe in Stockypower.)
const TF_ALIASES = {
  "15m": ["15m", "15min", "15mins", "15minute", "15minutes", "m15", "15", "quarterhour"],
  "1h": ["1h", "1hr", "1hour", "hour", "hourly", "h1", "60m", "60min", "60minutes", "60"],
  "4h": ["4h", "4hr", "4hrs", "4hour", "4hours", "h4", "240m", "240min", "240"],
  "1D": ["1d", "d", "d1", "1day", "day", "daily", "1440m"],
  "1W": ["1w", "w", "w1", "1wk", "1week", "week", "weekly"],
  "1M": ["1m", "1mo", "1mon", "1mth", "1month", "month", "monthly", "mn", "mn1"],
};
const normKey = (k) => String(k).toLowerCase().replace(/[\s_\-.]/g, "");
const TF_LOOKUP = Object.fromEntries(Object.entries(TF_ALIASES).flatMap(([key, al]) => al.map((a) => [a, key])));
export const tfKeyOf = (k) => TF_LOOKUP[normKey(k)] ?? null;

const FIELD_ALIASES = {
  signal: ["signal", "action", "recommendation", "call", "direction", "bias"],
  confidence: ["confidence", "conf", "probability", "score"],
  price: ["price", "lastclose", "close", "lastprice", "currentprice", "entry", "entryprice"],
  target1: ["target1", "t1", "tp1", "takeprofit1", "profittarget1", "firsttarget", "targetone"],
  target2: ["target2", "t2", "tp2", "takeprofit2", "profittarget2", "secondtarget", "targettwo"],
  stop1: ["stop1", "sl1", "stoploss1", "stoplossone", "firststop", "stop", "stoploss"],
  stop2: ["stop2", "sl2", "stoploss2", "stoplosstwo", "secondstop"],
  forecast_high: ["forecasthigh", "highforecast", "projectedhigh", "predictedhigh", "nexthigh", "nextbarhigh", "maxhigh", "high"],
  forecast_low: ["forecastlow", "lowforecast", "projectedlow", "predictedlow", "nextlow", "nextbarlow", "minlow", "low"],
  rationale: ["rationale", "reason", "reasoning", "summary", "notes", "comment"],
  forecast: ["forecast", "forecastpath", "path", "projection", "forecasts"],
  indicators: ["indicators", "indicator"],
  signals: ["signals", "signalevents", "events", "trades", "markers"],
};

// Flattens an object (and nested "levels"/"targets"/"stops" objects) into normalised keys.
function flat(x) {
  const out = {};
  const add = (o) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o)) if (!(normKey(k) in out)) out[normKey(k)] = v;
  };
  add(x);
  for (const nest of ["levels", "level", "tradelevels", "trade", "plan"]) add(out[nest]);
  // Arrays like "targets": [t1, t2] and "stops": [s1, s2]
  for (const [name, a, b] of [["targets", "target1", "target2"], ["stops", "stop1", "stop2"], ["stoplosses", "stop1", "stop2"]]) {
    const arr = out[name];
    if (Array.isArray(arr)) {
      if (!(a in out)) out[a] = arr[0];
      if (!(b in out)) out[b] = arr[1];
    }
  }
  return out;
}
const pick = (f, field) => {
  for (const a of FIELD_ALIASES[field]) if (f[a] !== undefined && f[a] !== null && typeof f[a] !== "object") return f[a];
  return null;
};
const pickObj = (f, field) => {
  for (const a of FIELD_ALIASES[field]) if (Array.isArray(f[a])) return f[a];
  return null;
};

// Finds the per-timeframe objects wherever Stocky put them.
function findTimeframes(raw) {
  const found = {};
  const take = (k, v) => {
    const key = tfKeyOf(k);
    if (key && v && typeof v === "object" && !Array.isArray(v) && !found[key]) found[key] = v;
  };
  const scan = (container) => {
    if (Array.isArray(container)) {
      for (const item of container) {
        if (!item || typeof item !== "object") continue;
        const k = item.timeframe ?? item.tf ?? item.interval ?? item.period ?? item.name ?? item.key;
        if (k != null) take(k, item);
      }
    } else if (container && typeof container === "object") {
      for (const [k, v] of Object.entries(container)) take(k, v);
    }
  };
  for (const name of ["timeframes", "time_frames", "timeFrames", "results", "data", "analysis", "levels", "frames"]) scan(raw?.[name]);
  if (!Object.keys(found).length) scan(raw); // timeframe keys at the top level
  return found;
}

// Normalises Stocky's results (file, reply or VERDICT_JSON). Always returns an object.
export function cleanAnalysis(raw) {
  if (!raw || typeof raw !== "object") return { indicators_used: [], timeframes: {} };
  const tfsIn = findTimeframes(raw);
  const timeframes = {};
  for (const key of TF_KEYS) {
    const x = tfsIn[key];
    if (!x) continue;
    const f = flat(x);
    const signalRaw = String(pick(f, "signal") ?? "").toUpperCase();
    const signal = /STRONG\s*BUY|^BUY|LONG|BULL/.test(signalRaw) ? "BUY" : /STRONG\s*SELL|^SELL|SHORT|BEAR/.test(signalRaw) ? "SELL" : /HOLD|NEUTRAL|WAIT/.test(signalRaw) ? "HOLD" : null;
    const inds = pickObj(f, "indicators") ?? [];
    timeframes[key] = {
      signal,
      confidence: num(pick(f, "confidence")),
      price: num(pick(f, "price")),
      target1: num(pick(f, "target1")),
      target2: num(pick(f, "target2")),
      stop1: num(pick(f, "stop1")),
      stop2: num(pick(f, "stop2")),
      forecast_high: num(pick(f, "forecast_high")),
      forecast_low: num(pick(f, "forecast_low")),
      rationale: String(pick(f, "rationale") ?? "").slice(0, 600),
      forecast: cleanForecast(pickObj(f, "forecast")),
      indicators: inds.slice(0, 10).map(cleanIndicator),
      signals: cleanSignals(pickObj(f, "signals")),
    };
  }
  const used = raw.indicators_used ?? raw.indicatorsUsed ?? raw.indicators;
  return {
    indicators_used: Array.isArray(used) ? used.map((u) => (typeof u === "string" ? u : u?.name)).filter(Boolean).map(String).slice(0, 8) : [],
    indicator_note: typeof raw.indicator_note === "string" ? raw.indicator_note.slice(0, 400) : "",
    timeframes,
  };
}

// JSON.parse that forgives what models commonly get wrong: code fences, text
// around the object, NaN/Infinity, trailing commas. Returns null if hopeless.
export function parseLooseJson(text) {
  if (typeof text !== "string") return null;
  let t = text.replace(/^﻿/, "").trim();
  t = t.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "");
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  t = t.slice(first, last + 1);
  try {
    return JSON.parse(t);
  } catch {
    /* repair below */
  }
  const repaired = t
    .replace(/([:\[,]\s*)-?(NaN|Infinity)\b/g, "$1null")
    .replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

// Pulls a results object out of Stocky's written reply: the marked block, or
// any ```json fence that contains timeframes.
export function resultsFromText(text) {
  if (!text) return null;
  const candidates = [];
  const m = text.match(/<<<STOCKYPOWER_JSON([\s\S]*?)STOCKYPOWER_JSON>>>/);
  if (m) candidates.push(m[1]);
  for (const f of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(f[1]);
  for (const c of candidates) {
    const obj = parseLooseJson(c);
    if (obj && Object.keys(cleanAnalysis(obj).timeframes).length) return obj;
  }
  return null;
}

// ── Accuracy checks ──────────────────────────────────────────────────────────

const fmt = (v) => (v === null || v === undefined ? "?" : Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2));

// Checks one timeframe's levels against the real last close and ATR.
// Returns { ok, issues: [string], lastClose, atr, rr }.
export function validateLevels(a, bars, tfKey) {
  const issues = [];
  const last = bars?.length ? bars[bars.length - 1].c : null;
  const A = atr(bars);
  const stale = staleWarning(tfKey, bars);
  if (!a) return { ok: false, issues: [stale, "Stocky returned no levels for this timeframe."].filter(Boolean), lastClose: last, atr: A, rr: null };
  if (stale) issues.push(stale);
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
