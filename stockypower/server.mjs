// Stockypower — enter a symbol, get a BUY / SELL call from the Stocky agent.
//
// The browser never talks to Anthropic directly: this server holds the API key,
// opens a Managed Agents session against Stocky for each symbol, and relays
// Stocky's progress back to the page as Server-Sent Events.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { loadEnv, makeClient } from "./scripts/load-env.mjs";
import {
  TIMEFRAMES,
  TF_KEYS,
  fetchTimeframes,
  refreshTimeframes,
  atr,
  cleanAnalysis,
  validateLevels,
  trackStore,
  trackRecord,
  staleWarning,
  parseLooseJson,
  resultsFromText,
} from "./lib/market.mjs";
import { computeIndicators, SETTINGS as IND_SETTINGS } from "./lib/indicators.mjs";
import { evaluateCall, summarize, breakdown, RESOLVE_BARS } from "./lib/history.mjs";
import { fetchChain, fetchDaily, normalizeContract, pickBest, realizedVol, regularSessionOpen, nyDate, fetchOfficialClose, DEFAULTS as OPTION_DEFAULTS } from "./lib/options.mjs";
import { selfCheck } from "./lib/selfcheck.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env. Its values win over variables already set in the OS.
loadEnv();

const PORT = Number(process.env.PORT || 8790);
const APP_VERSION = 8; // bump when the page and server must match (page checks it)
// Set APP_PASSWORD to require a password (needed before putting Stockypower on the web).
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const APP_USER = process.env.APP_USER || "stocky";
const AGENT_ID = process.env.STOCKY_AGENT_ID || "agent_01Vs8LnyLYVarn95Uhjm4saV";
const ENVIRONMENT_ID = process.env.STOCKY_ENVIRONMENT_ID || "env_01DjvqsavJUkxFrZeHNnMHMU";
const VAULT_ID = process.env.STOCKY_VAULT_ID || ""; // set by scripts/connect-massive.mjs
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY || ""; // candles for the chart and for Stocky
const MASSIVE_BASE = process.env.MASSIVE_BASE_URL || "https://api.massive.com";
const PUBLIC_DIR = path.join(__dirname, "public");
const OUTPUT_DIR = "/mnt/session/outputs"; // files saved here can be downloaded after the session
const DATA_DIR = path.join(__dirname, "data"); // local track record of past calls

// Resolves ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile).
// ANTHROPIC_BASE_URL is honoured too, which is how the local mock test works.
const client = await makeClient();

const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

// Tool calls Stocky paused on, waiting for the user to click Allow / Deny.
// key: `${sessionId}:${toolUseId}`
const pendingConfirmations = new Map();

// Resolves "allow" / "deny" when the user clicks a button (POST /api/confirm).
// Denies if nobody answers within 5 minutes or the page is closed.
function waitForConfirmation(key, isClosed) {
  return new Promise((resolve) => {
    const poll = setInterval(() => isClosed() && finish("deny"), 1000);
    const timeout = setTimeout(() => finish("deny"), 5 * 60 * 1000);
    function finish(result) {
      clearInterval(poll);
      clearTimeout(timeout);
      pendingConfirmations.delete(key);
      resolve(result);
    }
    pendingConfirmations.set(key, finish);
  });
}

// ── Market data (all timeframes) ─────────────────────────────────────────────

const RESULT_FILE = "stockypower.json";
// Intraday bars use regular trading hours (TradingView's default) unless STOCKY_EXTENDED_HOURS=1.
const EXTENDED_HOURS = /^(1|true|yes)$/i.test(process.env.STOCKY_EXTENDED_HOURS || "");
// Live chart updates: how often the page refreshes (0 = off) and the data delay of the
// Massive plan (Stocks Developer = 15 minutes; 0 for a real-time plan).
const LIVE_SECONDS = Math.max(0, Number(process.env.STOCKY_LIVE_SECONDS ?? 60));
const DATA_DELAY_MINUTES = Math.max(0, Number(process.env.MASSIVE_DELAY_MINUTES ?? 15));
// Best Option Chains: refresh interval (seconds) against the real-time options feed; 0 = off.
const OPTIONS_REFRESH_SECONDS = Math.max(0, Number(process.env.OPTIONS_REFRESH_SECONDS ?? 60));
// Best Option Chains starts a Stocky run itself when Stocky's analysis is missing or old
// (OPTIONS_AUTO_STOCKY=0 turns this off). At most this many run at once.
const OPTIONS_AUTO_STOCKY = !/^(0|false|no|off)$/i.test(process.env.OPTIONS_AUTO_STOCKY || "");
const AUTO_STOCKY_PARALLEL = Math.max(1, Number(process.env.OPTIONS_AUTO_STOCKY_PARALLEL ?? 2));

// The two indicators the user configured Stocky with, exactly as set in their
// TradingView layout (inputs listed in TradingView's order).
const STRATEGY = [
  `STRATEGY - use these two indicators JOINTLY, with exactly these TradingView settings (inputs in TradingView's order):`,
  `- "Smoothed HA" (smoothed Heikin-Ashi): 12, Exponential, 6, 0.85, 3, Exponential, 6, 0.85.`,
  `- "Ultra RSI [DW]": Source close, Sampling Period 12, Filter Type EMA, RSI Type Standard, Volume Type Default,`,
  `  Overbought 75, Oversold 25 (the ALMA, KAMA and Laguerre inputs don't apply with these choices).`,
  `  It shows green crests and red troughs around its centre line (50).`,
  `To save you time, my app has ALREADY calculated both indicators with these settings and added them to every data file:`,
  `  ha_open, ha_high, ha_low, ha_close = Smoothed HA (EMA 12 of OHLC -> Heikin-Ashi -> double-smoothing EMA 3),`,
  `  ultra_rsi = Ultra RSI [DW] (standard RSI of close, gains/losses averaged with EMA 12, no volume weighting).`,
  `Use these columns rather than recalculating, so your decisions match the chart exactly.`,
  `BUY or SELL for a timeframe must come from both indicators read together; state the joint rule you applied in the rationale.`,
];
const UPLOAD_ROOT = "/mnt/session/uploads/data";

// Candles for every timeframe from Massive. Missing timeframes are skipped, not fatal.
async function fetchAllCandles(symbol, send) {
  const { candles, errors, raw } = await fetchTimeframes({ base: MASSIVE_BASE, apiKey: MASSIVE_API_KEY, symbol, extendedHours: EXTENDED_HOURS });
  if (errors.length) send("status", { message: `Some Massive data couldn't be loaded (${errors.join("; ")}).` });
  liveData.set(symbol, { raw, at: Date.now() });
  return candles;
}

// ── Best Option Chains ──────────────────────────────────────────────────────

const optionsCache = new Map(); // key -> { at, result }, kept 5 minutes

// Scan settings from a request body (shared by the scan and the self-check).
function optionParams(body) {
  const minDays = Math.max(1, Number(body.minDays) || OPTION_DEFAULTS.minDays);
  const maxDays = Number(body.maxDays) > 0 ? Math.max(minDays, Number(body.maxDays)) : null;
  const touch = Number(body.minTouchPct);
  const minTouchProb = Number.isFinite(touch) && touch >= 0 && touch <= 100 ? touch / 100 : OPTION_DEFAULTS.minTouchProb;
  const oi = Number(body.minOpenInterest);
  const minOpenInterest = Number.isFinite(oi) && oi >= 0 ? Math.round(oi) : OPTION_DEFAULTS.minOpenInterest;
  const strikePref = ["balanced", "otm", "itm"].includes(body.strikePref) ? body.strikePref : "balanced";
  const horizon = body.horizon === "short" ? "short" : "30d";
  const autoStocky = body.autoStocky !== false;
  return { minDays, maxDays, minTouchProb, minOpenInterest, strikePref, horizon, autoStocky };
}

async function bestOptions(symbols, { minDays, maxDays, minTouchProb, minOpenInterest, strikePref, horizon, autoStocky = true, refresh }) {
  const key = `${symbols.join(",")}|${minDays}|${maxDays ?? ""}|${minTouchProb}|${minOpenInterest}|${strikePref}|${horizon}`;
  const hit = optionsCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < 5 * 60_000) return { ...hit.result, stockyRuns: stockyRunStatus(symbols), cached: true };

  const contracts = [];
  const hv = {};
  const underlying = {};
  const errors = [];
  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const [chain, daily] = await Promise.all([
          fetchChain({ base: MASSIVE_BASE, apiKey: MASSIVE_API_KEY, symbol, minDays }),
          fetchDaily({ base: MASSIVE_BASE, apiKey: MASSIVE_API_KEY, symbol }),
        ]);
        // 30-day and 1-year realised volatility; each option is judged against the mix
        // that matches its time to expiry.
        hv[symbol] = { short: realizedVol(daily, 30), long: realizedVol(daily, Math.min(252, daily.length - 1)) };
        const lastClose = daily.at(-1)?.c ?? null;
        // Outside the regular session option quotes are frozen at the close, so price the
        // options against the official close, not an after-hours / pre-market stock trade.
        // MARKET_SESSION=open|closed overrides the clock (testing aid).
        const marketOpen = process.env.MARKET_SESSION === "open" ? true : process.env.MARKET_SESSION === "closed" ? false : regularSessionOpen();
        const livePrice = Number(chain.find((x) => Number(x?.underlying_asset?.price) > 0)?.underlying_asset?.price) || null;
        let closeUsed = null, official = null;
        if (!marketOpen && daily.length) {
          official = await fetchOfficialClose({ base: MASSIVE_BASE, apiKey: MASSIVE_API_KEY, symbol, date: nyDate(daily.at(-1).t) });
          closeUsed = official?.close ?? lastClose;
        }
        for (const x of chain) {
          const c = normalizeContract(x, lastClose, closeUsed);
          if (c) contracts.push({ ...c, underlying: c.underlying || symbol });
        }
        underlying[symbol] = {
          price: closeUsed ?? livePrice ?? lastClose,
          marketOpen,
          closeDate: official?.date ?? (closeUsed ? nyDate(daily.at(-1).t) : null),
          extendedPrice: !marketOpen && livePrice && closeUsed && Math.abs(livePrice - closeUsed) > 1e-6 ? livePrice : null,
          hv: hv[symbol].short,
          hvLong: hv[symbol].long,
          contracts: chain.length,
          lastSession: daily.length ? nyDate(daily.at(-1).t) : null,
        };
      } catch (err) {
        errors.push(`${symbol}: ${err.message}`);
      }
    }),
  );
  const stocky = latestStockyViews(symbols);
  // Stocky's analysis missing or old? Start a run in the background; the next refresh uses it.
  // Fresh = for the 5-session horizon, a 1-day run on the latest trading day's data;
  // for 30 days, any run in the last 7 days.
  for (const sym of Object.keys(underlying)) {
    const v = stocky[sym];
    const fresh = horizon === "short"
      ? Boolean(v?.d1 && v.d1AsOfT && underlying[sym].lastSession && nyDate(v.d1AsOfT) >= underlying[sym].lastSession)
      : Boolean(v?.at);
    underlying[sym].stockyFresh = fresh;
    if (!fresh && autoStocky) requestStockyRun(sym);
  }
  const picked = pickBest(contracts, { hv, stocky, minDays, maxDays, minTouchProb, minOpenInterest, strikePref, horizon });
  for (const sym of Object.keys(underlying)) underlying[sym].stocky = stocky[sym] ?? null;
  const result = { ...picked, underlying, errors, symbols, minDays, at: Date.now(), stockyRuns: stockyRunStatus(symbols), autoStocky: autoStocky && OPTIONS_AUTO_STOCKY };
  optionsCache.set(key, { at: Date.now(), result });
  return result;
}

// ── Stocky runs started by Best Option Chains ───────────────────────────────

const autoRuns = new Map(); // symbol -> { state: queued|running|done|failed, ... }
const autoQueue = [];
let autoActive = 0;

function requestStockyRun(symbol) {
  if (!OPTIONS_AUTO_STOCKY) return;
  const r = autoRuns.get(symbol);
  if (r && (r.state === "queued" || r.state === "running")) return;
  // Don't hammer Stocky: wait 30 minutes after a failure, 2 hours after a run that
  // finished but still didn't give a usable 1-day call.
  if (r?.state === "failed" && Date.now() - r.finishedAt < 30 * 60_000) return;
  if (r?.state === "done" && Date.now() - r.finishedAt < 2 * 60 * 60_000) return;
  autoRuns.set(symbol, { state: "queued", queuedAt: Date.now() });
  autoQueue.push(symbol);
  pumpStockyRuns();
}

function pumpStockyRuns() {
  while (autoActive < AUTO_STOCKY_PARALLEL && autoQueue.length) {
    const symbol = autoQueue.shift();
    const entry = autoRuns.get(symbol);
    Object.assign(entry, { state: "running", startedAt: Date.now() });
    autoActive++;
    console.log(`[auto ${symbol}] Best Option Chains started a Stocky run (no current analysis)`);
    const recorded = [];
    const deadline = Date.now() + 20 * 60_000;
    const send = (event, data) => {
      if (["candles", "session", "verdict"].includes(event)) recorded.push([event, data]);
      if (event === "status") entry.message = data.message;
    };
    analyze(symbol, send, () => Date.now() > deadline, { background: true })
      .then(() => {
        const verdict = recorded.find(([e]) => e === "verdict")?.[1];
        if (verdict && Object.keys(verdict.analysis?.timeframes ?? {}).length) {
          entry.state = "done";
          // The Analyze page can show this run instantly too.
          if (CACHE_MS > 0) cache.set(symbol, { at: Date.now(), events: recorded });
        } else Object.assign(entry, { state: "failed", error: Date.now() > deadline ? "Stocky took longer than 20 minutes" : "Stocky's results didn't come through" });
      })
      .catch((err) => {
        console.error(`[auto ${symbol}]`, err);
        Object.assign(entry, { state: "failed", error: describeError(err) });
      })
      .finally(() => {
        entry.finishedAt = Date.now();
        autoActive--;
        // Rescan with the new analysis on the next request.
        for (const k of optionsCache.keys()) if (k.split("|")[0].split(",").includes(symbol)) optionsCache.delete(k);
        console.log(`[auto ${symbol}] Stocky run ${entry.state}${entry.error ? `: ${entry.error}` : ""}`);
        pumpStockyRuns();
      });
  }
}

function stockyRunStatus(symbols) {
  const out = {};
  for (const sym of symbols) {
    const r = autoRuns.get(sym);
    if (r) out[sym] = { state: r.state, queuedAt: r.queuedAt, startedAt: r.startedAt ?? null, finishedAt: r.finishedAt ?? null, message: r.message ?? null, error: r.error ?? null };
  }
  return out;
}

// Stocky's latest daily and weekly call per symbol, from saved runs in the last 7 days.
function latestStockyViews(symbols) {
  const cutoff = Date.now() - 7 * 864e5;
  const out = {};
  for (const r of trackStore(DATA_DIR).loadAll()) {
    if (!symbols.includes(r.symbol) || !["1D", "1W"].includes(r.tf)) continue;
    const t = Date.parse(r.created);
    if (!(t >= cutoff)) continue;
    const v = (out[r.symbol] ??= { d1: null, w1: null, d1At: 0, w1At: 0 });
    const k = r.tf === "1D" ? "d1" : "w1";
    if (t > v[`${k}At`]) Object.assign(v, { [k]: r.signal, [`${k}At`]: t, ...(k === "d1" ? { d1Target1: r.target1, d1Target2: r.target2, d1Entry: r.entry, d1AsOfT: r.asOfT, d1Forecast: Array.isArray(r.forecast) ? r.forecast : null } : {}) });
  }
  for (const v of Object.values(out)) v.at = Math.max(v.d1At, v.w1At);
  return out;
}

// ── History: grade every saved call against the bars that came after it ──────

// Candles for a symbol, reusing recent live data (at most 2 minutes old).
async function candlesFor(symbol) {
  const prev = liveData.get(symbol);
  if (prev && Date.now() - prev.at < 120_000) {
    const { candles } = await refreshTimeframes({ base: MASSIVE_BASE, apiKey: MASSIVE_API_KEY, symbol, raw: prev.raw, extendedHours: EXTENDED_HOURS }).catch(() => ({ candles: null }));
    if (candles) return candles;
  }
  return (await liveUpdate(symbol)).candles;
}

async function evaluatedCalls({ symbol, tf } = {}) {
  let calls = trackStore(DATA_DIR).loadAll();
  if (symbol) calls = calls.filter((c) => c.symbol === String(symbol).toUpperCase());
  if (tf) calls = calls.filter((c) => c.tf === tf);
  if (!calls.length || !MASSIVE_API_KEY) return calls.map((c) => ({ ...c, outcome: { status: "unknown" } }));
  const symbols = [...new Set(calls.map((c) => c.symbol))];
  const candles = {};
  // A few symbols at a time, to be gentle with Massive.
  for (let i = 0; i < symbols.length; i += 4) {
    await Promise.all(
      symbols.slice(i, i + 4).map(async (s) => {
        try {
          candles[s] = await candlesFor(s);
        } catch (err) {
          console.error(`[history ${s}]`, err?.message || err);
        }
      }),
    );
  }
  return calls.map((c) => {
    const bars = candles[c.symbol]?.[c.tf];
    return { ...c, outcome: bars?.length ? evaluateCall(c, bars) : { status: "unknown" } };
  });
}

async function historyReport(filter) {
  const calls = await evaluatedCalls(filter);
  const graded = calls.filter((c) => c.outcome.status !== "unknown");
  return {
    calls: calls.sort((a, b) => String(b.created).localeCompare(String(a.created))).slice(0, 1000),
    stats: {
      overall: summarize(graded),
      byTf: breakdown(graded, (c) => c.tf),
      bySymbol: breakdown(graded, (c) => c.symbol),
      byChecks: breakdown(graded, (c) => (c.checksPassed ? "passed" : "failed")),
    },
    symbols: [...new Set(trackStore(DATA_DIR).loadAll().map((c) => c.symbol))].sort(),
    resolveBars: RESOLVE_BARS,
  };
}

// One call with the candles around it, for its chart.
async function historyCall(id) {
  const call = trackStore(DATA_DIR).loadAll().find((c) => c.id === id);
  if (!call) return null;
  const all = (await candlesFor(call.symbol))?.[call.tf] ?? [];
  const i = all.findIndex((b) => b.t > call.asOfT);
  const at = i === -1 ? all.length : i;
  const bars = all.slice(Math.max(0, at - 80), at + RESOLVE_BARS + 20);
  const calc = computeIndicators(all);
  const keep = new Set(bars.map((b) => b.t));
  return {
    call: { ...call, outcome: evaluateCall(call, all) },
    bars,
    calc: { ha: calc.ha.filter((p) => keep.has(p.t)), ursi: calc.ursi.filter((p) => keep.has(p.t)) },
    resolveBars: RESOLVE_BARS,
  };
}

// Raw Massive bars per symbol, so live updates only fetch the newest bars.
const liveData = new Map();
const liveBusy = new Map(); // symbol -> in-flight refresh promise (shared by all open pages)

// Newest candles + indicators for a symbol (no Stocky involved).
async function liveUpdate(symbol) {
  if (liveBusy.has(symbol)) return liveBusy.get(symbol);
  const job = (async () => {
    const prev = liveData.get(symbol);
    const result = prev
      ? await refreshTimeframes({ base: MASSIVE_BASE, apiKey: MASSIVE_API_KEY, symbol, raw: prev.raw, extendedHours: EXTENDED_HOURS })
      : await fetchTimeframes({ base: MASSIVE_BASE, apiKey: MASSIVE_API_KEY, symbol, extendedHours: EXTENDED_HOURS });
    liveData.set(symbol, { raw: result.raw, at: Date.now() });
    const calc = {};
    for (const [k, bars] of Object.entries(result.candles)) calc[k] = computeIndicators(bars);
    return { candles: result.candles, calc, errors: result.errors, at: Date.now() };
  })();
  liveBusy.set(symbol, job);
  try {
    return await job;
  } finally {
    liveBusy.delete(symbol);
  }
}

// Candles plus the app-calculated indicator columns, one CSV per timeframe.
function candlesWithIndicatorsCsv(bars, calc) {
  const ha = new Map((calc?.ha ?? []).map((p) => [p.t, p]));
  const rsi = new Map((calc?.ursi ?? []).map((p) => [p.t, p.v]));
  const r4 = (v) => (v === undefined || v === null ? "" : Math.round(v * 1e4) / 1e4);
  const lines = ["t,datetime_utc,open,high,low,close,volume,ha_open,ha_high,ha_low,ha_close,ultra_rsi"];
  for (const b of bars) {
    const h = ha.get(b.t);
    lines.push([b.t, new Date(b.t * 1000).toISOString(), b.o, b.h, b.l, b.c, b.v, r4(h?.o), r4(h?.h), r4(h?.l), r4(h?.c), r4(rsi.get(b.t))].join(","));
  }
  return lines.join("\n") + "\n";
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const f2 = (v) => (v === null || v === undefined ? "n/a" : Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));

function buildPrompt(symbol, candles, mounted) {
  const lines = [
    `Analyze the stock ${symbol} on six timeframes: ${TIMEFRAMES.map((t) => t.label).join(", ")}.`,
    `You make the decisions and calculate the levels; my app draws all the charts, so don't make images or chart data.`,
    ``,
  ];

  if (Object.keys(mounted).length) {
    lines.push(
      `DATA - one CSV per timeframe: the exact Massive bars my app charts, so your numbers must line up with them.`,
      `Mounted under ${UPLOAD_ROOT}/ (if not, run: find / -name "${symbol}_*.csv" 2>/dev/null).`,
      `Columns: t,datetime_utc,open,high,low,close,volume,ha_open,ha_high,ha_low,ha_close,ultra_rsi (t = unix seconds, bar open time).`,
      EXTENDED_HOURS
        ? `Intraday bars include pre-market and after-hours trading.`
        : `Intraday bars are regular trading hours only (09:30-16:00 New York), like TradingView: 15m bars from 09:30,` +
          ` 1h bars at 09:30, 10:30 ... 15:30, 4h bars at 09:30 and 13:30. Forecast bar times must follow that same schedule.`,
    );
    for (const tf of TIMEFRAMES) {
      const bars = candles[tf.key];
      if (!bars || !mounted[tf.key]) continue;
      const last = bars[bars.length - 1];
      const stale = staleWarning(tf.key, bars);
      lines.push(
        `- ${tf.key} (${tf.label}): ${mounted[tf.key]} - ${bars.length} bars. Latest bar ${new Date(last.t * 1000).toISOString()},` +
          ` close ${f2(last.c)}, ATR(14) ${f2(atr(bars))}.` +
          (stale ? ` WARNING: ${stale} Say so in that timeframe's rationale.` : ""),
      );
    }
    lines.push(``);
  }

  lines.push(
    ...STRATEGY,
    ``,
    `FOR EACH TIMEFRAME, using that timeframe's file:`,
    `1. Read Smoothed HA and Ultra RSI from the file and decide BUY or SELL from both together, with a confidence 0-100.`,
    `2. Calculate Target 1, Target 2, Stop loss 1 and Stop loss 2, using support/resistance and ATR.`,
    `3. Calculate the forecast high: the highest price ${symbol} is likely to reach during the NEXT bar of that timeframe`,
    `   (${TIMEFRAMES.map((t) => `${t.key}: ${t.next}`).join("; ")}), plus the forecast low for that same period.`,
    `4. Forecast the path for the next 10 bars (expected price with a low/high range).`,
    `5. List the bars (last 150) where your joint Smoothed HA + Ultra RSI rule gave a buy or sell signal.`,
    `6. Check your work before writing:`,
    `   - "price" equals the latest close in that timeframe's file.`,
    `   - BUY: stop2 < stop1 < price < target1 < target2. SELL: target2 < target1 < price < stop1 < stop2.`,
    `   - forecast_high >= price >= forecast_low, and the forecast high is realistic for one bar (compare with ATR).`,
    `   - Levels are a sensible distance from price for this timeframe (usually within a few ATRs).`,
    `   - Never invent data. If a timeframe's data is missing, leave that timeframe out.`,
    ``,
    `Write the results with your file tool to ${OUTPUT_DIR}/${RESULT_FILE} as compact JSON in exactly this shape:`,
    `{"symbol": "${symbol}", "indicators_used": ["Smoothed HA", "Ultra RSI [DW]"], "indicator_note": "optional",`,
    ` "timeframes": {"<one of ${TF_KEYS.join(", ")}>": {`,
    `   "signal": "BUY" | "SELL", "confidence": 0-100, "price": <latest close>,`,
    `   "target1": n, "target2": n, "stop1": n, "stop2": n, "forecast_high": n, "forecast_low": n,`,
    `   "rationale": "one or two sentences, including the joint rule",`,
    `   "forecast": [{"t": <unix seconds of a future bar>, "price": n, "low": n, "high": n}, ... 10 points],`,
    `   "indicators": [{"name": "Smoothed HA", "reading": "bullish" | "bearish" | "neutral"}, {"name": "Ultra RSI [DW]", "value": <latest>, "reading": "..."}],`,
    `   "signals": [{"t": <unix seconds of the bar>, "type": "BUY" | "SELL" | "STRONG BUY" | "STRONG SELL"}, ...]}}}`,
    `Do NOT include indicator series or candle data - my app already has them. Plain numbers only (no NaN).`,
    ``,
    `Then reply with a short summary across timeframes and finish with exactly one line (compact JSON, no code fence):`,
    `VERDICT_JSON: {"symbol":"${symbol}","signal":"BUY or SELL (overall)","confidence":0-100,"summary":"one or two sentences","indicators_used":["Smoothed HA","Ultra RSI [DW]"]}`,
  );
  return lines.join("\n");
}

// Pull the overall verdict out of Stocky's reply. Falls back to scanning
// the text for a BUY/SELL/HOLD word if the JSON line is missing or malformed.
export function parseVerdict(text, symbol) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i].indexOf("VERDICT_JSON:");
    if (idx === -1) continue;
    const raw = lines[i].slice(idx + "VERDICT_JSON:".length).trim().replace(/^`+|`+$/g, "");
    try {
      const v = JSON.parse(raw);
      const signal = String(v.signal || "").toUpperCase();
      return {
        symbol: v.symbol || symbol,
        signal: ["BUY", "SELL", "HOLD"].includes(signal) ? signal : null,
        confidence: Number.isFinite(Number(v.confidence)) ? Number(v.confidence) : null,
        summary: v.summary ?? "",
        indicators_used: Array.isArray(v.indicators_used) ? v.indicators_used.map(String) : [],
        timeframes: v.timeframes ?? null, // in case Stocky put the levels here instead of the file
        structured: true,
      };
    } catch {
      /* fall through to heuristic */
    }
  }
  const m = text.match(/\b(BUY|SELL|HOLD)\b(?![\s\S]*\b(BUY|SELL|HOLD)\b)/i);
  return {
    symbol,
    signal: m ? m[1].toUpperCase() : null,
    confidence: null,
    summary: "",
    indicators_used: [],
    timeframes: null,
    structured: false,
  };
}

// ── Stocky session ─────────────────────────────────────────────────────────

async function analyze(symbol, send, isClosed, { background = false } = {}) {
  let candles = {};
  if (MASSIVE_API_KEY) {
    send("status", { message: `Loading ${symbol} candles from Massive (15 min to 1 month)…` });
    candles = await fetchAllCandles(symbol, send);
  } else {
    send("status", { message: "MASSIVE_API_KEY isn't set, so the app can't load candles. Run setup.bat." });
  }
  // Send candles right away so the chart can draw while Stocky works.
  // The app calculates Smoothed HA and Ultra RSI itself (fast, and identical for chart and Stocky).
  const calc = {};
  for (const [k, bars] of Object.entries(candles)) calc[k] = computeIndicators(bars);
  send("candles", { candles, timeframes: TIMEFRAMES, calc, indicatorSettings: IND_SETTINGS });

  // Mount one CSV per timeframe in Stocky's sandbox.
  const mounted = {};
  const resources = [];
  const uploadedIds = [];
  try {
    await Promise.all(
      TIMEFRAMES.filter((tf) => candles[tf.key]).map(async (tf) => {
        const name = `${symbol}_${tf.key}.csv`;
        const up = await client.files.upload({
          file: await toFile(Buffer.from(candlesWithIndicatorsCsv(candles[tf.key], calc[tf.key])), name, { type: "text/csv" }),
        });
        uploadedIds.push(up.id);
        // The platform mounts files under /mnt/session/uploads/, so a mount_path of
        // /data/x.csv ends up at /mnt/session/uploads/data/x.csv inside the sandbox.
        mounted[tf.key] = `${UPLOAD_ROOT}/${name}`;
        resources.push({ type: "file", file_id: up.id, mount_path: `/data/${name}` });
      }),
    );
  } catch (err) {
    console.error(`[upload ${symbol}]`, err);
    send("status", { message: `Couldn't hand the candle files to Stocky (${describeError(err)}).` });
  }

  send("status", { message: `Starting a Stocky session for ${symbol}…` });
  let session;
  try {
    session = await client.beta.sessions.create({
      agent: AGENT_ID,
      environment_id: ENVIRONMENT_ID,
      title: `Stockypower: ${symbol}`,
      ...(VAULT_ID ? { vault_ids: [VAULT_ID] } : {}),
      ...(resources.length ? { resources } : {}),
    });
  } finally {
    // The session gets its own copies of the files, so the uploads can go.
    for (const id of uploadedIds) client.files.delete(id).catch(() => {});
  }
  send("session", { id: session.id });

  // Stream-first: open the stream before sending the message so no early event is missed.
  const stream = await client.beta.sessions.events.stream(session.id);
  await client.beta.sessions.events.send(session.id, {
    events: [{ type: "user.message", content: [{ type: "text", text: buildPrompt(symbol, candles, mounted) }] }],
  });
  send("status", { message: `Stocky is calculating ${symbol} on all six timeframes…` });

  let fullText = "";
  let followupSent = false;
  try {
    for await (const event of stream) {
      if (isClosed()) break;

      switch (event.type) {
        case "agent.message": {
          for (const block of event.content ?? []) {
            if (block.type === "text" && block.text) {
              fullText += (fullText && !fullText.endsWith("\n") ? "\n" : "") + block.text;
              send("text", { text: block.text });
            }
          }
          break;
        }

        case "agent.thinking":
          send("status", { message: "Stocky is thinking…" });
          break;

        case "agent.tool_use":
        case "agent.mcp_tool_use": {
          send("tool", { name: event.name, server: event.mcp_server_name ?? null });
          if (event.evaluated_permission === "ask") {
            // Stocky paused for approval. Ask the person at the keyboard; a background run
            // (started by Best Option Chains) has nobody to ask, so it declines.
            if (!background)
              send("confirm", {
                sessionId: session.id,
                toolUseId: event.id,
                name: event.name,
                input: event.input ?? null,
              });
            const result = background ? "deny" : await waitForConfirmation(`${session.id}:${event.id}`, isClosed);
            await client.beta.sessions.events.send(session.id, {
              events: [
                {
                  type: "user.tool_confirmation",
                  tool_use_id: event.id,
                  result,
                  ...(result === "deny" ? { deny_message: "The Stockypower user declined this tool call." } : {}),
                },
              ],
            });
          }
          break;
        }

        case "agent.custom_tool_use": {
          // Stockypower implements no custom tools; answer so the session doesn't hang.
          send("tool", { name: event.name, server: null });
          await client.beta.sessions.events.send(session.id, {
            events: [
              {
                type: "user.custom_tool_result",
                custom_tool_use_id: event.id,
                is_error: true,
                content: [
                  {
                    type: "text",
                    text: `The Stockypower client does not implement the custom tool "${event.name}". Continue using your own data and tools.`,
                  },
                ],
              },
            ],
          });
          break;
        }

        case "session.error":
          send("status", { message: `Stocky reported an error: ${event.error?.message ?? "unknown error"}` });
          break;

        case "session.status_idle": {
          const reason = event.stop_reason?.type;
          if (reason === "requires_action") break; // waiting on a confirmation/tool result we're handling
          if (reason === "retries_exhausted") throw new Error("Stocky's session failed after retries.");
          if (reason === "budget_reached") throw new Error("Stocky's session hit its spending budget.");
          if (await onTurnEnd()) return;
          break; // we asked Stocky a follow-up; keep listening
        }

        case "session.status_terminated":
          return await finalize(await collectResults());
      }
    }
  } finally {
    stream.controller?.abort?.();
  }

  if (!isClosed()) await finalize(await collectResults());

  // Stocky finished a turn. Returns true when we're done, false if we asked a follow-up.
  async function onTurnEnd() {
    const results = await collectResults();
    if (Object.keys(results.analysis.timeframes).length || followupSent || isClosed()) {
      await finalize(results);
      return true;
    }
    followupSent = true;
    send("status", { message: "Stocky's results didn't come through, so I'm asking Stocky to resend them…" });
    console.log(`[results ${symbol}] none found (${results.diag.join("; ")}); asking Stocky to resend`);
    await client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: followupPrompt(symbol, results.diag) }] }],
    });
    return false;
  }

  // Looks for Stocky's results: the file first, then the reply, then VERDICT_JSON.
  async function collectResults() {
    const diag = [];
    const file = await readResultFile(session.id, diag);
    const candidates = [
      ["file", file?.json],
      ["reply", resultsFromText(fullText)],
      ["verdict line", (() => { const v = parseVerdict(fullText, symbol); return v.timeframes ? { timeframes: v.timeframes } : null; })()],
    ];
    for (const [source, raw] of candidates) {
      if (!raw) continue;
      const analysis = cleanAnalysis(raw);
      if (Object.keys(analysis.timeframes).length) return { raw, analysis, source, diag, fileText: file?.text ?? null };
      diag.push(`${source} had no recognisable timeframes (top-level keys: ${Object.keys(raw).slice(0, 8).join(", ") || "none"})`);
    }
    return { raw: null, analysis: { indicators_used: [], timeframes: {} }, source: null, diag, fileText: file?.text ?? null };
  }

  async function finalize(results) {
    const verdict = parseVerdict(fullText, symbol);
    send("status", { message: "Checking Stocky's levels against Massive data…" });
    const { raw, analysis, source, diag } = results;
    if (!analysis.indicators_used.length) analysis.indicators_used = verdict.indicators_used;
    saveDebug(symbol, { session: session.id, source, diag, fileText: results.fileText, reply: fullText });

    // Accuracy checks per timeframe, against the real candles.
    const checks = {};
    for (const tf of TIMEFRAMES) {
      if (analysis.timeframes[tf.key] || candles[tf.key]) checks[tf.key] = validateLevels(analysis.timeframes[tf.key], candles[tf.key], tf.key);
    }

    // Track record: score this symbol's earlier calls, then save this one.
    const store = trackStore(DATA_DIR);
    let record = {};
    try {
      record = trackRecord(store.load(symbol), candles);
      const now = new Date().toISOString();
      const rows = [];
      for (const tf of TIMEFRAMES) {
        const a = analysis.timeframes[tf.key];
        const bars = candles[tf.key];
        if (!a || !bars?.length || !a.signal) continue;
        rows.push({
          id: `${session.id}:${tf.key}`,
          symbol,
          tf: tf.key,
          created: now,
          session: session.id,
          asOfT: bars[bars.length - 1].t,
          entry: bars[bars.length - 1].c,
          signal: a.signal,
          confidence: a.confidence,
          overall: verdict.signal ?? null,
          target1: a.target1,
          target2: a.target2,
          stop1: a.stop1,
          stop2: a.stop2,
          forecast_high: a.forecast_high,
          forecast_low: a.forecast_low,
          forecast: (a.forecast || []).map((f) => ({ t: f.t, price: f.price, low: f.low, high: f.high })),
          rationale: a.rationale || "",
          checksPassed: checks[tf.key]?.ok ?? false,
          checkIssues: checks[tf.key]?.issues ?? [],
        });
      }
      if (rows.length) store.save(rows);
    } catch (err) {
      console.error(`[track ${symbol}]`, err);
    }

    if (!overallSignal(verdict)) verdict.signal = analysis.timeframes["1D"]?.signal ?? verdict.signal;
    send("verdict", {
      verdict,
      text: fullText,
      sessionId: session.id,
      analysis,
      checks,
      record,
      hasResultFile: Boolean(raw),
      resultSource: source,
      diagnostics: raw ? [] : diag,
    });
  }
}

const overallSignal = (v) => v && ["BUY", "SELL", "HOLD"].includes(v.signal);

// ── Stocky's results file ────────────────────────────────────────────────────

// Downloads Stocky's results file from the session's outputs, if it's there.
// Returns { json, text, filename } or null; notes what happened in diag.
async function readResultFile(sessionId, diag = []) {
  // Output files appear in the listing a little while after the turn ends.
  let seen = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const files = [];
      for await (const f of client.beta.files.list({ scope_id: sessionId, betas: ["managed-agents-2026-04-01"] })) files.push(f);
      seen = files.map((f) => f.filename);
      const jsons = files
        .filter((f) => /\.json$/i.test(f.filename || "") || /json/i.test(f.mime_type || ""))
        .sort((x, y) => {
          const pri = (f) => ((f.filename || "").toLowerCase() === RESULT_FILE ? 0 : /stockypower/i.test(f.filename) ? 1 : 2);
          return pri(x) - pri(y) || String(y.created_at).localeCompare(String(x.created_at));
        });
      for (const f of jsons) {
        const r = await client.beta.files.download(f.id, { betas: ["managed-agents-2026-04-01"] });
        const text = await r.text();
        const json = parseLooseJson(text);
        if (json) {
          console.log(`[results ${sessionId}] read ${f.filename} (${text.length} bytes)`);
          return { json, text, filename: f.filename };
        }
        diag.push(`${f.filename} is not valid JSON`);
      }
    } catch (err) {
      console.error(`[results ${sessionId}] listing/downloading outputs failed:`, err?.message || err);
      if (attempt === 7) diag.push(`couldn't list or download the session's files (${describeError(err)})`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  diag.push(seen.length ? `the session's output files were: ${seen.join(", ")}` : "the session listed no output files");
  console.log(`[results ${sessionId}] no results file; files seen: ${seen.join(", ") || "none"}`);
  return null;
}

// Follow-up when the results didn't arrive: ask for them in the reply, too.
function followupPrompt(symbol, diag) {
  return [
    `My app couldn't read your per-timeframe results (${diag.join("; ") || "no results found"}).`,
    `Please send them again in BOTH ways:`,
    `1. Write the JSON to ${OUTPUT_DIR}/${RESULT_FILE} (overwrite it).`,
    `2. Also paste the same JSON in your reply, between a line containing only <<<STOCKYPOWER_JSON and a line containing only STOCKYPOWER_JSON>>>.`,
    `Use exactly the shape from my first message, with timeframe keys ${TF_KEYS.join(", ")}.`,
    `To keep the reply short you may limit each indicator "series" to the last 100 bars. Plain numbers only (no NaN).`,
    `Then end with the VERDICT_JSON line again.`,
  ].join("\n");
}

// Keeps the last run's raw output per symbol in data/, to see what Stocky sent if something's off.
function saveDebug(symbol, info) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, `last-run-${symbol}.json`), JSON.stringify({ at: new Date().toISOString(), ...info }, null, 2));
  } catch (err) {
    console.error(`[debug ${symbol}]`, err?.message || err);
  }
}

// ── HTTP ───────────────────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 10_000) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { error: "Forbidden" });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: "Not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

function describeError(err) {
  if (err instanceof Anthropic.APIError && /usage limit/i.test(err.message))
    return "Your Anthropic account reached its monthly spend limit, so Stocky can't run. Raise it at https://platform.claude.com under Settings -> Limits (and check the workspace's own limit), or wait until it resets.";
  if (err instanceof Anthropic.APIError && /credit balance/i.test(err.message))
    return "Your Anthropic account is out of credit. Add credit at https://platform.claude.com under Settings -> Billing.";
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key. Check ANTHROPIC_API_KEY in stockypower/.env.";
  if (err instanceof Anthropic.NotFoundError) return "Stocky's agent or environment ID was not found. Check STOCKY_AGENT_ID / STOCKY_ENVIRONMENT_ID.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key cannot use the Stocky agent (wrong workspace?).";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by Anthropic — wait a moment and try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Anthropic API.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error (${err.status ?? "?"}): ${err.message}`;
  return err?.message || String(err);
}

// Recent results per symbol, replayed instantly (STOCKY_CACHE_MINUTES, default 10; 0 = off).
const CACHE_MS = Math.max(0, Number(process.env.STOCKY_CACHE_MINUTES ?? 10)) * 60_000;
const cache = new Map();

// HTTP Basic auth when APP_PASSWORD is set. Constant-time compare.
function authorized(req) {
  if (!APP_PASSWORD) return true;
  const m = /^Basic (.+)$/i.exec(req.headers.authorization || "");
  if (!m) return false;
  const given = Buffer.from(Buffer.from(m[1], "base64").toString("utf8"));
  const want = Buffer.from(`${APP_USER}:${APP_PASSWORD}`);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  // A newer Stockypower starting on this PC asks this (older) one to step aside.
  if (req.method === "POST" && url.pathname === "/api/takeover") {
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
    const newer = Number(req.headers["x-stockypower-takeover"]);
    if (!local || !Number.isFinite(newer) || newer < APP_VERSION) return json(res, 403, { error: "Not allowed" });
    json(res, 200, { ok: true, version: APP_VERSION });
    console.log(`\nA newer Stockypower (version ${newer}) is starting, so this window is closing.`);
    setTimeout(() => process.exit(0), 300);
    return;
  }
  if (!authorized(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Stockypower", charset="UTF-8"', "Content-Type": "text/plain" });
    return res.end("Password required.");
  }

  if (req.method === "POST" && url.pathname === "/api/analyze") {
    let symbol, refresh;
    try {
      const body = await readJson(req);
      symbol = String(body.symbol || "").trim().toUpperCase().replace(/^\$/, "");
      refresh = Boolean(body.refresh);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    if (!SYMBOL_RE.test(symbol)) return json(res, 400, { error: "Enter a valid ticker symbol, e.g. AAPL or BRK.B" });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let closed = false;
    res.on("close", () => (closed = true));
    const send = (event, data) => {
      if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => !closed && res.write(": ping\n\n"), 15_000);

    // Recent result for this symbol? Show it instantly instead of a new Stocky run.
    const hit = cache.get(symbol);
    if (!refresh && hit && Date.now() - hit.at < CACHE_MS) {
      send("cached", { at: hit.at, minutes: Math.round((Date.now() - hit.at) / 60000) });
      for (const [event, data] of hit.events) send(event, data);
      clearInterval(heartbeat);
      send("done", {});
      return res.end();
    }

    // Record what we send so a good result can be replayed later.
    const recorded = [];
    const sendAndRecord = (event, data) => {
      if (["candles", "session", "verdict"].includes(event)) recorded.push([event, data]);
      send(event, data);
    };

    try {
      await analyze(symbol, sendAndRecord, () => closed);
      const verdict = recorded.find(([e]) => e === "verdict")?.[1];
      if (CACHE_MS > 0 && verdict && Object.keys(verdict.analysis?.timeframes ?? {}).length) {
        cache.set(symbol, { at: Date.now(), events: recorded });
      }
    } catch (err) {
      console.error(`[analyze ${symbol}]`, err);
      send("error", { message: describeError(err) });
    } finally {
      clearInterval(heartbeat);
      send("done", {});
      res.end();
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/confirm") {
    try {
      const { sessionId, toolUseId, result } = await readJson(req);
      const resolve = pendingConfirmations.get(`${sessionId}:${toolUseId}`);
      if (!resolve) return json(res, 404, { error: "No pending confirmation" });
      resolve(result === "allow" ? "allow" : "deny");
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/options/selfcheck") {
    try {
      const body = await readJson(req);
      const symbols = [...new Set(String(body.symbols || "").toUpperCase().split(/[\s,;]+/).filter(Boolean))];
      if (!symbols.length || symbols.length > 10 || symbols.some((s) => !SYMBOL_RE.test(s))) return json(res, 400, { error: "Enter 1-10 valid symbols." });
      if (!MASSIVE_API_KEY) return json(res, 400, { error: "MASSIVE_API_KEY isn't set." });
      const params = optionParams(body);
      // A fresh scan, then check it against Massive and independent recomputation.
      const result = await bestOptions(symbols, { ...params, refresh: true });
      const report = await selfCheck({ base: MASSIVE_BASE, apiKey: MASSIVE_API_KEY, result });
      return json(res, 200, {
        version: APP_VERSION,
        symbols,
        settings: { minDays: params.minDays, maxDays: params.maxDays, minTouchPct: Math.round(params.minTouchProb * 100), minOpenInterest: params.minOpenInterest, strikePref: result.settings.strikePrefLabel, horizon: params.horizon === "short" ? "next 5 sessions (Stocky's target)" : "next 30 days (typical move)" },
        result,
        report,
      });
    } catch (err) {
      console.error("[selfcheck]", err);
      return json(res, 502, { error: err?.message || String(err) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/options") {
    try {
      const body = await readJson(req);
      const symbols = [...new Set(String(body.symbols || "").toUpperCase().split(/[\s,;]+/).filter(Boolean))];
      if (!symbols.length) return json(res, 400, { error: "Enter at least one symbol." });
      if (symbols.length > 10) return json(res, 400, { error: "Up to 10 symbols at a time." });
      const bad = symbols.find((s) => !SYMBOL_RE.test(s));
      if (bad) return json(res, 400, { error: `"${bad}" isn't a valid symbol.` });
      if (!MASSIVE_API_KEY) return json(res, 400, { error: "MASSIVE_API_KEY isn't set." });
      return json(res, 200, await bestOptions(symbols, { ...optionParams(body), refresh: Boolean(body.refresh) }));
    } catch (err) {
      console.error("[options]", err);
      return json(res, 502, { error: err?.message || String(err) });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/history") {
    try {
      return json(res, 200, await historyReport({ symbol: url.searchParams.get("symbol"), tf: url.searchParams.get("tf") }));
    } catch (err) {
      console.error("[history]", err);
      return json(res, 502, { error: err?.message || String(err) });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/history/call") {
    try {
      const detail = await historyCall(url.searchParams.get("id"));
      return detail ? json(res, 200, detail) : json(res, 404, { error: "Call not found" });
    } catch (err) {
      return json(res, 502, { error: err?.message || String(err) });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/live") {
    const symbol = String(url.searchParams.get("symbol") || "").toUpperCase();
    if (!SYMBOL_RE.test(symbol)) return json(res, 400, { error: "Bad symbol" });
    if (!MASSIVE_API_KEY) return json(res, 400, { error: "MASSIVE_API_KEY isn't set" });
    try {
      return json(res, 200, { ...(await liveUpdate(symbol)), delayMinutes: DATA_DELAY_MINUTES });
    } catch (err) {
      return json(res, 502, { error: err?.message || String(err) });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, 200, {
      version: APP_VERSION,
      liveSeconds: LIVE_SECONDS,
      delayMinutes: DATA_DELAY_MINUTES,
      optionsSeconds: OPTIONS_REFRESH_SECONDS,
      agentId: AGENT_ID,
      environmentId: ENVIRONMENT_ID,
      massiveLive: Boolean(VAULT_ID),
      massiveCandles: Boolean(MASSIVE_API_KEY),
    });
  }

  if (req.method === "GET") return serveStatic(req, res);
  json(res, 405, { error: "Method not allowed" });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let attempts = 0;
  server.on("error", async (err) => {
    if (err.code !== "EADDRINUSE") {
      console.error(err);
      process.exitCode = 1;
      return;
    }
    // Another Stockypower holds the port. Ask it to step aside (works with version 6+).
    if (attempts++ === 0) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/takeover`, {
          method: "POST",
          headers: { "x-stockypower-takeover": String(APP_VERSION) },
          signal: AbortSignal.timeout(3000),
        });
        if (r.ok) console.log("An older Stockypower was running; it has been asked to close. Starting this one…");
      } catch {
        /* not a Stockypower, or no answer */
      }
    }
    if (attempts <= 8) {
      setTimeout(() => server.listen(PORT), 750);
      return;
    }
    console.error(
      `\nAnother program, or an older Stockypower that can't be closed automatically, is using port ${PORT}.\n` +
        `Close every other Stockypower window (or restart your PC), then start it again.`,
    );
    process.exitCode = 1;
  });
  server.listen(PORT, () => {
    console.log(`Stockypower running at http://localhost:${PORT}`);
    console.log(`  Stocky agent:  ${AGENT_ID}`);
    console.log(`  Environment:   ${ENVIRONMENT_ID}`);
    console.log(`  Massive live:  ${VAULT_ID ? `yes (vault ${VAULT_ID})` : "no - run npm run connect-massive"}`);
    console.log(`  Massive candles: ${MASSIVE_API_KEY ? "yes" : "no - set MASSIVE_API_KEY"}`);
    console.log(`  Password:      ${APP_PASSWORD ? `on (user "${APP_USER}")` : "off (fine on your own PC; required before going on the web)"}`);
  });
}
