// OptionLens Naked Picks — Cloudflare Worker entry.
//
//   GET  /              dashboard (public/index.html)
//   GET  /ws            push feed (WebSocket) — snapshots + live quotes
//   GET  /api/picks     latest selection as JSON
//   POST /api/refresh   run the funnel now (Authorization: Bearer ADMIN_TOKEN;
//                       ?force=1 runs outside market hours)
//   cron */5            selection run, skipped outside the regular session

export { PicksHub } from './hub.js';

const hub = env => env.PICKS_HUB.get(env.PICKS_HUB.idFromName('global'));

function authorised(request, url, token) {
  if (!token) return true;
  const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return bearer === token || url.searchParams.get('token') === token;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws' || url.pathname === '/api/picks') {
      if (!authorised(request, url, env.ACCESS_TOKEN)) return new Response('Unauthorized', { status: 401 });
      return hub(env).fetch(new Request(`https://hub${url.pathname === '/ws' ? '/ws' : '/picks'}`, request));
    }

    if (url.pathname === '/api/refresh') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!env.ADMIN_TOKEN || !authorised(request, url, env.ADMIN_TOKEN)) {
        return new Response('Unauthorized', { status: 401 });
      }
      return hub(env).fetch(`https://hub/refresh?force=${url.searchParams.get('force') === '1' ? 1 : 0}`);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(hub(env).fetch('https://hub/refresh'));
  },
};
