// PicksHub — one Durable Object instance ("global") that:
//   * runs the selection funnel on each 5-minute cron tick,
//   * keeps one upstream WebSocket to Massive's real-time options feed,
//     subscribed to quotes for every contract on the dashboard,
//   * pushes snapshots and live bid/ask updates to every browser client.

import { DurableObject } from 'cloudflare:workers';
import { loadConfig } from './config.js';
import { fetchChain } from './massive.js';
import { addDays, marketStatus } from './market-hours.js';
import { normaliseContract, selectForUnderlying } from './selector.js';

const HEALTH_ALARM_MS = 60_000;
const QUOTE_FLUSH_MS = 1_000;
const ROW_FIELDS = [
  'symbol', 'expiry', 'dte', 'strike', 'bid', 'ask', 'iv', 'delta', 'volume',
  'openInterest', 'liquidity', 'annualYield', 'spreadPct', 'deltaInBand', 'rank', 'highlight',
];

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

const pick = row => Object.fromEntries(ROW_FIELDS.map(k => [k, row[k]]));

export class PicksHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.latest = null;
    this.upstream = null;
    this.subscribed = new Set();
    this.authed = false;
    this.pendingQuotes = new Map();
    this.flushTimer = null;
    this.refreshing = null;
    ctx.blockConcurrencyWhile(async () => {
      this.latest = (await ctx.storage.get('latest')) ?? null;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: 'snapshot', data: this.latest, market: marketStatus() }));
      if (marketStatus().open) this.ensureUpstream();
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/picks') return Response.json({ data: this.latest, market: marketStatus() });
    if (url.pathname === '/refresh') {
      const data = await this.refresh({ force: url.searchParams.get('force') === '1' });
      return Response.json({ ok: true, generatedAt: data?.generatedAt ?? null, skipped: !data });
    }
    return new Response('Not found', { status: 404 });
  }

  // ── Selection run (rules 1 + 2) ───────────────────────────────────────────
  async refresh({ force = false } = {}) {
    const market = marketStatus();
    if (!market.open && !force) {
      this.closeUpstream();
      return null;
    }
    // Coalesce overlapping triggers (cron + manual) into one run.
    this.refreshing ??= this.runSelection(market).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async runSelection(market) {
    const cfg = loadConfig(this.env);
    const triggerDate = market.date;
    const minExpiry = addDays(triggerDate, cfg.selector.minDte);

    const stocks = await mapLimit(cfg.universe, cfg.concurrency, async underlying => {
      try {
        const raw = await fetchChain(this.env, underlying, minExpiry, cfg.strikeRange);
        const contracts = raw.map(r => normaliseContract(r, triggerDate)).filter(Boolean);
        const { calls, puts } = selectForUnderlying(contracts, cfg.selector);
        return {
          underlying,
          spot: contracts.find(c => c.spot)?.spot ?? null,
          contractsScanned: contracts.length,
          calls: calls.map(pick),
          puts: puts.map(pick),
        };
      } catch (e) {
        console.error(`[naked-picks] ${underlying}:`, e.message);
        return { underlying, error: e.message, calls: [], puts: [] };
      }
    });

    this.latest = {
      generatedAt: new Date().toISOString(),
      triggerDate,
      minExpiry,
      rules: { ...cfg.selector, strikeRange: cfg.strikeRange },
      stocks,
    };
    await this.ctx.storage.put('latest', this.latest);
    this.broadcast({ type: 'snapshot', data: this.latest, market });

    if (market.open) {
      this.ensureUpstream();
      this.syncSubscriptions();
      await this.ctx.storage.setAlarm(Date.now() + HEALTH_ALARM_MS);
    }
    return this.latest;
  }

  // Keeps the upstream feed alive between cron ticks; stops after the close.
  async alarm() {
    if (!marketStatus().open) {
      this.closeUpstream();
      return;
    }
    this.ensureUpstream();
    await this.ctx.storage.setAlarm(Date.now() + HEALTH_ALARM_MS);
  }

  // ── Upstream: Massive real-time options WebSocket ─────────────────────────
  dashboardSymbols() {
    const set = new Set();
    for (const s of this.latest?.stocks ?? []) {
      for (const r of [...s.calls, ...s.puts]) set.add(r.symbol);
    }
    return set;
  }

  async ensureUpstream() {
    if (this.upstream || !this.env.MASSIVE_API_KEY) return;
    const wsUrl = (this.env.MASSIVE_WS_URL || 'wss://socket.massive.com/options').replace(/^wss:/, 'https:');
    this.upstream = 'connecting';
    try {
      const resp = await fetch(wsUrl, { headers: { Upgrade: 'websocket' } });
      const ws = resp.webSocket;
      if (!ws) throw new Error(`upgrade refused (${resp.status})`);
      ws.accept();
      this.upstream = ws;
      this.subscribed = new Set();
      this.authed = false;
      const reset = () => { if (this.upstream === ws) this.closeUpstream(); };
      ws.addEventListener('message', ev => this.onUpstreamMessage(ev.data));
      ws.addEventListener('close', reset);
      ws.addEventListener('error', reset);
      ws.send(JSON.stringify({ action: 'auth', params: this.env.MASSIVE_API_KEY }));
    } catch (e) {
      console.error('[naked-picks] upstream connect failed:', e.message);
      this.upstream = null;
    }
  }

  closeUpstream() {
    if (this.upstream && this.upstream !== 'connecting') {
      try { this.upstream.close(1000, 'market closed'); } catch {}
    }
    this.upstream = null;
    this.subscribed = new Set();
    this.authed = false;
  }

  syncSubscriptions() {
    const ws = this.upstream;
    if (!ws || ws === 'connecting' || !this.authed) return;
    const want = this.dashboardSymbols();
    const add = [...want].filter(s => !this.subscribed.has(s));
    const drop = [...this.subscribed].filter(s => !want.has(s));
    if (drop.length) ws.send(JSON.stringify({ action: 'unsubscribe', params: drop.map(s => `Q.${s}`).join(',') }));
    if (add.length) ws.send(JSON.stringify({ action: 'subscribe', params: add.map(s => `Q.${s}`).join(',') }));
    this.subscribed = want;
  }

  onUpstreamMessage(data) {
    let events;
    try { events = JSON.parse(data); } catch { return; }
    for (const ev of Array.isArray(events) ? events : [events]) {
      if (ev.ev === 'status') {
        if (ev.status === 'auth_success') { this.authed = true; this.syncSubscriptions(); }
        if (ev.status === 'auth_failed') console.error('[naked-picks] Massive auth failed:', ev.message);
        continue;
      }
      if (ev.ev === 'Q') this.pendingQuotes.set(ev.sym, { symbol: ev.sym, bid: ev.bp, ask: ev.ap, t: ev.t });
    }
    if (this.pendingQuotes.size && !this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushQuotes(), QUOTE_FLUSH_MS);
    }
  }

  // Applies buffered quotes to the stored picks and pushes them as one batch.
  flushQuotes() {
    this.flushTimer = null;
    const quotes = [...this.pendingQuotes.values()];
    this.pendingQuotes.clear();
    if (!quotes.length || !this.latest) return;
    const bySym = new Map(quotes.map(q => [q.symbol, q]));
    for (const s of this.latest.stocks) {
      for (const r of [...s.calls, ...s.puts]) {
        const q = bySym.get(r.symbol);
        if (q) { r.bid = q.bid; r.ask = q.ask; r.quoteTime = q.t; }
      }
    }
    this.broadcast({ type: 'quotes', quotes });
  }

  // ── Browser clients (hibernatable WebSockets) ─────────────────────────────
  broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); } catch {}
    }
  }

  webSocketMessage(ws, message) {
    if (message === 'ping') ws.send('pong');
  }

  webSocketClose(ws, code) {
    try { ws.close(code, 'bye'); } catch {}
  }
}
