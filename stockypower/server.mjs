// Stockypower — enter a symbol, get a BUY / SELL call from the Stocky agent.
//
// The browser never talks to Anthropic directly: this server holds the API key,
// opens a Managed Agents session against Stocky for each symbol, and relays
// Stocky's progress back to the page as Server-Sent Events.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic, { toFile } from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env if present (Node 20.12+ / 22).
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch {
  /* no .env — rely on the real environment */
}

const PORT = Number(process.env.PORT || 8790);
const AGENT_ID = process.env.STOCKY_AGENT_ID || "agent_01Vs8LnyLYVarn95Uhjm4saV";
const ENVIRONMENT_ID = process.env.STOCKY_ENVIRONMENT_ID || "env_01DjvqsavJUkxFrZeHNnMHMU";
const VAULT_ID = process.env.STOCKY_VAULT_ID || ""; // set by scripts/connect-massive.mjs
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY || ""; // used here only for the backup snapshot
const MASSIVE_BASE = process.env.MASSIVE_BASE_URL || "https://api.massive.com";
const HISTORY_YEARS = Number(process.env.STOCKY_HISTORY_YEARS || 2);
const PUBLIC_DIR = path.join(__dirname, "public");

// Resolves ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile).
// ANTHROPIC_BASE_URL is honoured too, which is how the local mock test works.
const client = new Anthropic();

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

// ── Massive data snapshot ────────────────────────────────────────────────────

const ymd = (d) => d.toISOString().slice(0, 10);

// Adjusted daily bars for the last HISTORY_YEARS years, as CSV.
async function fetchMassiveSnapshot(symbol) {
  const to = new Date();
  const from = new Date(to);
  from.setFullYear(from.getFullYear() - HISTORY_YEARS);
  const url =
    `${MASSIVE_BASE}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${ymd(from)}/${ymd(to)}` +
    `?adjusted=true&sort=asc&limit=50000`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${MASSIVE_API_KEY}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 401 || r.status === 403) throw new Error(`Massive rejected the API key (HTTP ${r.status})`);
  if (!r.ok) throw new Error(`Massive HTTP ${r.status}`);
  const body = await r.json();
  const bars = body.results ?? [];
  if (!bars.length) return null;
  const lines = ["date,open,high,low,close,volume,vwap,trades"];
  for (const b of bars) {
    lines.push([ymd(new Date(b.t)), b.o, b.h, b.l, b.c, b.v, b.vw ?? "", b.n ?? ""].join(","));
  }
  return {
    csv: lines.join("\n") + "\n",
    rows: bars.length,
    from: ymd(new Date(bars[0].t)),
    to: ymd(new Date(bars[bars.length - 1].t)),
    path: `/workspace/data/${symbol}_daily.csv`,
  };
}

// ── Prompt ──────────────────────────────────────────────────────────────────

function buildPrompt(symbol, snapshot) {
  const data = [];
  if (VAULT_ID) {
    data.push(
      `Market data: you have the Massive (formerly Polygon.io) stocks developer feed at ${MASSIVE_BASE}.`,
      `Your key is in the MASSIVE_API_KEY environment variable. Send it as a header and never in the URL, e.g.`,
      `  curl -s -H "Authorization: Bearer $MASSIVE_API_KEY" "${MASSIVE_BASE}/v2/aggs/ticker/${symbol}/range/1/day/<from>/<to>?adjusted=true&sort=asc&limit=50000"`,
      `Use it to pull or refresh ${symbol}'s history, including the latest bar, before you compute indicators.`,
    );
  }
  if (snapshot) {
    data.push(
      `${data.length ? "As a backup, a" : "A"} snapshot of ${symbol}'s adjusted daily bars from Massive (${snapshot.rows} rows, ${snapshot.from} to ${snapshot.to}) is mounted at ${snapshot.path}`,
      `(CSV columns: date,open,high,low,close,volume,vwap,trades).`,
    );
  }
  return [
    `Analyze the stock ${symbol}.`,
    ``,
    ...(data.length ? [...data, ``] : []),
    `Use your historical data for ${symbol} and the technical indicators you were programmed to use.`,
    `Based on those indicators, tell me whether I should BUY or SELL ${symbol} right now.`,
    ``,
    `Briefly walk through each indicator's current reading, then give your call.`,
    `Finish your reply with exactly one line in this format (compact JSON, no code fence):`,
    `VERDICT_JSON: {"symbol":"${symbol}","signal":"BUY or SELL","confidence":0-100,"price":last close or null,"as_of":"YYYY-MM-DD of the latest bar","summary":"one or two sentences","indicators":[{"name":"...","value":"...","reading":"bullish|bearish|neutral"}]}`,
  ].join("\n");
}

// Pull the structured verdict out of Stocky's reply. Falls back to scanning
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
      if (["BUY", "SELL", "HOLD"].includes(signal)) {
        return {
          symbol: v.symbol || symbol,
          signal,
          confidence: Number.isFinite(Number(v.confidence)) ? Number(v.confidence) : null,
          price: v.price ?? null,
          as_of: v.as_of ?? null,
          summary: v.summary ?? "",
          indicators: Array.isArray(v.indicators) ? v.indicators : [],
          structured: true,
        };
      }
    } catch {
      /* fall through to heuristic */
    }
  }
  const m = text.match(/\b(STRONG\s+)?(BUY|SELL|HOLD)\b(?![\s\S]*\b(BUY|SELL|HOLD)\b)/i);
  if (!m) return null;
  return {
    symbol,
    signal: m[2].toUpperCase(),
    confidence: null,
    price: null,
    as_of: null,
    summary: "",
    indicators: [],
    structured: false,
  };
}

// ── Stocky session ─────────────────────────────────────────────────────────

async function analyze(symbol, send, isClosed) {
  // Backup: fetch daily bars from Massive here and mount them in Stocky's sandbox.
  let snapshot = null;
  let uploadedFileId = null;
  if (MASSIVE_API_KEY) {
    try {
      send("status", { message: `Pulling ${symbol} history from Massive…` });
      snapshot = await fetchMassiveSnapshot(symbol);
      if (snapshot) {
        const uploaded = await client.files.upload({
          file: await toFile(Buffer.from(snapshot.csv), `${symbol}_daily.csv`, { type: "text/csv" }),
        });
        uploadedFileId = uploaded.id;
      } else {
        send("status", { message: `Massive returned no bars for ${symbol}; Stocky will use its own data.` });
      }
    } catch (err) {
      console.error(`[massive ${symbol}]`, err);
      send("status", { message: `Couldn't pull Massive data here (${err.message}); Stocky will use its own data.` });
      snapshot = null;
    }
  }

  send("status", { message: `Starting a Stocky session for ${symbol}…` });
  let session;
  try {
    session = await client.beta.sessions.create({
      agent: AGENT_ID,
      environment_id: ENVIRONMENT_ID,
      title: `Stockypower: ${symbol}`,
      ...(VAULT_ID ? { vault_ids: [VAULT_ID] } : {}),
      ...(uploadedFileId ? { resources: [{ type: "file", file_id: uploadedFileId, mount_path: snapshot.path }] } : {}),
    });
  } finally {
    // The session gets its own copy of the file, so the upload can go.
    if (uploadedFileId) client.files.delete(uploadedFileId).catch(() => {});
  }
  send("session", { id: session.id });
  send("status", {
    message: VAULT_ID
      ? "Stocky has live access to the Massive feed for this session."
      : snapshot
        ? "Stocky has a Massive data snapshot (no live access: run npm run connect-massive)."
        : "Massive isn't set up; Stocky will use its own data.",
  });

  // Stream-first: open the stream before sending the message so no early event is missed.
  const stream = await client.beta.sessions.events.stream(session.id);
  await client.beta.sessions.events.send(session.id, {
    events: [{ type: "user.message", content: [{ type: "text", text: buildPrompt(symbol, snapshot) }] }],
  });
  send("status", { message: `Stocky is checking ${symbol}'s history and indicators…` });

  let fullText = "";
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
          return finalize();
        }

        case "session.status_terminated":
          return finalize();
      }
    }
  } finally {
    stream.controller?.abort?.();
  }

  if (!isClosed()) finalize();

  function finalize() {
    const verdict = parseVerdict(fullText, symbol);
    send("verdict", { verdict, text: fullText, sessionId: session.id });
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
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key. Check ANTHROPIC_API_KEY in stockypower/.env.";
  if (err instanceof Anthropic.NotFoundError) return "Stocky's agent or environment ID was not found. Check STOCKY_AGENT_ID / STOCKY_ENVIRONMENT_ID.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key cannot use the Stocky agent (wrong workspace?).";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by Anthropic — wait a moment and try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Anthropic API.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error (${err.status ?? "?"}): ${err.message}`;
  return err?.message || String(err);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

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
      agentId: AGENT_ID,
      environmentId: ENVIRONMENT_ID,
      massiveLive: Boolean(VAULT_ID),
      massiveSnapshot: Boolean(MASSIVE_API_KEY),
    });
  }

  if (req.method === "GET") return serveStatic(req, res);
  json(res, 405, { error: "Method not allowed" });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => {
    console.log(`Stockypower running at http://localhost:${PORT}`);
    console.log(`  Stocky agent:  ${AGENT_ID}`);
    console.log(`  Environment:   ${ENVIRONMENT_ID}`);
    console.log(`  Massive live:  ${VAULT_ID ? `yes (vault ${VAULT_ID})` : "no - run npm run connect-massive"}`);
    console.log(`  Massive snapshot: ${MASSIVE_API_KEY ? "yes" : "no - set MASSIVE_API_KEY"}`);
  });
}
