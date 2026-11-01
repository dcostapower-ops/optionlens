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
  fetchCandles,
  candlesToCsv,
  atr,
  cleanAnalysis,
  validateLevels,
  trackStore,
  trackRecord,
  staleWarning,
  parseLooseJson,
  resultsFromText,
} from "./lib/market.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env. Its values win over variables already set in the OS.
loadEnv();

const PORT = Number(process.env.PORT || 8790);
const APP_VERSION = 3; // bump when the page and server must match
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
const UPLOAD_ROOT = "/mnt/session/uploads/data";

// Candles for every timeframe from Massive. Missing timeframes are skipped, not fatal.
async function fetchAllCandles(symbol, send) {
  const candles = {};
  const errors = [];
  await Promise.all(
    TIMEFRAMES.map(async (tf) => {
      try {
        const bars = await fetchCandles({ base: MASSIVE_BASE, apiKey: MASSIVE_API_KEY, symbol, tf });
        if (bars.length) candles[tf.key] = bars;
      } catch (err) {
        errors.push(`${tf.label}: ${err.message}`);
      }
    }),
  );
  if (errors.length) send("status", { message: `Some Massive data couldn't be loaded (${errors.join("; ")}).` });
  return candles;
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const f2 = (v) => (v === null || v === undefined ? "n/a" : Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));

function buildPrompt(symbol, candles, mounted) {
  const lines = [
    `Analyze the stock ${symbol} on six timeframes: ${TIMEFRAMES.map((t) => t.label).join(", ")}.`,
    `You do the calculations; my app draws all the charts, so don't make images.`,
    ``,
  ];

  if (Object.keys(mounted).length) {
    lines.push(
      `DATA - use these files. They are the exact Massive bars my app charts, so your numbers must line up with them.`,
      `They are mounted under ${UPLOAD_ROOT}/ (if not, run: find / -name "${symbol}_*.csv" 2>/dev/null).`,
    );
    for (const tf of TIMEFRAMES) {
      const bars = candles[tf.key];
      if (!bars || !mounted[tf.key]) continue;
      const last = bars[bars.length - 1];
      const stale = staleWarning(tf.key, bars);
      lines.push(
        `- ${tf.key} (${tf.label}): ${mounted[tf.key]} - ${bars.length} bars, CSV columns t,datetime_utc,open,high,low,close,volume (t = unix seconds, bar open time).` +
          ` Latest bar ${new Date(last.t * 1000).toISOString()}, close ${f2(last.c)}, ATR(14) ${f2(atr(bars))}.` +
          (stale ? ` WARNING: ${stale} Say so in that timeframe's rationale.` : ""),
      );
    }
    lines.push(``);
  }
  if (VAULT_ID) {
    lines.push(
      `You can also call the Massive API (${MASSIVE_BASE}) with the MASSIVE_API_KEY environment variable as a header`,
      `(curl -s -H "Authorization: Bearer $MASSIVE_API_KEY" "${MASSIVE_BASE}/v2/aggs/ticker/${symbol}/range/15/minute/<from>/<to>?adjusted=true&sort=asc&limit=50000"),`,
      `but base your levels on the files above so they match the chart.`,
      ``,
    );
  }

  lines.push(
    `FOR EACH TIMEFRAME, using that timeframe's bars and the indicators you were programmed to use:`,
    `1. Compute your indicators on that timeframe's bars.`,
    `2. Decide BUY or SELL for that timeframe, with a confidence 0-100.`,
    `3. Calculate Target 1, Target 2, Stop loss 1 and Stop loss 2 from your indicators, using support/resistance and ATR.`,
    `4. Calculate the forecast high: the highest price ${symbol} is likely to reach during the NEXT bar of that timeframe`,
    `   (${TIMEFRAMES.map((t) => `${t.key}: ${t.next}`).join("; ")}), plus the forecast low for that same period.`,
    `5. Forecast the path for the next 10 bars of that timeframe (expected price with a low/high range).`,
    `6. Before writing, check your work:`,
    `   - "price" equals the latest close in that timeframe's file.`,
    `   - BUY: stop2 < stop1 < price < target1 < target2. SELL: target2 < target1 < price < stop1 < stop2.`,
    `   - forecast_high >= price >= forecast_low, and the forecast high is realistic for one bar (compare with ATR).`,
    `   - Levels are a sensible distance from price for this timeframe (usually within a few ATRs).`,
    `   - Never invent data. If a timeframe's data is missing, leave that timeframe out.`,
    ``,
    `Write the results with your file tool to ${OUTPUT_DIR}/${RESULT_FILE} as JSON in exactly this shape:`,
    `{`,
    `  "symbol": "${symbol}",`,
    `  "indicators_used": ["<indicator name>", "..."],`,
    `  "timeframes": {`,
    `    "<one of ${TF_KEYS.join(", ")}>": {`,
    `      "signal": "BUY" | "SELL", "confidence": 0-100, "price": <latest close>,`,
    `      "target1": n, "target2": n, "stop1": n, "stop2": n,`,
    `      "forecast_high": n, "forecast_low": n,`,
    `      "rationale": "one or two sentences",`,
    `      "forecast": [{"t": <unix seconds of a future bar>, "price": n, "low": n, "high": n}, ... 10 points],`,
    `      "indicators": [ <one entry per indicator; see INDICATOR FORMAT below> ],`,
    `      "signals": [{"t": <unix seconds of the bar>, "type": "BUY" | "SELL" | "STRONG BUY" | "STRONG SELL", "label": "optional short text"}, ... your strategy's signal events in the last 150 bars]`,
    `    }`,
    `  }`,
    `}`,
    ``,
    `SETTINGS - use exactly the settings you were configured with for every indicator (lengths, smoothing method and`,
    `length, source, multipliers, overbought/oversold and centre levels, colours) and your configured signal rules.`,
    `Do not substitute default values. Report the settings you used in each indicator's "settings" and "colors".`,
    ``,
    `INDICATOR FORMAT - my app draws each indicator the way you describe it, so describe it the way it should look:`,
    `{"name": "...", "pane": "price" (drawn on the price chart) | "separate" (its own panel),`,
    ` "style": "candles" | "baseline" | "histogram" | "line" | "band",`,
    ` "group": "optional - indicators with the same group share one panel (e.g. an oscillator and its signal line)",`,
    ` "base": <centre line for baseline style, e.g. 50 or 0>, "levels": [<threshold lines, e.g. 80, 20>],`,
    ` "settings": {"<setting name>": <value>, ...} exactly as configured (e.g. {"length": 14, "method": "RMA", "signal_length": 14}),`,
    ` "colors": {"bull": "#rrggbb", "bear": "#rrggbb", "bull_weak": "#rrggbb", "bear_weak": "#rrggbb", "line": "#rrggbb", "signal": "#rrggbb",`,
    `            "overbought": "#rrggbb", "oversold": "#rrggbb"} - only the ones your configuration defines,`,
    ` "color": "#rrggbb (optional)", "value": <latest value>, "reading": "bullish" | "bearish" | "neutral",`,
    ` "series": the last 150 bars, matching the bars' t values:`,
    `    line / histogram / baseline: [{"t": n, "v": n}]   candles: [{"t": n, "o": n, "h": n, "l": n, "c": n}]   band: [{"t": n, "upper": n, "lower": n, "mid": n}]}`,
    `Specifically: Smoothed Heikin-Ashi -> pane "price", style "candles" with its smoothed o/h/l/c per bar (my app shows it in place of the regular candles).`,
    `Ultra RSI -> pane "separate", style "baseline" with its centre line as "base" and its overbought/oversold lines as "levels";`,
    `put its signal line, if it has one, in the same "group" as style "line". Any channel/cloud -> style "band".`,
    ``,
    `Use plain numbers (no strings, no NaN). Include every timeframe that has data.`,
    ``,
    `Then reply with a short summary across timeframes and finish with exactly one line (compact JSON, no code fence):`,
    `VERDICT_JSON: {"symbol":"${symbol}","signal":"BUY or SELL (overall)","confidence":0-100,"summary":"one or two sentences","indicators_used":["..."]}`,
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

async function analyze(symbol, send, isClosed) {
  let candles = {};
  if (MASSIVE_API_KEY) {
    send("status", { message: `Loading ${symbol} candles from Massive (15 min to 1 month)…` });
    candles = await fetchAllCandles(symbol, send);
  } else {
    send("status", { message: "MASSIVE_API_KEY isn't set, so the app can't load candles. Run setup.bat." });
  }
  // Send candles right away so the chart can draw while Stocky works.
  send("candles", { candles, timeframes: TIMEFRAMES });

  // Mount one CSV per timeframe in Stocky's sandbox.
  const mounted = {};
  const resources = [];
  const uploadedIds = [];
  try {
    await Promise.all(
      TIMEFRAMES.filter((tf) => candles[tf.key]).map(async (tf) => {
        const name = `${symbol}_${tf.key}.csv`;
        const up = await client.files.upload({
          file: await toFile(Buffer.from(candlesToCsv(candles[tf.key])), name, { type: "text/csv" }),
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
            // Stocky paused for approval. Ask the person at the keyboard.
            send("confirm", {
              sessionId: session.id,
              toolUseId: event.id,
              name: event.name,
              input: event.input ?? null,
            });
            const result = await waitForConfirmation(`${session.id}:${event.id}`, isClosed);
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
          symbol,
          tf: tf.key,
          created: now,
          session: session.id,
          asOfT: bars[bars.length - 1].t,
          entry: bars[bars.length - 1].c,
          signal: a.signal,
          target1: a.target1,
          target2: a.target2,
          stop1: a.stop1,
          stop2: a.stop2,
          forecast_high: a.forecast_high,
          checksPassed: checks[tf.key]?.ok ?? false,
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
  if (!authorized(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Stockypower", charset="UTF-8"', "Content-Type": "text/plain" });
    return res.end("Password required.");
  }

  if (req.method === "POST" && url.pathname === "/api/analyze") {
    let symbol;
    try {
      symbol = String((await readJson(req)).symbol || "").trim().toUpperCase().replace(/^\$/, "");
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

    try {
      await analyze(symbol, send, () => closed);
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

  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, 200, {
      version: APP_VERSION,
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
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `\nStockypower is already running (port ${PORT} is in use).\n` +
          `Close every other Stockypower window, then start it again, so the newest version runs.`,
      );
    } else {
      console.error(err);
    }
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
