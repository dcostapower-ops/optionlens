// Massive (formerly Polygon.io) Options Advanced REST client.

const PAGE_LIMIT = 250;
const MAX_PAGES = 40;

async function getJson(url, apiKey) {
  const u = new URL(url);
  u.searchParams.set('apiKey', apiKey);
  const r = await fetch(u, { headers: { 'User-Agent': 'OptionLens-NakedPicks/1.0' } });
  if (!r.ok) throw new Error(`Massive ${r.status} for ${u.pathname}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Every contract of `underlying` expiring on/after `minExpiry`, optionally
// limited to strikes within ±strikeRange of spot to keep page counts down.
export async function fetchChain(env, underlying, minExpiry, strikeRange) {
  const base = env.MASSIVE_REST_URL || 'https://api.massive.com';
  const path = `${base}/v3/snapshot/options/${encodeURIComponent(underlying)}`;
  const params = new URLSearchParams({ 'expiration_date.gte': minExpiry, limit: String(PAGE_LIMIT) });

  if (strikeRange > 0) {
    const probe = await getJson(`${path}?expiration_date.gte=${minExpiry}&limit=1`, env.MASSIVE_API_KEY);
    const spot = probe.results?.[0]?.underlying_asset?.price;
    if (spot > 0) {
      params.set('strike_price.gte', (spot * (1 - strikeRange)).toFixed(2));
      params.set('strike_price.lte', (spot * (1 + strikeRange)).toFixed(2));
    }
  }

  const results = [];
  let next = `${path}?${params}`;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const j = await getJson(next, env.MASSIVE_API_KEY);
    results.push(...(j.results ?? []));
    next = j.next_url;
  }
  return results;
}
