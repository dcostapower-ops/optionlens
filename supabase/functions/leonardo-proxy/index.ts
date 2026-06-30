// StockVizor — Leonardo AI proxy
// Deploy as: leonardo-proxy (--no-verify-jwt)
//
// Thin proxy so the Cloudflare Worker can trigger Leonardo AI generation without
// needing LEONARDO_API_KEY in its own secrets. The Worker authenticates using the
// service-role key (x-sv-secret header). This function reads LEONARDO_API_KEY
// from Supabase Edge Function secrets and makes the Leonardo API calls.
//
// Actions (via ?action= query param):
//   generate  POST  — kick off image generation, returns Leonardo response
//   poll      GET   — poll a generation by ?genId=, returns Leonardo response

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-sv-secret',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ── Auth: caller must pass service-role key in x-sv-secret ────────────────
  const SUPA_SVC = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const callerSecret = req.headers.get('x-sv-secret') ?? '';
  if (!SUPA_SVC || callerSecret !== SUPA_SVC) {
    return json({ error: 'Unauthorized' }, 403);
  }

  // ── Leonardo key ──────────────────────────────────────────────────────────
  const LEO_KEY = Deno.env.get('LEONARDO_API_KEY') ?? '';
  if (!LEO_KEY) {
    return json({ error: 'LEONARDO_API_KEY not configured in Supabase secrets' }, 500);
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action'); // 'generate' | 'poll'

  // ── POST ?action=generate ─────────────────────────────────────────────────
  if (action === 'generate') {
    if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

    const leoResp = await fetch('https://cloud.leonardo.ai/api/rest/v1/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LEO_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const rawText = await leoResp.text();
    let leoData: unknown;
    try { leoData = JSON.parse(rawText); } catch { leoData = { raw: rawText.slice(0, 500) }; }
    return json(leoData, leoResp.status);
  }

  // ── GET ?action=poll&genId=... ─────────────────────────────────────────────
  if (action === 'poll') {
    const genId = url.searchParams.get('genId');
    if (!genId) return json({ error: 'genId required' }, 400);

    const leoResp = await fetch(
      `https://cloud.leonardo.ai/api/rest/v1/generations/${encodeURIComponent(genId)}`,
      { headers: { Authorization: `Bearer ${LEO_KEY}` } },
    );

    const leoData = await leoResp.json();
    return json(leoData, leoResp.status);
  }

  return json({ error: 'action must be generate or poll' }, 400);
});
