const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,apikey,Prefer',
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function errorResp(msg, status = 400) {
  return jsonResp({ error: msg }, status);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname.startsWith('/api/polygon/')) {
      return handlePolygon(request, env, url);
    }

    if (url.pathname.startsWith('/api/db/')) {
      return handleSupabaseDB(request, env, url);
    }

    // ── URL OBFUSCATION ───────────────────────────────────────────────
    // Map obfuscated paths to actual HTML files.
    // Old paths (/dashboard, /screener, /monitor) return 404 to confuse scrapers
    // and prevent search-engine discovery.
    const path = url.pathname;
    const PATH_MAP = {
      '/v': '/v.html',
      '/s': '/s.html',
      '/m': '/m.html',
    };
    const OLD_PATHS = new Set(['/dashboard', '/screener', '/monitor']);

    // Serve the underlying HTML for obfuscated path
    if (PATH_MAP[path]) {
      // Build a URL pointing to the actual asset filename, then fetch via ASSETS binding
      const assetUrl = new URL(url);
      assetUrl.pathname = PATH_MAP[path];
      const resp = await env.ASSETS.fetch(assetUrl.toString());
      const newHeaders = new Headers(resp.headers);
      newHeaders.set('Cache-Control', 'no-store, must-revalidate, max-age=0');
      newHeaders.set('Pragma', 'no-cache');
      newHeaders.set('Expires', '0');
      newHeaders.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
      newHeaders.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: newHeaders,
      });
    }

    // 404 the old well-known paths AND the .html extensions (obfuscated and original).
    // This prevents both indexed Google links and direct .html guessing.
    const HIDDEN_HTML = new Set([
      '/dashboard.html', '/screener.html', '/monitor.html',
      '/v.html', '/s.html', '/m.html',
    ]);
    if (OLD_PATHS.has(path) || HIDDEN_HTML.has(path)) {
      return new Response(`<!DOCTYPE html>
<html><head>
<title>404 — Page not found</title>
<meta name="robots" content="noindex,nofollow">
<style>body{font-family:system-ui;background:#0a0d18;color:#e5e7eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}main{text-align:center}h1{font-size:64px;margin:0;color:#4a8cff}p{color:#9aa5b8}a{color:#4a8cff;text-decoration:none}</style>
</head><body>
<main><h1>404</h1><p>The page you requested does not exist.</p><p><a href="/">Return home</a></p></main>
</body></html>`, {
        status: 404,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Robots-Tag': 'noindex, nofollow, noarchive',
          'Cache-Control': 'no-store',
        },
      });
    }

    // For other HTML pages (homepage), force no-cache.
    const isHtml = path === '/' || path.endsWith('.html')
                   || !path.includes('.')  // extensionless paths
                   || path === '/index';

    if (isHtml) {
      const resp = await env.ASSETS.fetch(request);
      const newHeaders = new Headers(resp.headers);
      newHeaders.set('Cache-Control', 'no-store, must-revalidate, max-age=0');
      newHeaders.set('Pragma', 'no-cache');
      newHeaders.set('Expires', '0');
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: newHeaders,
      });
    }

    return env.ASSETS.fetch(request);
  },
};

async function handlePolygon(request, env, url) {
  const POLY_KEY = env.POLYGON_KEY;
  if (!POLY_KEY) return errorResp('Polygon API key not configured', 500);

  const polyPath = url.pathname.replace('/api/polygon', '');
  const polyParams = new URLSearchParams(url.search);
  polyParams.set('apiKey', POLY_KEY);
  const polyUrl = `https://api.polygon.io${polyPath}?${polyParams.toString()}`;

  try {
    const resp = await fetch(polyUrl, {
      method: request.method,
      headers: { 'User-Agent': 'StockVizor/1.0' },
    });
    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
        ...CORS_HEADERS,
      },
    });
  } catch (e) {
    return errorResp('Polygon API error: ' + e.message, 502);
  }
}

async function handleSupabaseDB(request, env, url) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_KEY = env.SUPABASE_ANON_KEY;
  if (!SUPA_URL || !SUPA_KEY) return errorResp('Supabase not configured', 500);

  const tablePath = url.pathname.replace('/api/db', '');
  const supaUrl = `${SUPA_URL}/rest/v1${tablePath}${url.search}`;

  const authHeader = request.headers.get('Authorization') || `Bearer ${SUPA_KEY}`;
  const preferHeader = request.headers.get('Prefer') || '';

  const headers = {
    'apikey': SUPA_KEY,
    'Authorization': authHeader,
    'Content-Type': 'application/json',
  };
  if (preferHeader) headers['Prefer'] = preferHeader;

  try {
    const resp = await fetch(supaUrl, {
      method: request.method,
      headers,
      body: request.method !== 'GET' ? await request.text() : undefined,
    });
    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: {
        'Content-Type': 'application/json',
        ...CORS_HEADERS,
      },
    });
  } catch (e) {
    return errorResp('Supabase error: ' + e.message, 502);
  }
}
