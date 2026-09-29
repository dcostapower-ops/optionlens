// ─────────────────────────────────────────────────────────────────────────────
// StockVizor Cloudflare Worker — RECOVERED FROM THE DEPLOYED BUNDLE
//
// Provenance: pulled from the live Worker `lingering-sun-c298` (deployed
// 2026-08-21) on 2026-09-29, because the previous src/index.js in this repo had
// drifted to 620 lines / 3 API routes while production served 4,678 lines /
// 22 API surfaces. Deploying the old file would have deleted Stripe checkout,
// the Stripe webhook, payment methods, all admin endpoints, subscriptions,
// research, strategies, the hashed page routing and the scheduled() handler.
//
// This is BUNDLER OUTPUT, not hand-authored source: it carries esbuild's
// __defProp / __name helpers and flattened module order. Edit it directly and
// keep it deployable; do not assume an un-bundled original exists.
//
// To diff against production in future: fetch the deployed bundle and compare
// from the line after this header block (everything below is byte-identical to
// what was live on 2026-08-21).
//
// KNOWN GAP — /api/polygon/* has no authentication. See docs/TECH-DEBT.md
// "Polygon proxy is unauthenticated". Do NOT copy the auth guard from the
// stockvizor-stage Worker on its own: the browser clients send no Bearer token,
// so it would 401 every chart. Both sides must change together.
// ─────────────────────────────────────────────────────────────────────────────

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var ALLOWED_ORIGINS = /* @__PURE__ */ new Set([
  "https://stockvizor.com",
  "https://stockvizor-stage.fdcosta.workers.dev",
  "http://localhost:8788"
]);
function _corsHeaders(request) {
  const origin = request?.headers?.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "https://stockvizor.com";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,apikey,Prefer",
    "Vary": "Origin"
  };
}
__name(_corsHeaders, "_corsHeaders");
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://stockvizor.com",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,apikey,Prefer",
  "Vary": "Origin"
};
function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}
__name(jsonResp, "jsonResp");
function errorResp(msg, status = 400) {
  return jsonResp({ error: msg }, status);
}
__name(errorResp, "errorResp");
var index_default = {
  // ── Scheduled auto-renewal cron (runs daily at 01:00 UTC) ──────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutoRenewal(env));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: _corsHeaders(request) });
    }
    if (url.pathname.startsWith("/api/polygon/")) {
      return handlePolygon(request, env, url);
    }
    if (url.pathname.startsWith("/api/db/")) {
      return handleSupabaseDB(request, env, url);
    }
    if (url.pathname.startsWith("/api/dashboard/")) {
      return handleDashboard(request, env, url);
    }
    if (url.pathname.startsWith("/api/screener/")) {
      return handleScreener(request, env, url, ctx);
    }
    if (url.pathname.startsWith("/api/vizardis/")) {
      return handleVizardis(request, env, url);
    }
    if (url.pathname.startsWith("/api/auth/")) {
      return handleAuth(request, env, url);
    }
    if (url.pathname === "/api/research/start-image-gen" && request.method === "POST") {
      return handleResearchStartImageGen(request, env);
    }
    if (url.pathname === "/api/research/poll-image-gen" && request.method === "GET") {
      return handleResearchPollImageGen(request, env, url);
    }
    if (url.pathname === "/api/research/store-images" && request.method === "POST") {
      return handleResearchStoreImages(request, env);
    }
    if (url.pathname.startsWith("/api/research/")) {
      return handleResearch(request, env, url);
    }
    if (url.pathname === "/api/liq-history" && request.method === "GET") {
      return handleLiqHistory(request, env, url);
    }
    if (url.pathname === "/api/run-stats" && request.method === "GET") {
      return handleRunStats(request, env, url);
    }
    if (url.pathname === "/api/subscription-tiers" && request.method === "GET") {
      return handleGetSubscriptionTiers(request, env);
    }
    if (url.pathname === "/api/checkout" && request.method === "POST") {
      return handleCheckout(request, env);
    }
    if (url.pathname === "/api/webhook/stripe" && request.method === "POST") {
      return handleStripeWebhook(request, env);
    }
    if (url.pathname === "/api/admin/subscription-pricing" && request.method === "PATCH") {
      return handleAdminUpdatePricing(request, env);
    }
    if (url.pathname === "/api/admin/payment-transactions" && request.method === "GET") {
      return handleAdminGetPaymentTransactions(request, env, url);
    }
    if (url.pathname === "/api/subscription/renew" && request.method === "DELETE") {
      return handleDisableAutoRenew(request, env);
    }
    if (url.pathname === "/api/subscription/renew" && request.method === "POST") {
      return handleRenewSubscription(request, env);
    }
    if (url.pathname === "/api/subscription/cancel" && request.method === "POST") {
      return handleCancelSubscription(request, env);
    }
    if (url.pathname === "/api/subscription/schedule-upgrade" && request.method === "POST") {
      return handleScheduleUpgrade(request, env);
    }
    if (url.pathname === "/api/subscription/schedule-upgrade" && request.method === "DELETE") {
      return handleCancelScheduledUpgrade(request, env);
    }
    if (url.pathname.startsWith("/api/strategies")) {
      return handleStrategies(request, env, url);
    }
    if (url.pathname === "/api/payment-methods" && request.method === "GET") {
      return handleGetPaymentMethods(request, env, url);
    }
    if (url.pathname === "/api/payment-methods" && request.method === "DELETE") {
      return handleRemovePaymentMethod(request, env);
    }
    if (url.pathname === "/api/payment-methods/default" && request.method === "POST") {
      return handleSetDefaultPaymentMethod(request, env);
    }
    if (url.pathname === "/api/payment-methods/setup-intent" && request.method === "POST") {
      return handleCreateSetupIntent(request, env);
    }
    if (url.pathname === "/api/payment-methods/add-card" && request.method === "POST") {
      return handleAddCardSession(request, env);
    }
    if (url.pathname === "/api/admin/currency-rates" && request.method === "GET") {
      return handleGetCurrencyRates(request, env);
    }
    if (url.pathname === "/api/admin/currency-rates" && request.method === "PATCH") {
      return handleAdminUpdateCurrencyRate(request, env);
    }
    if (url.pathname === "/api/admin/revoke-session" && request.method === "POST") {
      return handleAdminRevokeSession(request, env);
    }
    if (url.pathname === "/api/auth/clear-force-signout" && request.method === "POST") {
      return handleClearForceSignout(request, env);
    }
    if (url.pathname === "/api/subscription/auto-renew" && request.method === "PATCH") {
      return handleEnableAutoRenew(request, env);
    }
    if (url.pathname === "/api/subscription/reactivate" && request.method === "POST") {
      return handleReactivateSubscription(request, env);
    }
    if (url.pathname === "/api/admin/maintenance" && request.method === "POST") {
      return handleAdminMaintenance(request, env);
    }
    if (url.pathname === "/api/admin/user-tier" && request.method === "PATCH") {
      return handleAdminUserTier(request, env);
    }
    if (url.pathname === "/api/admin/toggle-admin" && request.method === "POST") {
      return handleAdminToggleAdmin(request, env);
    }
    if (url.pathname === "/api/admin/reactivate-user" && request.method === "POST") {
      return handleAdminReactivateUser(request, env);
    }
    if (url.pathname === "/api/user/last-transaction" && request.method === "GET") {
      return handleUserLastTransaction(request, env);
    }
    if (url.pathname === "/api/activity-log" && request.method === "POST") {
      return handleActivityLog(request, env);
    }
    if (url.pathname === "/api/vizai" && request.method === "POST") {
      return handleVizAI(request, env, ctx);
    }
    if (url.pathname === "/api/vizdetect" && request.method === "POST") {
      return handleVizDetect(request, env, ctx);
    }
    if (url.pathname === "/api/fundamentals" && request.method === "GET") {
      return handleFundamentals(request, env);
    }
    if (url.pathname === "/api/maintenance" && request.method === "POST") {
      return handleMaintenance(request, env);
    }
    const NOCACHE_SCRIPTS = /* @__PURE__ */ new Set(["/sv-header.js", "/sv-footer.js", "/auth-tier.js", "/vzd-api.js"]);
    if (NOCACHE_SCRIPTS.has(url.pathname)) {
      const assetUrl = new URL(url);
      assetUrl.search = "";
      const resp = await env.ASSETS.fetch(assetUrl.toString());
      const h = new Headers(resp.headers);
      h.set("Cache-Control", "no-store, must-revalidate, max-age=0");
      h.set("Pragma", "no-cache");
      h.set("Expires", "0");
      h.set("Content-Type", "application/javascript; charset=utf-8");
      return new Response(resp.body, { status: resp.status, headers: h });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const assetUrl = new URL(url);
      assetUrl.pathname = "/index.html";
      assetUrl.search = "";
      const resp = await env.ASSETS.fetch(assetUrl.toString());
      const h = new Headers(resp.headers);
      h.set("Cache-Control", "no-store, must-revalidate, max-age=0");
      h.set("Pragma", "no-cache");
      h.set("Expires", "0");
      h.set("Content-Type", "text/html; charset=utf-8");
      return new Response(resp.body, { status: resp.status, headers: h });
    }
    const path = url.pathname;
    const PATH_MAP = {
      "/83935753a5417982371618d9871e90e0": "/v.html",
      "/4fb03ba01df9ab119f8f03bd10369a9f": "/s.html",
      "/ab4d46ffe2f67f31cc0d61784be93395": "/m.html",
      "/a69f2b56f9fa808895417e5aa5690ba0": "/r.html",
      "/b667b3ce350b5507e504792dd2192d74": "/charts.html",
      "/1e00298aec7543f56b96ce75ee5fced1": "/backtest.html",
      "/c684717bf331a1ff15c788624db72c01": "/logout.html",
      "/9b8ad070b8dc36c69d280d5b7746aa47": "/m.html",
      "/research": "/research.html",
      "/home-preview": "/home-preview.html",
      "/maintenance": "/maintenance.html",
      "/vizardis-monitor": "/vizardis-monitor.html"
    };
    const OLD_PATHS = /* @__PURE__ */ new Set(["/dashboard", "/screener", "/monitor", "/v", "/s", "/m", "/r", "/charts"]);
    if (PATH_MAP[path]) {
      const assetUrl = new URL(url);
      assetUrl.pathname = PATH_MAP[path];
      const resp = await env.ASSETS.fetch(assetUrl.toString());
      const newHeaders = new Headers(resp.headers);
      newHeaders.set("Cache-Control", "no-store, must-revalidate, max-age=0");
      newHeaders.set("Pragma", "no-cache");
      newHeaders.set("Expires", "0");
      newHeaders.set("X-Robots-Tag", "noindex, nofollow, noarchive");
      newHeaders.set("Content-Type", "text/html; charset=utf-8");
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: newHeaders
      });
    }
    const HIDDEN_HTML = /* @__PURE__ */ new Set([
      "/dashboard.html",
      "/screener.html",
      "/monitor.html",
      "/v.html",
      "/s.html",
      "/m.html",
      "/r.html",
      "/charts.html",
      "/research.html",
      "/home-preview.html",
      "/backtest.html"
    ]);
    if (OLD_PATHS.has(path) || HIDDEN_HTML.has(path)) {
      return new Response(`<!DOCTYPE html>
<html><head>
<title>404 \u2014 Page not found</title>
<meta name="robots" content="noindex,nofollow">
<style>body{font-family:system-ui;background:#0a0d18;color:#e5e7eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}main{text-align:center}h1{font-size:64px;margin:0;color:#4a8cff}p{color:#9aa5b8}a{color:#4a8cff;text-decoration:none}</style>
</head><body>
<main><h1>404</h1><p>The page you requested does not exist.</p><p><a href="/">Return home</a></p></main>
</body></html>`, {
        status: 404,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "X-Robots-Tag": "noindex, nofollow, noarchive",
          "Cache-Control": "no-store"
        }
      });
    }
    if (!path.includes(".") && path !== "/") {
      return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    const isHtml = path === "/" || path.endsWith(".html") || path === "/index";
    const isOwnAsset = path.endsWith(".js") || path.endsWith(".css");
    if (isHtml || isOwnAsset) {
      const resp = await env.ASSETS.fetch(request);
      const newHeaders = new Headers(resp.headers);
      newHeaders.set("Cache-Control", "no-store, must-revalidate, max-age=0");
      newHeaders.set("Pragma", "no-cache");
      newHeaders.set("Expires", "0");
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: newHeaders
      });
    }
    return env.ASSETS.fetch(request);
  }
};
async function runAutoRenewal(env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  const STRIPE_KEY = env.STRIPE_SECRET_KEY;
  if (!SUPA_URL || !SUPA_SVC || !STRIPE_KEY) {
    console.error("[AutoRenew] Missing required env vars");
    return;
  }
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  console.log(`[AutoRenew] Starting run for ${today}`);
  const dueR = await fetch(
    `${SUPA_URL}/rest/v1/user_profiles?auto_renew=eq.true&renewal_due_date=lte.${today}&cancelled_at=is.null&tier_id=in.(pro,premium)&select=id,email,tier_id,stripe_customer_id,pending_tier_id,pending_duration_months,last_payment_transaction_id,renewal_due_date`,
    { headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}` } }
  );
  if (!dueR.ok) {
    console.error("[AutoRenew] Failed to query due users:", await dueR.text());
    return;
  }
  const dueUsers = await dueR.json();
  console.log(`[AutoRenew] Found ${dueUsers.length} users due for renewal`);
  for (const user of Array.isArray(dueUsers) ? dueUsers : []) {
    try {
      await _processAutoRenewal(user, env, SUPA_URL, SUPA_SVC, STRIPE_KEY);
    } catch (e) {
      console.error(`[AutoRenew] Unhandled error for user ${user.id}:`, e.message);
    }
  }
  console.log(`[AutoRenew] Cron run complete`);
}
__name(runAutoRenewal, "runAutoRenewal");
async function _processAutoRenewal(user, env, SUPA_URL, SUPA_SVC, STRIPE_KEY) {
  const uid = user.id;
  const renewTier = user.pending_tier_id || user.tier_id;
  let renewDuration = 12;
  if (user.last_payment_transaction_id) {
    const txR = await fetch(
      `${SUPA_URL}/rest/v1/payment_transactions?id=eq.${user.last_payment_transaction_id}&select=duration_months`,
      { headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}` } }
    );
    const txData = await txR.json();
    if (Array.isArray(txData) && txData[0]?.duration_months) {
      renewDuration = txData[0].duration_months;
    }
  }
  if (user.pending_duration_months) renewDuration = user.pending_duration_months;
  const priceR = await fetch(
    `${SUPA_URL}/rest/v1/subscription_tier_pricing?tier_id=eq.${renewTier}&duration_months=eq.${renewDuration}&is_active=eq.true&select=price_excl_vat,stripe_price_id`,
    { headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}` } }
  );
  const priceData = await priceR.json();
  if (!Array.isArray(priceData) || !priceData[0]?.stripe_price_id) {
    console.error(`[AutoRenew] No active price found for ${renewTier} ${renewDuration}mo (user ${uid})`);
    return;
  }
  const { price_excl_vat } = priceData[0];
  const pmR = await fetch(
    `${SUPA_URL}/rest/v1/saved_payment_methods?user_id=eq.${uid}&is_default=eq.true&select=stripe_payment_method_id&limit=1`,
    { headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}` } }
  );
  const pmData = await pmR.json();
  if (!Array.isArray(pmData) || !pmData[0]?.stripe_payment_method_id) {
    console.warn(`[AutoRenew] No default payment method for user ${uid} \u2014 skipping`);
    return;
  }
  const stripePmId = pmData[0].stripe_payment_method_id;
  if (!user.stripe_customer_id) {
    console.warn(`[AutoRenew] No Stripe customer ID for user ${uid} \u2014 skipping`);
    return;
  }
  const subscriptionStartDate = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const endDt = /* @__PURE__ */ new Date();
  endDt.setMonth(endDt.getMonth() + renewDuration);
  const subscriptionEndDate = endDt.toISOString().slice(0, 10);
  const piParams = new URLSearchParams();
  piParams.append("amount", Math.round(parseFloat(price_excl_vat) * 100).toString());
  piParams.append("currency", "usd");
  piParams.append("customer", user.stripe_customer_id);
  piParams.append("payment_method", stripePmId);
  piParams.append("confirm", "true");
  piParams.append("off_session", "true");
  piParams.append("description", `Auto-renewal: ${renewTier} ${renewDuration}mo`);
  piParams.append("metadata[user_id]", uid);
  piParams.append("metadata[tier]", renewTier);
  piParams.append("metadata[duration_months]", renewDuration.toString());
  piParams.append("metadata[auto_renewal]", "true");
  const piR = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(STRIPE_KEY + ":"), "Content-Type": "application/x-www-form-urlencoded" },
    body: piParams.toString()
  });
  const pi = await piR.json();
  if (piR.ok && pi.status === "succeeded") {
    const totalAmount = pi.amount / 100;
    const txR = await fetch(`${SUPA_URL}/rest/v1/payment_transactions`, {
      method: "POST",
      headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: uid,
        tier_id: renewTier,
        duration_months: renewDuration,
        subscription_start_date: subscriptionStartDate,
        subscription_end_date: subscriptionEndDate,
        amount_excl_vat: parseFloat(price_excl_vat),
        vat_amount: 0,
        total_amount_incl_vat: totalAmount,
        stripe_payment_method_id: stripePmId,
        transaction_status: "successful",
        stripe_payment_intent_id: pi.id,
        stripe_charge_id: typeof pi.latest_charge === "string" ? pi.latest_charge : null,
        credited_account: "stripe",
        user_subscription_status_after: renewTier
      })
    });
    const txData = txR.ok ? await txR.json() : [];
    const txId = Array.isArray(txData) && txData[0] ? txData[0].id : null;
    const profileUpdate = {
      tier_id: renewTier,
      tier_expires_at: endDt.toISOString(),
      renewal_due_date: subscriptionEndDate,
      auto_renew: true,
      cancelled_at: null
    };
    if (txId) profileUpdate.last_payment_transaction_id = txId;
    if (user.pending_tier_id) {
      profileUpdate.pending_tier_id = null;
      profileUpdate.pending_duration_months = null;
    }
    await Promise.allSettled([
      fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${uid}`, {
        method: "PATCH",
        headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(profileUpdate)
      }),
      fetch(`${SUPA_URL}/rest/v1/subscription_history`, {
        method: "POST",
        headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: uid,
          action: "auto_renew",
          tier_id: renewTier,
          amount_paid: totalAmount,
          subscription_start: subscriptionStartDate,
          subscription_end: subscriptionEndDate,
          payment_reference: pi.id,
          notes: `Auto-renewal: ${renewTier} ${renewDuration}mo \u2014 $${totalAmount}`
        })
      })
    ]);
    console.log(`[AutoRenew] OK user ${uid} \u2192 ${renewTier} ${renewDuration}mo until ${subscriptionEndDate}`);
  } else {
    const failureReason = pi.last_payment_error?.message || pi.error?.message || "Unknown failure";
    console.warn(`[AutoRenew] FAIL user ${uid}: ${failureReason}`);
    await fetch(`${SUPA_URL}/rest/v1/payment_transactions`, {
      method: "POST",
      headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: uid,
        tier_id: renewTier,
        duration_months: renewDuration,
        amount_excl_vat: parseFloat(price_excl_vat),
        vat_amount: 0,
        total_amount_incl_vat: parseFloat(price_excl_vat),
        stripe_payment_method_id: stripePmId,
        transaction_status: "failed",
        stripe_payment_intent_id: pi.id || null,
        transaction_failure_reason: failureReason,
        credited_account: "stripe",
        user_subscription_status_after: user.tier_id
      })
    }).catch(() => {
    });
  }
}
__name(_processAutoRenewal, "_processAutoRenewal");
async function handleGetSubscriptionTiers(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_KEY = env.SUPABASE_ANON_KEY;
  if (!SUPA_URL || !SUPA_KEY) {
    return errorResp("Pricing service not configured", 503);
  }
  try {
    const countryCode = request.headers.get("CF-IPCountry") || "US";
    const currency = await resolveCurrencyForCountry(SUPA_URL, SUPA_KEY, countryCode);
    const r = await fetch(`${SUPA_URL}/rest/v1/subscription_tier_pricing?select=tier_id,duration_months,price_excl_vat,stripe_price_id&is_active=eq.true&order=tier_id,duration_months`, {
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`
      }
    });
    if (!r.ok) {
      return errorResp("Failed to fetch pricing", r.status);
    }
    const pricing = await r.json();
    const tiers = {};
    pricing.forEach((p) => {
      if (!tiers[p.tier_id]) {
        tiers[p.tier_id] = { tier_id: p.tier_id, durations: [] };
      }
      const usdPrice = parseFloat(p.price_excl_vat);
      tiers[p.tier_id].durations.push({
        months: p.duration_months,
        price_excl_vat: convertPrice(usdPrice, currency.rate_vs_usd),
        price_excl_vat_usd: usdPrice,
        stripe_price_id: p.stripe_price_id
      });
    });
    const tiersList = Object.values(tiers).sort((a, b) => {
      const order = { free: 0, pro: 1, premium: 2 };
      return (order[a.tier_id] || 999) - (order[b.tier_id] || 999);
    });
    return jsonResp({
      tiers: tiersList,
      currency: currency.currency_code,
      currency_symbol: currency.currency_symbol,
      country_code: countryCode
    });
  } catch (e) {
    console.error("[Pricing]", e);
    return errorResp("Service error", 500);
  }
}
__name(handleGetSubscriptionTiers, "handleGetSubscriptionTiers");
var STRIPE_PRICE_CACHE = {};
var STRIPE_PRICE_CACHE_TIME = 0;
async function fetchSubscriptionPrice(supabaseUrl, supabaseKey, tier, durationMonths) {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/subscription_tier_pricing?select=price_excl_vat,stripe_price_id&tier_id=eq.${tier}&duration_months=eq.${durationMonths}&is_active=eq.true`, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`
      }
    });
    const data = await r.json();
    if (Array.isArray(data) && data.length > 0) {
      return data[0];
    }
  } catch (e) {
  }
  return null;
}
__name(fetchSubscriptionPrice, "fetchSubscriptionPrice");
async function handleCheckout(request, env) {
  const STRIPE_KEY = env.STRIPE_SECRET_KEY;
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_KEY = env.SUPABASE_ANON_KEY;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  const DEBUG_MODE = !STRIPE_KEY;
  if (!SUPA_URL || !SUPA_KEY) {
    return errorResp("Checkout not configured", 503);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { tier, duration_months, user_id, email } = body;
  if (!tier) return errorResp("Missing tier", 400);
  if (!duration_months || ![6, 12, 24].includes(duration_months)) {
    return errorResp("Invalid duration_months (must be 6, 12, or 24)", 400);
  }
  if (!user_id) return errorResp("Missing user_id", 400);
  const [pricing, userProfResp] = await Promise.all([
    fetchSubscriptionPrice(SUPA_URL, SUPA_KEY, tier, duration_months),
    fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${user_id}&select=stripe_customer_id`, {
      headers: { apikey: SUPA_SVC || SUPA_KEY, Authorization: `Bearer ${SUPA_SVC || SUPA_KEY}` }
    }).catch(() => null)
  ]);
  if (!pricing || !pricing.stripe_price_id) {
    return errorResp("Pricing not available for this tier/duration combination", 400);
  }
  let stripeCustomerId = null;
  if (userProfResp && userProfResp.ok) {
    const profData = await userProfResp.json().catch(() => null);
    stripeCustomerId = Array.isArray(profData) && profData[0]?.stripe_customer_id ? profData[0].stripe_customer_id : null;
  }
  const countryCode = request.headers.get("CF-IPCountry") || "US";
  const currency = await resolveCurrencyForCountry(SUPA_URL, SUPA_KEY, countryCode);
  const priceId = pricing.stripe_price_id;
  const subscriptionStartDate = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const params = new URLSearchParams();
  params.append("mode", "subscription");
  params.append("payment_method_types[0]", "card");
  params.append("line_items[0][price]", priceId);
  params.append("line_items[0][quantity]", "1");
  params.append("client_reference_id", user_id);
  params.append("success_url", `https://stockvizor.com/83935753a5417982371618d9871e90e0?payment=success&tier=${tier}&duration=${duration_months}`);
  params.append("cancel_url", "https://stockvizor.com/");
  params.append("metadata[user_id]", user_id);
  params.append("metadata[tier]", tier);
  params.append("metadata[duration_months]", duration_months.toString());
  params.append("metadata[subscription_start_date]", subscriptionStartDate);
  params.append("metadata[country_code]", countryCode);
  params.append("metadata[currency]", currency.currency_code);
  params.append("automatic_tax[enabled]", "true");
  if (stripeCustomerId) {
    params.append("customer", stripeCustomerId);
    params.append("customer_update[payment_method]", "auto");
  } else if (email) {
    params.append("customer_email", email);
  }
  const _endDt = new Date(subscriptionStartDate);
  _endDt.setMonth(_endDt.getMonth() + duration_months);
  const subscriptionEndDate = _endDt.toISOString().slice(0, 10);
  if (DEBUG_MODE) {
    return jsonResp({
      debug: true,
      message: "Stripe key not configured \u2014 showing what would be sent to Stripe",
      summary: {
        tier,
        duration_months,
        user_id,
        email: email || null,
        country_code: countryCode,
        currency: currency.currency_code,
        currency_symbol: currency.currency_symbol,
        price_excl_vat: parseFloat(pricing.price_excl_vat),
        stripe_price_id: pricing.stripe_price_id || null,
        stripe_customer_id: stripeCustomerId || null,
        subscription_start_date: subscriptionStartDate,
        subscription_end_date: subscriptionEndDate,
        automatic_tax: true,
        success_url: `https://stockvizor.com/v?payment=success&tier=${tier}&duration=${duration_months}`,
        cancel_url: "https://stockvizor.com/"
      },
      stripe_params: Object.fromEntries(params),
      // Preview of what the webhook would write to Supabase after a real payment.
      // Values marked null here are filled in by the stripe webhook handler once
      // checkout.session.completed fires.
      db_writes: {
        payment_transactions: {
          // Known now — these are set immediately from request / DB lookup
          _known: {
            user_id,
            tier_id: tier,
            duration_months,
            subscription_start_date: subscriptionStartDate,
            subscription_end_date: subscriptionEndDate,
            amount_excl_vat: parseFloat(pricing.price_excl_vat),
            transaction_status: "successful",
            credited_account: "stripe",
            user_subscription_status_after: tier
          },
          // Set by Stripe webhook — filled when checkout.session.completed fires
          _from_webhook: {
            vat_amount: null,
            total_amount_incl_vat: null,
            vat_rate: null,
            stripe_payment_intent_id: null,
            stripe_charge_id: null,
            stripe_payment_method_id: null,
            card_type: null,
            card_last_4: null,
            card_expiry_month: null,
            card_expiry_year: null,
            cardholder_name: null,
            billing_address_line1: null,
            billing_address_city: null,
            billing_address_state: null,
            billing_address_postcode: null,
            billing_address_country: null
          },
          // Always null on a successful transaction
          _always_null: {
            transaction_failure_reason: null
          }
        },
        user_profiles_update: {
          _known: {
            tier_id: tier,
            tier_expires_at: subscriptionEndDate,
            subscription_start_date: subscriptionStartDate + "  \u2190 only set on first subscription",
            renewal_due_date: subscriptionEndDate,
            trial_used: true,
            stripe_customer_id: stripeCustomerId || "\u2190 created by Stripe at checkout"
          },
          _from_webhook: {
            last_payment_transaction_id: "\u2190 new UUID from payment_transactions insert"
          }
        }
      }
    });
  }
  try {
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(STRIPE_KEY + ":"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });
    const session = await r.json();
    if (!r.ok) return errorResp("Payment service error", r.status);
    return jsonResp({
      success: true,
      url: session.url,
      session_id: session.id,
      estimated_total_incl_vat: (session.total_tax_amount || 0) / 100 + parseFloat(pricing.price_excl_vat),
      currency: currency.currency_code,
      currency_symbol: currency.currency_symbol
    });
  } catch (e) {
    console.error("[Checkout]", e);
    return errorResp("Service error", 502);
  }
}
__name(handleCheckout, "handleCheckout");
async function _verifyStripeSignature(rawBody, signatureHeader, secret) {
  try {
    const parts = {};
    signatureHeader.split(",").forEach((part) => {
      const eq = part.indexOf("=");
      if (eq > -1) parts[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    });
    const timestamp = parts["t"];
    const v1 = parts["v1"];
    if (!timestamp || !v1) return false;
    const now = Math.floor(Date.now() / 1e3);
    if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;
    const signedPayload = `${timestamp}.${rawBody}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
    const computed = Array.from(new Uint8Array(sigBytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
    return computed === v1;
  } catch {
    return false;
  }
}
__name(_verifyStripeSignature, "_verifyStripeSignature");
async function handleStripeWebhook(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  const rawBody = await request.text();
  const whSecret = env.STRIPE_WEBHOOK_SECRET;
  if (whSecret) {
    const sig = request.headers.get("Stripe-Signature") || "";
    const valid = await _verifyStripeSignature(rawBody, sig, whSecret);
    if (!valid) {
      console.warn("[Webhook] Stripe signature verification failed");
      return errorResp("Unauthorized", 401);
    }
  }
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const uid = session.metadata?.user_id || session.client_reference_id;
    const tier = session.metadata?.tier;
    const durationMonths = parseInt(session.metadata?.duration_months || "3", 10);
    const subscriptionStartDate = session.metadata?.subscription_start_date || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const amountExclVat = (session.amount_subtotal || 0) / 100;
    const vatAmount = (session.total_tax_amount || 0) / 100;
    const totalAmountInclVat = (session.amount_total || 0) / 100;
    if (!uid || !tier || !SUPA_URL || !SUPA_SVC) {
      return jsonResp({ received: true });
    }
    const startDt = new Date(subscriptionStartDate);
    const endDt = new Date(startDt);
    endDt.setMonth(endDt.getMonth() + durationMonths);
    const subscriptionEndDate = endDt.toISOString().slice(0, 10);
    const paymentIntent = session.payment_intent;
    let cardLast4 = null, cardType = null, cardExpiryMonth = null, cardExpiryYear = null;
    let cardholderName = null, billingAddress = {};
    let stripePaymentMethodId = null;
    if (paymentIntent && typeof paymentIntent === "object") {
      const charges = paymentIntent.charges?.data || [];
      if (charges.length > 0) {
        const charge = charges[0];
        if (charge.payment_method_details?.card) {
          const card = charge.payment_method_details.card;
          cardType = card.brand;
          cardLast4 = card.last4;
          cardExpiryMonth = card.exp_month;
          cardExpiryYear = card.exp_year;
        }
        if (charge.billing_details) {
          cardholderName = charge.billing_details.name;
          const addr = charge.billing_details.address || {};
          billingAddress = {
            line1: addr.line1,
            city: addr.city,
            state: addr.state,
            postal_code: addr.postal_code,
            country: addr.country
          };
        }
      }
      stripePaymentMethodId = paymentIntent.payment_method;
    }
    let vatRate = null;
    if (session.total_tax_amount && session.amount_subtotal) {
      vatRate = (session.total_tax_amount / session.amount_subtotal * 100).toFixed(2);
    }
    const paymentTransactionBody = {
      user_id: uid,
      tier_id: tier,
      duration_months: durationMonths,
      subscription_start_date: subscriptionStartDate,
      subscription_end_date: subscriptionEndDate,
      amount_excl_vat: parseFloat(amountExclVat.toFixed(2)),
      vat_amount: parseFloat(vatAmount.toFixed(2)),
      total_amount_incl_vat: parseFloat(totalAmountInclVat.toFixed(2)),
      vat_rate: vatRate,
      stripe_payment_method_id: stripePaymentMethodId,
      card_type: cardType,
      card_last_4: cardLast4,
      card_expiry_month: cardExpiryMonth,
      card_expiry_year: cardExpiryYear,
      cardholder_name: cardholderName,
      billing_address_line1: billingAddress.line1,
      billing_address_city: billingAddress.city,
      billing_address_state: billingAddress.state,
      billing_address_postcode: billingAddress.postal_code,
      billing_address_country: billingAddress.country,
      transaction_status: "successful",
      stripe_payment_intent_id: paymentIntent?.id || session.payment_intent,
      stripe_charge_id: paymentIntent?.charges?.data?.[0]?.id,
      transaction_failure_reason: null,
      credited_account: "stripe",
      user_subscription_status_after: tier
    };
    const requests = [
      // Insert payment_transactions
      fetch(`${SUPA_URL}/rest/v1/payment_transactions`, {
        method: "POST",
        headers: {
          apikey: SUPA_SVC,
          Authorization: `Bearer ${SUPA_SVC}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(paymentTransactionBody)
      }),
      // Update user_profiles
      fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${uid}`, {
        method: "PATCH",
        headers: {
          apikey: SUPA_SVC,
          Authorization: `Bearer ${SUPA_SVC}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          tier_id: tier,
          subscription_status: "active",
          subscription_start_date: subscriptionStartDate,
          tier_expires_at: endDt.toISOString(),
          auto_renew: false,
          // Default to manual renewal, user can enable in settings
          renewal_due_date: subscriptionEndDate,
          trial_used: true,
          renewal_email_sent: false,
          expiry_email_sent: false
        })
      }),
      // Keep existing subscription_history insert for audit
      fetch(`${SUPA_URL}/rest/v1/subscription_history`, {
        method: "POST",
        headers: {
          apikey: SUPA_SVC,
          Authorization: `Bearer ${SUPA_SVC}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          user_id: uid,
          action: "activate",
          tier_id: tier,
          amount_paid: totalAmountInclVat,
          subscription_start: subscriptionStartDate,
          subscription_end: subscriptionEndDate,
          payment_reference: session.payment_intent || session.id,
          notes: `Stripe checkout: ${tier} for ${durationMonths} months ($${totalAmountInclVat})`
        })
      })
    ];
    const paymentTxnResponses = await Promise.allSettled(requests);
    if (paymentTxnResponses[0].status === "fulfilled") {
      const txnResp = paymentTxnResponses[0].value;
      if (txnResp.ok) {
        const txnData = await txnResp.json();
        if (Array.isArray(txnData) && txnData.length > 0) {
          const transactionId = txnData[0].id;
          await fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${uid}`, {
            method: "PATCH",
            headers: {
              apikey: SUPA_SVC,
              Authorization: `Bearer ${SUPA_SVC}`,
              "Content-Type": "application/json",
              Prefer: "return=minimal"
            },
            body: JSON.stringify({
              last_payment_transaction_id: transactionId
            })
          }).catch(() => {
          });
        }
      }
    }
    if (stripePaymentMethodId && cardLast4) {
      await _savePaymentMethodForUser({
        supabaseUrl: SUPA_URL,
        supabaseSvc: SUPA_SVC,
        stripeKey: env.STRIPE_SECRET_KEY,
        userId: uid,
        stripePaymentMethodId,
        cardType,
        cardLast4,
        cardExpiryMonth,
        cardExpiryYear,
        cardholderName,
        billingCountry: billingAddress.country,
        stripeCustomerId: session.customer || null
      });
    }
  }
  if (event.type === "setup_intent.succeeded") {
    const si = event.data.object;
    const stripeCustomerId = si.customer;
    const stripePaymentMethodId = si.payment_method;
    if (!stripeCustomerId || !stripePaymentMethodId || !SUPA_URL || !SUPA_SVC) {
      return jsonResp({ received: true });
    }
    const profR = await fetch(
      `${SUPA_URL}/rest/v1/user_profiles?stripe_customer_id=eq.${stripeCustomerId}&select=id`,
      { headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}` } }
    ).catch(() => null);
    const profData = profR && profR.ok ? await profR.json().catch(() => null) : null;
    const userId = Array.isArray(profData) && profData[0] ? profData[0].id : null;
    if (!userId) return jsonResp({ received: true });
    let cardLast4 = null, cardType = null, cardExpiryMonth = null, cardExpiryYear = null, cardholderName = null;
    try {
      const pmR = await fetch(`https://api.stripe.com/v1/payment_methods/${stripePaymentMethodId}`, {
        headers: { Authorization: "Basic " + btoa(env.STRIPE_SECRET_KEY + ":") }
      });
      if (pmR.ok) {
        const pm = await pmR.json();
        if (pm.card) {
          cardLast4 = pm.card.last4;
          cardType = pm.card.brand;
          cardExpiryMonth = pm.card.exp_month;
          cardExpiryYear = pm.card.exp_year;
        }
        cardholderName = pm.billing_details?.name;
      }
    } catch (_) {
    }
    await _savePaymentMethodForUser({
      supabaseUrl: SUPA_URL,
      supabaseSvc: SUPA_SVC,
      stripeKey: env.STRIPE_SECRET_KEY,
      userId,
      stripePaymentMethodId,
      cardType,
      cardLast4,
      cardExpiryMonth,
      cardExpiryYear,
      cardholderName,
      billingCountry: null,
      stripeCustomerId
    });
  }
  return jsonResp({ received: true });
}
__name(handleStripeWebhook, "handleStripeWebhook");
async function _savePaymentMethodForUser({
  supabaseUrl,
  supabaseSvc,
  stripeKey,
  userId,
  stripePaymentMethodId,
  cardType,
  cardLast4,
  cardExpiryMonth,
  cardExpiryYear,
  cardholderName,
  billingCountry,
  stripeCustomerId
}) {
  if (!stripePaymentMethodId || !cardLast4) return;
  try {
    const existingR = await fetch(
      `${supabaseUrl}/rest/v1/saved_payment_methods?user_id=eq.${userId}&select=id,is_default,created_at&order=created_at.asc`,
      { headers: { apikey: supabaseSvc, Authorization: `Bearer ${supabaseSvc}` } }
    );
    const existing = existingR.ok ? await existingR.json() : [];
    const cards = Array.isArray(existing) ? existing : [];
    const dupeR = await fetch(
      `${supabaseUrl}/rest/v1/saved_payment_methods?user_id=eq.${userId}&stripe_payment_method_id=eq.${stripePaymentMethodId}&select=id`,
      { headers: { apikey: supabaseSvc, Authorization: `Bearer ${supabaseSvc}` } }
    );
    const dupes = dupeR.ok ? await dupeR.json() : [];
    if (Array.isArray(dupes) && dupes.length > 0) return;
    if (cards.length >= 3) {
      const oldest = cards.find((c) => !c.is_default) || cards[0];
      if (oldest) {
        if (stripeKey) {
          const oldPmR = await fetch(
            `${supabaseUrl}/rest/v1/saved_payment_methods?id=eq.${oldest.id}&select=stripe_payment_method_id`,
            { headers: { apikey: supabaseSvc, Authorization: `Bearer ${supabaseSvc}` } }
          );
          const oldPmData = oldPmR.ok ? await oldPmR.json() : [];
          const oldStripeId = Array.isArray(oldPmData) && oldPmData[0] ? oldPmData[0].stripe_payment_method_id : null;
          if (oldStripeId) {
            await fetch(`https://api.stripe.com/v1/payment_methods/${oldStripeId}/detach`, {
              method: "POST",
              headers: { Authorization: "Basic " + btoa(stripeKey + ":") }
            }).catch(() => {
            });
          }
        }
        await fetch(`${supabaseUrl}/rest/v1/saved_payment_methods?id=eq.${oldest.id}`, {
          method: "DELETE",
          headers: { apikey: supabaseSvc, Authorization: `Bearer ${supabaseSvc}`, Prefer: "return=minimal" }
        }).catch(() => {
        });
        cards.splice(cards.indexOf(oldest), 1);
      }
    }
    const isDefault = cards.length === 0;
    const newCard = {
      user_id: userId,
      stripe_payment_method_id: stripePaymentMethodId,
      card_type: cardType,
      card_last_4: cardLast4,
      card_expiry_month: cardExpiryMonth,
      card_expiry_year: cardExpiryYear,
      cardholder_name: cardholderName,
      billing_country: billingCountry,
      is_default: isDefault
    };
    await fetch(`${supabaseUrl}/rest/v1/saved_payment_methods`, {
      method: "POST",
      headers: {
        apikey: supabaseSvc,
        Authorization: `Bearer ${supabaseSvc}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify(newCard)
    }).catch(() => {
    });
    if (isDefault && stripeKey && stripeCustomerId) {
      const params = new URLSearchParams();
      params.append("invoice_settings[default_payment_method]", stripePaymentMethodId);
      await fetch(`https://api.stripe.com/v1/customers/${stripeCustomerId}`, {
        method: "POST",
        headers: { Authorization: "Basic " + btoa(stripeKey + ":"), "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString()
      }).catch(() => {
      });
    }
  } catch (_) {
  }
}
__name(_savePaymentMethodForUser, "_savePaymentMethodForUser");
async function _verifyAdminJwt(request, supaUrl, supaAnon, supaSvc) {
  const authHeader = request.headers.get("Authorization") || "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!jwt) return null;
  try {
    const r = await fetch(`${supaUrl}/auth/v1/user`, {
      headers: { apikey: supaAnon, Authorization: `Bearer ${jwt}` }
    });
    if (!r.ok) return null;
    const user = await r.json();
    if (!user?.id) return null;
    const rows = await supaFetch(
      supaUrl,
      supaSvc,
      "user_profiles",
      `id=eq.${user.id}&select=is_admin&limit=1`
    );
    return rows?.[0]?.is_admin ? user.id : null;
  } catch (_) {
    return null;
  }
}
__name(_verifyAdminJwt, "_verifyAdminJwt");
async function handleAdminRevokeSession(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_ANON = env.SUPABASE_ANON_KEY;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_SVC) return errorResp("Service not configured", 503);
  const adminUid = await _verifyAdminJwt(request, SUPA_URL, SUPA_ANON, SUPA_SVC);
  if (!adminUid) return errorResp("Forbidden \u2014 admin access required", 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { user_id } = body;
  if (!user_id) return errorResp("Missing user_id", 400);
  if (user_id === adminUid) return errorResp("Cannot revoke your own session", 400);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const userRows = await supaFetch(
    SUPA_URL,
    SUPA_SVC,
    "user_profiles",
    `id=eq.${user_id}&select=device_token,email&limit=1`
  );
  const oldToken = userRows?.[0]?.device_token || null;
  const userEmail = userRows?.[0]?.email || user_id;
  await Promise.all([
    // 1. Set force_signout_at + clear device_token → triggers Realtime on user's device
    fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${user_id}`, {
      method: "PATCH",
      headers: {
        apikey: SUPA_SVC,
        Authorization: `Bearer ${SUPA_SVC}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ force_signout_at: now, device_token: null, device_changed_at: now })
    }),
    // 2. Close device_history row
    oldToken ? fetch(`${SUPA_URL}/rest/v1/device_history?device_token=eq.${encodeURIComponent(oldToken)}&logged_out_at=is.null`, {
      method: "PATCH",
      headers: {
        apikey: SUPA_SVC,
        Authorization: `Bearer ${SUPA_SVC}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ logged_out_at: now, logout_reason: "admin_force" })
    }) : Promise.resolve(),
    // 3. Audit log
    fetch(`${SUPA_URL}/rest/v1/activity_log`, {
      method: "POST",
      headers: {
        apikey: SUPA_SVC,
        Authorization: `Bearer ${SUPA_SVC}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify([{
        username: userEmail,
        function: "AdminRevokeSession",
        session_id: oldToken || null
      }])
    }).catch(() => {
    })
  ]);
  return jsonResp({ ok: true, revoked_user: userEmail, had_active_session: !!oldToken });
}
__name(handleAdminRevokeSession, "handleAdminRevokeSession");
function _jwtPayload(jwt) {
  try {
    const b64 = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64 + "=".repeat((4 - b64.length % 4) % 4)));
  } catch (e) {
    return null;
  }
}
__name(_jwtPayload, "_jwtPayload");
async function handleUserLastTransaction(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_SVC) return errorResp("Service not configured", 503);
  const jwt = (request.headers.get("Authorization") || "").replace("Bearer ", "").trim();
  if (!jwt) return errorResp("Unauthorized", 401);
  const payload = _jwtPayload(jwt);
  const uid = payload?.sub;
  if (!uid) return errorResp("Unauthorized", 401);
  try {
    const select = [
      "id",
      "transaction_date",
      "tier_id",
      "duration_months",
      "subscription_start_date",
      "subscription_end_date",
      "amount_excl_vat",
      "vat_amount",
      "vat_rate",
      "total_amount_incl_vat",
      "card_type",
      "card_last_4",
      "card_expiry_month",
      "card_expiry_year",
      "cardholder_name",
      "transaction_status",
      "created_at"
    ].join(",");
    const r = await fetch(
      `${SUPA_URL}/rest/v1/payment_transactions?user_id=eq.${uid}&transaction_status=eq.successful&order=created_at.desc&limit=1&select=${select}`,
      { headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}` } }
    );
    if (!r.ok) {
      console.error("[LastTransaction] Supabase error", r.status);
      return errorResp("Service error", 502);
    }
    const rows = await r.json();
    const tx = Array.isArray(rows) && rows[0] ? rows[0] : null;
    return jsonResp({ transaction: tx });
  } catch {
    console.error("[LastTransaction] fetch error");
    return errorResp("Service error", 502);
  }
}
__name(handleUserLastTransaction, "handleUserLastTransaction");
async function handleActivityLog(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPA_URL || !SUPA_SVC) return jsonResp({ ok: false });
  const jwt = (request.headers.get("Authorization") || "").replace("Bearer ", "").trim();
  if (!jwt) return jsonResp({ ok: false });
  let body = {};
  try {
    body = await request.json();
  } catch {
  }
  const fn = body.fn || "unknown";
  const sessionId = body.session_id || null;
  const payload = _jwtPayload(jwt);
  const username = payload?.email || payload?.sub || "unknown";
  fetch(`${SUPA_URL}/rest/v1/activity_log`, {
    method: "POST",
    headers: {
      apikey: SUPA_SVC,
      Authorization: `Bearer ${SUPA_SVC}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ username, function: fn, session_id: sessionId })
  }).catch(() => {
  });
  return jsonResp({ ok: true });
}
__name(handleActivityLog, "handleActivityLog");
async function handleClearForceSignout(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_SVC) return errorResp("Service not configured", 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { uid } = body;
  if (!uid) return errorResp("Missing uid", 400);
  await fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${uid}`, {
    method: "PATCH",
    headers: {
      apikey: SUPA_SVC,
      Authorization: `Bearer ${SUPA_SVC}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ force_signout_at: null })
  }).catch(() => {
  });
  return jsonResp({ ok: true });
}
__name(handleClearForceSignout, "handleClearForceSignout");
async function handleEnableAutoRenew(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_SVC) return errorResp("Service not configured", 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { user_id } = body;
  if (!user_id) return errorResp("Missing user_id", 400);
  const r = await fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${user_id}`, {
    method: "PATCH",
    headers: {
      apikey: SUPA_SVC,
      Authorization: `Bearer ${SUPA_SVC}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ auto_renew: true })
  }).catch(() => ({ ok: false }));
  if (!r.ok) return errorResp("Failed to enable auto-renew", 500);
  await fetch(`${SUPA_URL}/rest/v1/subscription_history`, {
    method: "POST",
    headers: {
      apikey: SUPA_SVC,
      Authorization: `Bearer ${SUPA_SVC}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify([{ user_id, action: "enable_auto_renew", notes: "User enabled auto-renew" }])
  }).catch(() => {
  });
  return jsonResp({ ok: true });
}
__name(handleEnableAutoRenew, "handleEnableAutoRenew");
async function handleReactivateSubscription(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_SVC) return errorResp("Service not configured", 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { user_id } = body;
  if (!user_id) return errorResp("Missing user_id", 400);
  const r = await fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${user_id}`, {
    method: "PATCH",
    headers: {
      apikey: SUPA_SVC,
      Authorization: `Bearer ${SUPA_SVC}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ cancelled_at: null, auto_renew: true })
  }).catch(() => ({ ok: false }));
  if (!r.ok) return errorResp("Failed to reactivate", 500);
  await fetch(`${SUPA_URL}/rest/v1/subscription_history`, {
    method: "POST",
    headers: {
      apikey: SUPA_SVC,
      Authorization: `Bearer ${SUPA_SVC}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify([{ user_id, action: "reactivate", notes: "User reactivated subscription" }])
  }).catch(() => {
  });
  return jsonResp({ ok: true });
}
__name(handleReactivateSubscription, "handleReactivateSubscription");
async function handleAdminMaintenance(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_ANON = env.SUPABASE_ANON_KEY;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_SVC) return errorResp("Service not configured", 503);
  const adminUid = await _verifyAdminJwt(request, SUPA_URL, SUPA_ANON, SUPA_SVC);
  if (!adminUid) return errorResp("Forbidden \u2014 admin access required", 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { enabled } = body;
  const r = await fetch(`${SUPA_URL}/rest/v1/app_config?key=eq.maintenance_mode`, {
    method: "PATCH",
    headers: {
      apikey: SUPA_SVC,
      Authorization: `Bearer ${SUPA_SVC}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ value: enabled ? "true" : "false" })
  });
  if (!r.ok) return errorResp("Failed to update maintenance mode", r.status);
  return jsonResp({ ok: true, maintenance_mode: enabled });
}
__name(handleAdminMaintenance, "handleAdminMaintenance");
async function handleAdminUserTier(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_ANON = env.SUPABASE_ANON_KEY;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_SVC) return errorResp("Service not configured", 503);
  const adminUid = await _verifyAdminJwt(request, SUPA_URL, SUPA_ANON, SUPA_SVC);
  if (!adminUid) return errorResp("Forbidden \u2014 admin access required", 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { user_id, tier_id } = body;
  if (!user_id || !["free", "pro", "premium"].includes(tier_id)) return errorResp("Invalid user_id or tier_id", 400);
  const r = await fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${user_id}`, {
    method: "PATCH",
    headers: {
      apikey: SUPA_SVC,
      Authorization: `Bearer ${SUPA_SVC}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ tier_id })
  });
  if (!r.ok) return errorResp("Failed to update tier", r.status);
  await fetch(`${SUPA_URL}/rest/v1/subscription_history`, {
    method: "POST",
    headers: {
      apikey: SUPA_SVC,
      Authorization: `Bearer ${SUPA_SVC}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify([{ user_id, action: "admin_tier_change", tier_id, notes: `Admin ${adminUid} changed tier to ${tier_id}` }])
  }).catch(() => {
  });
  return jsonResp({ ok: true, tier_id });
}
__name(handleAdminUserTier, "handleAdminUserTier");
async function handleAdminToggleAdmin(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_ANON = env.SUPABASE_ANON_KEY;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_SVC) return errorResp("Service not configured", 503);
  const adminUid = await _verifyAdminJwt(request, SUPA_URL, SUPA_ANON, SUPA_SVC);
  if (!adminUid) return errorResp("Forbidden \u2014 admin access required", 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { user_id, is_admin } = body;
  if (!user_id || typeof is_admin !== "boolean") return errorResp("Invalid user_id or is_admin", 400);
  if (user_id === adminUid && !is_admin) return errorResp("Cannot revoke your own admin rights", 400);
  const r = await fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${user_id}`, {
    method: "PATCH",
    headers: {
      apikey: SUPA_SVC,
      Authorization: `Bearer ${SUPA_SVC}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ is_admin })
  });
  if (!r.ok) return errorResp("Failed to update admin status", r.status);
  return jsonResp({ ok: true, is_admin });
}
__name(handleAdminToggleAdmin, "handleAdminToggleAdmin");
async function handleAdminReactivateUser(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_ANON = env.SUPABASE_ANON_KEY;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_SVC) return errorResp("Service not configured", 503);
  const adminUid = await _verifyAdminJwt(request, SUPA_URL, SUPA_ANON, SUPA_SVC);
  if (!adminUid) return errorResp("Forbidden \u2014 admin access required", 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { user_id } = body;
  if (!user_id) return errorResp("Missing user_id", 400);
  const r = await fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${user_id}`, {
    method: "PATCH",
    headers: {
      apikey: SUPA_SVC,
      Authorization: `Bearer ${SUPA_SVC}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ cancelled_at: null, auto_renew: true })
  });
  if (!r.ok) return errorResp("Failed to reactivate", r.status);
  await fetch(`${SUPA_URL}/rest/v1/subscription_history`, {
    method: "POST",
    headers: {
      apikey: SUPA_SVC,
      Authorization: `Bearer ${SUPA_SVC}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify([{ user_id, action: "admin_reactivate", notes: `Admin ${adminUid} reactivated subscription` }])
  }).catch(() => {
  });
  return jsonResp({ ok: true });
}
__name(handleAdminReactivateUser, "handleAdminReactivateUser");
async function handleAdminUpdatePricing(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_SVC) {
    return errorResp("Service not configured", 503);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { tier_id, duration_months, price_excl_vat, stripe_price_id } = body;
  if (!tier_id || ![6, 12, 24].includes(duration_months) || price_excl_vat <= 0) {
    return errorResp("Invalid tier_id, duration_months, or price_excl_vat", 400);
  }
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/subscription_tier_pricing?tier_id=eq.${tier_id}&duration_months=eq.${duration_months}`, {
      method: "PATCH",
      headers: {
        apikey: SUPA_SVC,
        Authorization: `Bearer ${SUPA_SVC}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        price_excl_vat,
        stripe_price_id,
        updated_at: (/* @__PURE__ */ new Date()).toISOString()
      })
    });
    if (!r.ok) {
      return errorResp("Failed to update pricing", r.status);
    }
    STRIPE_PRICE_CACHE = {};
    STRIPE_PRICE_CACHE_TIME = 0;
    return jsonResp({ success: true, message: `Updated ${tier_id} ${duration_months}-month pricing` });
  } catch (e) {
    console.error("[AdminPricing]", e);
    return errorResp("Service error", 500);
  }
}
__name(handleAdminUpdatePricing, "handleAdminUpdatePricing");
async function handleAdminGetPaymentTransactions(request, env, url) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_SVC) {
    return errorResp("Service not configured", 503);
  }
  const searchParams = new URL(url).searchParams;
  const userId = searchParams.get("user_id");
  const status = searchParams.get("status");
  const limit = parseInt(searchParams.get("limit") || "100", 10);
  const offset = parseInt(searchParams.get("offset") || "0", 10);
  let query = `${SUPA_URL}/rest/v1/payment_transactions?select=*&order=transaction_date.desc&limit=${limit}&offset=${offset}`;
  if (userId) {
    query += `&user_id=eq.${userId}`;
  }
  if (status && ["successful", "failed", "pending"].includes(status)) {
    query += `&transaction_status=eq.${status}`;
  }
  try {
    const r = await fetch(query, {
      headers: {
        apikey: SUPA_SVC,
        Authorization: `Bearer ${SUPA_SVC}`
      }
    });
    if (!r.ok) {
      return errorResp("Failed to fetch transactions", r.status);
    }
    const transactions = await r.json();
    return jsonResp({ transactions, count: transactions.length, limit, offset });
  } catch (e) {
    console.error("[Transactions]", e);
    return errorResp("Service error", 500);
  }
}
__name(handleAdminGetPaymentTransactions, "handleAdminGetPaymentTransactions");
async function handleDisableAutoRenew(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_SVC) {
    return errorResp("Service not configured", 503);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { user_id } = body;
  if (!user_id) return errorResp("Missing user_id", 400);
  try {
    await Promise.all([
      // Disable auto-renew
      fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${user_id}`, {
        method: "PATCH",
        headers: {
          apikey: SUPA_SVC,
          Authorization: `Bearer ${SUPA_SVC}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({ auto_renew: false })
      }),
      // Log action
      fetch(`${SUPA_URL}/rest/v1/subscription_history`, {
        method: "POST",
        headers: {
          apikey: SUPA_SVC,
          Authorization: `Bearer ${SUPA_SVC}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          user_id,
          action: "disable_auto_renew",
          notes: "User disabled automatic subscription renewal"
        })
      })
    ]);
    return jsonResp({ success: true, message: "Auto-renew disabled" });
  } catch (e) {
    console.error("[AutoRenew]", e);
    return errorResp("Service error", 500);
  }
}
__name(handleDisableAutoRenew, "handleDisableAutoRenew");
async function handleRenewSubscription(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_KEY = env.SUPABASE_ANON_KEY;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  const STRIPE_KEY = env.STRIPE_SECRET_KEY;
  const DEBUG_MODE = !STRIPE_KEY;
  if (!SUPA_URL || !SUPA_SVC) {
    return errorResp("Service not configured", 503);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { user_id, tier, duration_months, use_saved_payment } = body;
  if (!user_id || !tier || ![6, 12, 24].includes(duration_months)) {
    return errorResp("Missing or invalid user_id, tier, or duration_months", 400);
  }
  try {
    const pricing = await fetchSubscriptionPrice(SUPA_URL, SUPA_KEY, tier, duration_months);
    if (!pricing || !pricing.stripe_price_id) {
      return errorResp("Pricing not available", 400);
    }
    const subscriptionStartDate = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const priceId = pricing.stripe_price_id;
    const params = new URLSearchParams();
    params.append("mode", "subscription");
    params.append("payment_method_types[0]", "card");
    params.append("line_items[0][price]", priceId);
    params.append("line_items[0][quantity]", "1");
    params.append("client_reference_id", user_id);
    params.append("success_url", `https://stockvizor.com/v?payment=success&tier=${tier}&duration=${duration_months}`);
    params.append("cancel_url", "https://stockvizor.com/");
    params.append("metadata[user_id]", user_id);
    params.append("metadata[tier]", tier);
    params.append("metadata[duration_months]", duration_months.toString());
    params.append("metadata[subscription_start_date]", subscriptionStartDate);
    params.append("automatic_tax[enabled]", "true");
    const _renewEndDt = new Date(subscriptionStartDate);
    _renewEndDt.setMonth(_renewEndDt.getMonth() + duration_months);
    const subscriptionEndDate = _renewEndDt.toISOString().slice(0, 10);
    if (DEBUG_MODE) {
      return jsonResp({
        debug: true,
        message: "Stripe key not configured \u2014 showing what would be sent to Stripe",
        summary: {
          type: "renewal",
          tier,
          duration_months,
          user_id,
          stripe_price_id: pricing.stripe_price_id || null,
          subscription_start_date: subscriptionStartDate,
          subscription_end_date: subscriptionEndDate,
          automatic_tax: true,
          success_url: `https://stockvizor.com/v?payment=success&tier=${tier}&duration=${duration_months}`,
          cancel_url: "https://stockvizor.com/"
        },
        stripe_params: Object.fromEntries(params)
      });
    }
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(STRIPE_KEY + ":"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });
    const session = await r.json();
    if (!r.ok) return errorResp("Payment service error", r.status);
    return jsonResp({ success: true, url: session.url, session_id: session.id });
  } catch (e) {
    console.error("[Renewal]", e);
    return errorResp("Service error", 502);
  }
}
__name(handleRenewSubscription, "handleRenewSubscription");
async function handleCancelSubscription(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_SVC) return errorResp("Service not configured", 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { user_id } = body;
  if (!user_id) return errorResp("Missing user_id", 400);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await Promise.allSettled([
    fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${user_id}`, {
      method: "PATCH",
      headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ cancelled_at: now, auto_renew: false })
    }),
    fetch(`${SUPA_URL}/rest/v1/subscription_history`, {
      method: "POST",
      headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id, action: "cancel", notes: "User requested soft cancellation \u2014 access until tier_expires_at" })
    })
  ]);
  const profR = await fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${user_id}&select=tier_expires_at`, {
    headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}` }
  });
  const prof = await profR.json();
  const accessUntil = Array.isArray(prof) && prof[0] ? prof[0].tier_expires_at : null;
  return jsonResp({ ok: true, access_until: accessUntil });
}
__name(handleCancelSubscription, "handleCancelSubscription");
async function handleScheduleUpgrade(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_SVC) return errorResp("Service not configured", 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { user_id, pending_tier_id, pending_duration_months } = body;
  if (!user_id || !pending_tier_id) return errorResp("Missing user_id or pending_tier_id", 400);
  if (![6, 12, 24].includes(pending_duration_months)) return errorResp("Invalid pending_duration_months", 400);
  await Promise.allSettled([
    fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${user_id}`, {
      method: "PATCH",
      headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ pending_tier_id, pending_duration_months })
    }),
    fetch(`${SUPA_URL}/rest/v1/subscription_history`, {
      method: "POST",
      headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id, action: "schedule_upgrade", notes: `Scheduled upgrade to ${pending_tier_id} ${pending_duration_months}mo at next renewal` })
    })
  ]);
  return jsonResp({ ok: true, pending_tier_id, pending_duration_months });
}
__name(handleScheduleUpgrade, "handleScheduleUpgrade");
async function handleCancelScheduledUpgrade(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_SVC) return errorResp("Service not configured", 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { user_id } = body;
  if (!user_id) return errorResp("Missing user_id", 400);
  await Promise.allSettled([
    fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${user_id}`, {
      method: "PATCH",
      headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ pending_tier_id: null, pending_duration_months: null })
    }),
    fetch(`${SUPA_URL}/rest/v1/subscription_history`, {
      method: "POST",
      headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id, action: "cancel_scheduled_upgrade", notes: "User cancelled the scheduled end-of-term tier change" })
    })
  ]);
  return jsonResp({ ok: true });
}
__name(handleCancelScheduledUpgrade, "handleCancelScheduledUpgrade");
async function handleGetPaymentMethods(request, env, url) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_SVC) return errorResp("Service not configured", 503);
  const user_id = new URL(url).searchParams.get("user_id");
  if (!user_id) return errorResp("Missing user_id", 400);
  const r = await fetch(`${SUPA_URL}/rest/v1/saved_payment_methods?user_id=eq.${user_id}&select=id,card_type,card_last_4,card_expiry_month,card_expiry_year,cardholder_name,billing_country,is_default,created_at&order=is_default.desc,created_at.asc`, {
    headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}` }
  });
  const methods = await r.json();
  return jsonResp({ payment_methods: Array.isArray(methods) ? methods : [] });
}
__name(handleGetPaymentMethods, "handleGetPaymentMethods");
async function handleRemovePaymentMethod(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  const STRIPE_KEY = env.STRIPE_SECRET_KEY;
  if (!SUPA_URL || !SUPA_SVC) return errorResp("Service not configured", 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { user_id, saved_payment_method_id } = body;
  if (!user_id || !saved_payment_method_id) return errorResp("Missing user_id or saved_payment_method_id", 400);
  const pmR = await fetch(`${SUPA_URL}/rest/v1/saved_payment_methods?id=eq.${saved_payment_method_id}&user_id=eq.${user_id}&select=stripe_payment_method_id,is_default`, {
    headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}` }
  });
  const pmData = await pmR.json();
  if (!Array.isArray(pmData) || pmData.length === 0) return errorResp("Payment method not found", 404);
  const { stripe_payment_method_id, is_default } = pmData[0];
  if (STRIPE_KEY && stripe_payment_method_id) {
    await fetch(`https://api.stripe.com/v1/payment_methods/${stripe_payment_method_id}/detach`, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(STRIPE_KEY + ":") }
    }).catch(() => {
    });
  }
  await fetch(`${SUPA_URL}/rest/v1/saved_payment_methods?id=eq.${saved_payment_method_id}&user_id=eq.${user_id}`, {
    method: "DELETE",
    headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}`, Prefer: "return=minimal" }
  });
  if (is_default) {
    const nextR = await fetch(`${SUPA_URL}/rest/v1/saved_payment_methods?user_id=eq.${user_id}&order=created_at.asc&limit=1&select=id`, {
      headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}` }
    });
    const nextCards = await nextR.json();
    if (Array.isArray(nextCards) && nextCards.length > 0) {
      await fetch(`${SUPA_URL}/rest/v1/saved_payment_methods?id=eq.${nextCards[0].id}`, {
        method: "PATCH",
        headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ is_default: true })
      });
    }
  }
  return jsonResp({ ok: true });
}
__name(handleRemovePaymentMethod, "handleRemovePaymentMethod");
async function handleSetDefaultPaymentMethod(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  const STRIPE_KEY = env.STRIPE_SECRET_KEY;
  if (!SUPA_URL || !SUPA_SVC) return errorResp("Service not configured", 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { user_id, saved_payment_method_id } = body;
  if (!user_id || !saved_payment_method_id) return errorResp("Missing user_id or saved_payment_method_id", 400);
  const [pmR, profR] = await Promise.all([
    fetch(`${SUPA_URL}/rest/v1/saved_payment_methods?id=eq.${saved_payment_method_id}&user_id=eq.${user_id}&select=stripe_payment_method_id`, {
      headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}` }
    }),
    fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${user_id}&select=stripe_customer_id`, {
      headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}` }
    })
  ]);
  const pmData = await pmR.json();
  const profData = await profR.json();
  if (!Array.isArray(pmData) || pmData.length === 0) return errorResp("Payment method not found", 404);
  const stripe_payment_method_id = pmData[0].stripe_payment_method_id;
  const stripe_customer_id = Array.isArray(profData) && profData[0] ? profData[0].stripe_customer_id : null;
  await fetch(`${SUPA_URL}/rest/v1/saved_payment_methods?user_id=eq.${user_id}`, {
    method: "PATCH",
    headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ is_default: false })
  });
  await fetch(`${SUPA_URL}/rest/v1/saved_payment_methods?id=eq.${saved_payment_method_id}&user_id=eq.${user_id}`, {
    method: "PATCH",
    headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ is_default: true })
  });
  if (STRIPE_KEY && stripe_customer_id && stripe_payment_method_id) {
    const params = new URLSearchParams();
    params.append("invoice_settings[default_payment_method]", stripe_payment_method_id);
    await fetch(`https://api.stripe.com/v1/customers/${stripe_customer_id}`, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(STRIPE_KEY + ":"), "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    }).catch(() => {
    });
  }
  return jsonResp({ ok: true });
}
__name(handleSetDefaultPaymentMethod, "handleSetDefaultPaymentMethod");
async function handleCreateSetupIntent(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  const STRIPE_KEY = env.STRIPE_SECRET_KEY;
  if (!STRIPE_KEY || !SUPA_URL || !SUPA_SVC) return errorResp("Service not configured", 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { user_id } = body;
  if (!user_id) return errorResp("Missing user_id", 400);
  const profR = await fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${user_id}&select=stripe_customer_id`, {
    headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}` }
  });
  const profData = await profR.json();
  const stripe_customer_id = Array.isArray(profData) && profData[0] ? profData[0].stripe_customer_id : null;
  if (!stripe_customer_id) return errorResp("No Stripe customer found for this user. Please complete a purchase first.", 400);
  const countR = await fetch(`${SUPA_URL}/rest/v1/saved_payment_methods?user_id=eq.${user_id}&select=id`, {
    headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}` }
  });
  const cards = await countR.json();
  if (Array.isArray(cards) && cards.length >= 3) {
    return errorResp("Maximum of 3 payment methods allowed. Remove one before adding another.", 400);
  }
  const params = new URLSearchParams();
  params.append("customer", stripe_customer_id);
  params.append("payment_method_types[0]", "card");
  const r = await fetch("https://api.stripe.com/v1/setup_intents", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(STRIPE_KEY + ":"), "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  const si = await r.json();
  if (!r.ok) return errorResp(si.error?.message || "Stripe error", r.status);
  return jsonResp({ client_secret: si.client_secret });
}
__name(handleCreateSetupIntent, "handleCreateSetupIntent");
async function handleAddCardSession(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  const STRIPE_KEY = env.STRIPE_SECRET_KEY;
  if (!STRIPE_KEY || !SUPA_URL || !SUPA_SVC) return errorResp("Service not configured", 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { user_id } = body;
  if (!user_id) return errorResp("Missing user_id", 400);
  const profR = await fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${user_id}&select=stripe_customer_id`, {
    headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}` }
  });
  const profData = await profR.json();
  const stripeCustomerId = Array.isArray(profData) && profData[0]?.stripe_customer_id ? profData[0].stripe_customer_id : null;
  if (!stripeCustomerId) return errorResp("No Stripe customer found. Please complete a purchase first.", 400);
  const countR = await fetch(`${SUPA_URL}/rest/v1/saved_payment_methods?user_id=eq.${user_id}&select=id`, {
    headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}` }
  });
  const cards = await countR.json();
  if (Array.isArray(cards) && cards.length >= 3) {
    return errorResp("Maximum of 3 payment methods allowed. Remove one before adding another.", 400);
  }
  const params = new URLSearchParams();
  params.append("mode", "setup");
  params.append("customer", stripeCustomerId);
  params.append("payment_method_types[0]", "card");
  params.append("success_url", "https://stockvizor.com/83935753a5417982371618d9871e90e0?setup=success");
  params.append("cancel_url", "https://stockvizor.com/83935753a5417982371618d9871e90e0?setup=cancelled");
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(STRIPE_KEY + ":"), "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  const session = await r.json();
  if (!r.ok) return errorResp(session.error?.message || "Stripe error", r.status);
  return jsonResp({ ok: true, url: session.url });
}
__name(handleAddCardSession, "handleAddCardSession");
async function handleGetCurrencyRates(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_SVC) return errorResp("Service not configured", 503);
  const r = await fetch(`${SUPA_URL}/rest/v1/currency_rates?order=currency_code`, {
    headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}` }
  });
  const rates = await r.json();
  return jsonResp({ currency_rates: Array.isArray(rates) ? rates : [] });
}
__name(handleGetCurrencyRates, "handleGetCurrencyRates");
async function handleAdminUpdateCurrencyRate(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_SVC) return errorResp("Service not configured", 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { currency_code, rate_vs_usd, currency_symbol } = body;
  if (!currency_code || rate_vs_usd == null || rate_vs_usd <= 0) return errorResp("Invalid currency_code or rate_vs_usd", 400);
  const updateData = { rate_vs_usd, updated_at: (/* @__PURE__ */ new Date()).toISOString() };
  if (currency_symbol) updateData.currency_symbol = currency_symbol;
  const r = await fetch(`${SUPA_URL}/rest/v1/currency_rates?currency_code=eq.${currency_code}`, {
    method: "PATCH",
    headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(updateData)
  });
  if (r.status === 204 || r.ok) {
    CURRENCY_RATE_CACHE = {};
    CURRENCY_RATE_CACHE_TIME = 0;
    return jsonResp({ ok: true });
  }
  return errorResp("Failed to update currency rate", r.status);
}
__name(handleAdminUpdateCurrencyRate, "handleAdminUpdateCurrencyRate");
var CURRENCY_RATE_CACHE = {};
var CURRENCY_RATE_CACHE_TIME = 0;
var CURRENCY_CACHE_TTL = 3e5;
async function resolveCurrencyForCountry(supabaseUrl, supabaseKey, countryCode) {
  const now = Date.now();
  if (CURRENCY_RATE_CACHE[countryCode] && now - CURRENCY_RATE_CACHE_TIME < CURRENCY_CACHE_TTL) {
    return CURRENCY_RATE_CACHE[countryCode];
  }
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/country_currency_map?country_code=eq.${encodeURIComponent(countryCode)}&select=currency_code,currency_rates(currency_symbol,rate_vs_usd)`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }
    });
    const rows = await r.json();
    if (Array.isArray(rows) && rows.length > 0) {
      const row = rows[0];
      const result = {
        currency_code: row.currency_code,
        currency_symbol: row.currency_rates?.currency_symbol || "$",
        rate_vs_usd: parseFloat(row.currency_rates?.rate_vs_usd || 1)
      };
      CURRENCY_RATE_CACHE[countryCode] = result;
      CURRENCY_RATE_CACHE_TIME = now;
      return result;
    }
  } catch (e) {
  }
  return { currency_code: "USD", currency_symbol: "$", rate_vs_usd: 1 };
}
__name(resolveCurrencyForCountry, "resolveCurrencyForCountry");
function convertPrice(usdPrice, rate) {
  return Math.ceil(usdPrice * rate * 100) / 100;
}
__name(convertPrice, "convertPrice");
function _parseBrowser(ua) {
  if (!ua) return "Unknown";
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("OPR/") || ua.includes("Opera/")) return "Opera";
  if (ua.includes("Chrome/")) return "Chrome";
  if (ua.includes("Firefox/")) return "Firefox";
  if (ua.includes("Safari/")) return "Safari";
  if (ua.includes("MSIE") || ua.includes("Trident/")) return "IE";
  return "Other";
}
__name(_parseBrowser, "_parseBrowser");
function _parseOS(ua) {
  if (!ua) return "Unknown";
  if (ua.includes("Windows NT")) return "Windows";
  if (ua.includes("Mac OS X")) return "macOS";
  if (ua.includes("iPhone")) return "iOS";
  if (ua.includes("iPad")) return "iPadOS";
  if (ua.includes("Android")) return "Android";
  if (ua.includes("Linux")) return "Linux";
  return "Other";
}
__name(_parseOS, "_parseOS");
async function _createDeviceSession(uid, request, supaUrl, supaSvc, logoutReason = "new_login", clientDeviceId = null) {
  try {
    const token = crypto.randomUUID();
    const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
    const country = request.headers.get("CF-IPCountry") || "";
    const ua = (request.headers.get("User-Agent") || "").slice(0, 250);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const browser = _parseBrowser(ua);
    const os = _parseOS(ua);
    const device_info = {
      browser,
      os,
      country,
      ip_hint: ip.slice(0, 45),
      logged_in_at: now
    };
    const existing = await supaFetch(
      supaUrl,
      supaSvc,
      "device_history",
      `user_id=eq.${uid}&select=device_token,client_device_id,device_info&order=logged_in_at.desc&limit=10`
    );
    const oldToken = existing?.[0]?.device_token || null;
    const knownDeviceIds = new Set((existing || []).map((r) => r.client_device_id).filter(Boolean));
    const knownSignatures = new Set((existing || []).map((r) => `${r.device_info?.browser}_${r.device_info?.os}`).filter(Boolean));
    const currentSig = `${browser}_${os}`;
    const isNewDeviceId = !!clientDeviceId && !knownDeviceIds.has(clientDeviceId);
    const isNewSignature = !knownSignatures.has(currentSig);
    const hasPriorSessions = (existing || []).length > 0;
    const isSuspicious = hasPriorSessions && isNewDeviceId && isNewSignature;
    if (isSuspicious) {
      await fetch(`${supaUrl}/rest/v1/device_history`, {
        method: "POST",
        headers: {
          apikey: supaSvc,
          Authorization: `Bearer ${supaSvc}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify([{
          user_id: uid,
          device_token: crypto.randomUUID(),
          // unique but never written to user_profiles
          client_device_id: clientDeviceId || null,
          device_info,
          ip_hint: ip.slice(0, 45),
          logged_in_at: now,
          logged_out_at: now,
          // immediately closed — never active
          logout_reason: "suspicious_blocked",
          is_suspicious: true
        }])
      }).catch(() => {
      });
      return { token: null, suspicious: true };
    }
    await Promise.all([
      // 1. Stamp new token onto user_profiles (triggers Realtime on old device)
      fetch(`${supaUrl}/rest/v1/user_profiles?id=eq.${uid}`, {
        method: "PATCH",
        headers: {
          apikey: supaSvc,
          Authorization: `Bearer ${supaSvc}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({ device_token: token, device_info, device_changed_at: now })
      }),
      // 2. Close old device_history row
      oldToken ? fetch(`${supaUrl}/rest/v1/device_history?device_token=eq.${encodeURIComponent(oldToken)}&logged_out_at=is.null`, {
        method: "PATCH",
        headers: {
          apikey: supaSvc,
          Authorization: `Bearer ${supaSvc}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({ logged_out_at: now, logout_reason: logoutReason })
      }) : Promise.resolve(),
      // 3. Open new device_history row
      fetch(`${supaUrl}/rest/v1/device_history`, {
        method: "POST",
        headers: {
          apikey: supaSvc,
          Authorization: `Bearer ${supaSvc}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify([{
          user_id: uid,
          device_token: token,
          client_device_id: clientDeviceId || null,
          device_info,
          ip_hint: ip.slice(0, 45),
          logged_in_at: now,
          is_suspicious: false
        }])
      })
    ]);
    return { token, suspicious: false };
  } catch (_) {
    return { token: null, suspicious: false };
  }
}
__name(_createDeviceSession, "_createDeviceSession");
async function _uidFromSession(request, supaUrl, supaAnon) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;
  const r = await fetch(`${supaUrl}/auth/v1/user`, {
    headers: { apikey: supaAnon, Authorization: `Bearer ${token}` }
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const data = await r.json().catch(() => null);
  return data?.id ?? null;
}
__name(_uidFromSession, "_uidFromSession");
async function handleAuth(request, env, url) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_ANON = env.SUPABASE_ANON_KEY;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || SUPA_ANON;
  if (!SUPA_URL || !SUPA_ANON) return errorResp("Auth not configured", 500);
  const rest = url.pathname.slice("/api/auth/".length);
  if (rest === "check-email" && request.method === "GET") {
    const email = url.searchParams.get("email");
    if (!email) return jsonResp({ exists: false });
    try {
      const resp = await fetch(
        `${SUPA_URL}/auth/v1/admin/users?search=${encodeURIComponent(email)}&page=1&per_page=20`,
        { headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}` } }
      );
      if (!resp.ok) return jsonResp({ exists: false });
      const data = await resp.json();
      const emailLower = email.toLowerCase().trim();
      const exists = Array.isArray(data.users) && data.users.some((u) => (u.email || "").toLowerCase().trim() === emailLower);
      return jsonResp({ exists });
    } catch (_) {
      return jsonResp({ exists: false });
    }
  }
  if (rest === "signup" && request.method === "POST") {
    return errorResp("New account registration is temporarily unavailable.", 503);
    let body;
    try {
      body = await request.json();
    } catch {
      return errorResp("Invalid JSON", 400);
    }
    const { email, password, name } = body;
    if (!email || !password) return errorResp("Missing email or password", 400);
    const resp = await fetch(`${SUPA_URL}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: SUPA_ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const data = await resp.json();
    if (!resp.ok) return errorResp(data.error_description || data.msg || data.message || "Signup failed", resp.status >= 400 ? resp.status : 400);
    const uid = data.user?.id;
    const session = data.session || null;
    if (uid) {
      const profileUpdate = {};
      if (name) profileUpdate.display_name = name;
      try {
        const STRIPE_KEY = env.STRIPE_SECRET_KEY;
        if (STRIPE_KEY) {
          const custParams = new URLSearchParams();
          custParams.append("email", email);
          if (name) custParams.append("name", name);
          custParams.append("metadata[user_id]", uid);
          const custResp = await fetch("https://api.stripe.com/v1/customers", {
            method: "POST",
            headers: {
              Authorization: "Basic " + btoa(STRIPE_KEY + ":"),
              "Content-Type": "application/x-www-form-urlencoded"
            },
            body: custParams.toString()
          });
          if (custResp.ok) {
            const customer = await custResp.json();
            profileUpdate.stripe_customer_id = customer.id;
          }
        }
      } catch (_) {
      }
      if (Object.keys(profileUpdate).length > 0) {
        await fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${uid}`, {
          method: "PATCH",
          headers: {
            apikey: SUPA_SVC,
            Authorization: `Bearer ${SUPA_SVC}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal"
          },
          body: JSON.stringify(profileUpdate)
        }).catch(() => {
        });
      }
    }
    const { token: device_token } = uid && session ? await _createDeviceSession(uid, request, SUPA_URL, SUPA_SVC, "new_login", body.client_device_id || null) : { token: null };
    return jsonResp({ user_id: uid, session, device_token });
  }
  if (rest === "login" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return errorResp("Invalid JSON", 400);
    }
    const { email, password } = body;
    if (!email || !password) return errorResp("Missing email or password", 400);
    const resp = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: SUPA_ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const data = await resp.json();
    if (!resp.ok) return errorResp(data.error_description || data.msg || data.message || "Login failed", resp.status >= 400 ? resp.status : 400);
    const uid = data.user?.id;
    const { token: device_token } = uid ? await _createDeviceSession(uid, request, SUPA_URL, SUPA_SVC, "new_login", body.client_device_id || null) : { token: null };
    return jsonResp({
      user_id: uid,
      email: data.user?.email,
      device_token,
      device_suspicious: false,
      session: {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Math.floor(Date.now() / 1e3) + (data.expires_in || 3600),
        expires_in: data.expires_in || 3600,
        token_type: data.token_type || "bearer",
        user: data.user
      }
    });
  }
  if (rest === "verify-device-otp" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return errorResp("Invalid JSON", 400);
    }
    const { email, otp_token, client_device_id } = body;
    if (!email || !otp_token) return errorResp("email and otp_token required", 400);
    const verifyResp = await fetch(`${SUPA_URL}/auth/v1/verify`, {
      method: "POST",
      headers: { apikey: SUPA_ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "email", email, token: otp_token })
    });
    if (!verifyResp.ok) {
      const err = await verifyResp.json().catch(() => ({}));
      return errorResp(err.msg || err.error_description || err.message || "Invalid or expired code", 401);
    }
    const verifyData = await verifyResp.json();
    const uid = verifyData.user?.id;
    if (!uid) return errorResp("Verification failed \u2014 could not identify user", 401);
    const { token: device_token } = await _createDeviceSession(
      uid,
      request,
      SUPA_URL,
      SUPA_SVC,
      "otp_verified",
      client_device_id || null
    );
    return jsonResp({
      ok: true,
      user_id: uid,
      email: verifyData.user?.email,
      device_token,
      session: {
        access_token: verifyData.access_token,
        refresh_token: verifyData.refresh_token,
        expires_at: Math.floor(Date.now() / 1e3) + (verifyData.expires_in || 3600),
        expires_in: verifyData.expires_in || 3600,
        token_type: verifyData.token_type || "bearer",
        user: verifyData.user
      }
    });
  }
  if (rest === "resend-otp" && request.method === "POST") {
    let body = {};
    try {
      body = await request.json();
    } catch {
    }
    const { email } = body;
    if (!email) return jsonResp({ ok: false });
    fetch(`${SUPA_URL}/auth/v1/otp`, {
      method: "POST",
      headers: { apikey: SUPA_ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, create_user: false })
    }).catch(() => {
    });
    return jsonResp({ ok: true });
  }
  if (rest === "consent" && request.method === "GET") {
    const uid = url.searchParams.get("uid");
    if (!uid) return errorResp("Missing uid", 400);
    const rows = await supaFetch(
      SUPA_URL,
      SUPA_SVC,
      "user_consents",
      `user_id=eq.${uid}&consent_type=in.(disclaimer,indemnification_v1)&select=id&limit=1`
    );
    return jsonResp({ has_consent: !!(rows && rows.length > 0) });
  }
  if (rest === "consent" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return errorResp("Invalid JSON", 400);
    }
    const { uid, user_agent, consent_version, confirmation_phrase } = body;
    if (!uid) return errorResp("Missing uid", 400);
    const sessionUid = await _uidFromSession(request, SUPA_URL, SUPA_ANON);
    if (!sessionUid || sessionUid !== uid) return errorResp("Unauthorized", 401);
    const isNewFlow = consent_version >= 2 || typeof confirmation_phrase === "string" && confirmation_phrase.trim().length > 0;
    const consentType = isNewFlow ? "indemnification_v1" : "disclaimer";
    const consentText = isNewFlow ? "User completed mandatory two-step consent. Step 1: accepted Terms & Conditions. Step 2: checked confirmation box accepting full personal responsibility and indemnification of StockVizor LLC." : "User accepted educational disclaimer and confirmed 18+ age";
    const resp = await fetch(`${SUPA_URL}/rest/v1/user_consents`, {
      method: "POST",
      headers: {
        apikey: SUPA_SVC,
        Authorization: `Bearer ${SUPA_SVC}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify([{
        user_id: uid,
        consent_type: consentType,
        consent_text: consentText,
        user_agent: user_agent || "",
        accepted_at: (/* @__PURE__ */ new Date()).toISOString()
      }])
    });
    if (!resp.ok) return errorResp("Failed to record consent", resp.status);
    return jsonResp({ ok: true });
  }
  if (rest === "trial" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return errorResp("Invalid JSON", 400);
    }
    const { uid } = body;
    if (!uid) return errorResp("Missing uid", 400);
    const trialStart = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const trialEnd = new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10);
    const tierExpiresAt = new Date(Date.now() + 6 * 864e5).toISOString();
    const [r1, r2] = await Promise.all([
      fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${uid}`, {
        method: "PATCH",
        headers: {
          apikey: SUPA_SVC,
          Authorization: `Bearer ${SUPA_SVC}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          tier_id: "premium",
          subscription_status: "first_time",
          trial_start: trialStart,
          trial_end: trialEnd,
          trial_used: false,
          tier_expires_at: tierExpiresAt
        })
      }),
      fetch(`${SUPA_URL}/rest/v1/subscription_history`, {
        method: "POST",
        headers: {
          apikey: SUPA_SVC,
          Authorization: `Bearer ${SUPA_SVC}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify([{
          user_id: uid,
          action: "first_time",
          tier_id: "premium",
          amount_paid: 0,
          subscription_start: trialStart,
          subscription_end: trialEnd,
          notes: "5-day premium trial started"
        }])
      })
    ]);
    if (!r1.ok || !r2.ok) return errorResp("Failed to start trial", 500);
    return jsonResp({ ok: true });
  }
  if (rest === "signout" && request.method === "POST") {
    let token = "", uid = "", device_token = "";
    try {
      const b = await request.json();
      token = b.token || "";
      uid = b.uid || "";
      device_token = b.device_token || "";
    } catch {
    }
    if (token) {
      await fetch(`${SUPA_URL}/auth/v1/logout`, {
        method: "POST",
        headers: { apikey: SUPA_ANON, Authorization: `Bearer ${token}` }
      }).catch(() => {
      });
    }
    if (uid) {
      const now = (/* @__PURE__ */ new Date()).toISOString();
      await Promise.all([
        fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${uid}`, {
          method: "PATCH",
          headers: {
            apikey: SUPA_SVC,
            Authorization: `Bearer ${SUPA_SVC}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal"
          },
          body: JSON.stringify({ device_token: null, device_changed_at: now })
        }).catch(() => {
        }),
        device_token ? fetch(`${SUPA_URL}/rest/v1/device_history?device_token=eq.${encodeURIComponent(device_token)}&logged_out_at=is.null`, {
          method: "PATCH",
          headers: {
            apikey: SUPA_SVC,
            Authorization: `Bearer ${SUPA_SVC}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal"
          },
          body: JSON.stringify({ logged_out_at: now, logout_reason: "manual" })
        }).catch(() => {
        }) : Promise.resolve()
      ]);
    }
    return jsonResp({ ok: true });
  }
  if (rest === "profile" && request.method === "DELETE") {
    const uid = url.searchParams.get("uid");
    if (!uid) return errorResp("Missing uid", 400);
    const sessionUid = await _uidFromSession(request, SUPA_URL, SUPA_ANON);
    if (!sessionUid || sessionUid !== uid) return errorResp("Unauthorized", 401);
    await fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${uid}`, {
      method: "DELETE",
      headers: {
        apikey: SUPA_SVC,
        Authorization: `Bearer ${SUPA_SVC}`,
        Prefer: "return=minimal"
      }
    }).catch(() => {
    });
    return jsonResp({ ok: true });
  }
  if (rest === "ai-assist-consent" && request.method === "GET") {
    const uid = url.searchParams.get("uid");
    if (!uid) return errorResp("Missing uid", 400);
    const sessionUid = await _uidFromSession(request, SUPA_URL, SUPA_ANON);
    if (!sessionUid || sessionUid !== uid) return errorResp("Unauthorized", 401);
    const rows = await supaFetch(
      SUPA_URL,
      SUPA_SVC,
      "user_consents",
      `user_id=eq.${uid}&consent_type=eq.ai_assist_v1&select=id,created_at&limit=1`
    );
    const row = rows && rows[0];
    return jsonResp({ has_consent: !!row, agreed_at: row?.created_at || null });
  }
  if (rest === "ai-assist-consent" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return errorResp("Invalid JSON", 400);
    }
    const { uid, user_agent } = body;
    if (!uid) return errorResp("Missing uid", 400);
    await fetch(`${SUPA_URL}/rest/v1/user_consents`, {
      method: "POST",
      headers: {
        apikey: SUPA_SVC,
        Authorization: `Bearer ${SUPA_SVC}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        user_id: uid,
        consent_type: "ai_assist_v1",
        user_agent: user_agent || ""
      })
    });
    return jsonResp({ ok: true });
  }
  return errorResp("Unknown auth route", 404);
}
__name(handleAuth, "handleAuth");
async function handleResearch(request, env, url) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_KEY = env.SUPABASE_ANON_KEY;
  if (!SUPA_URL || !SUPA_KEY) return errorResp("Research not configured", 500);
  const rest = url.pathname.slice("/api/research/".length);
  if (rest === "macro") {
    const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    let rows = await supaFetch(
      SUPA_URL,
      SUPA_KEY,
      "research_macro_reports",
      `report_date=eq.${today}&select=report_date,title,summary,body_md,charts,images,sources,model,amended&limit=1`
    );
    if (!rows || !rows.length) {
      rows = await supaFetch(
        SUPA_URL,
        SUPA_KEY,
        "research_macro_reports",
        `select=report_date,title,summary,body_md,charts,images,sources,model,amended&order=report_date.desc&limit=1`
      );
    }
    return jsonResp({ report: rows && rows[0] || null });
  }
  if (rest === "stocks") {
    const tickerParam = url.searchParams.get("tickers") || "";
    const tickers = tickerParam.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean).slice(0, 50);
    if (!tickers.length) return jsonResp({ reports: [] });
    const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    let rows = await supaFetch(
      SUPA_URL,
      SUPA_KEY,
      "research_stock_reports",
      `report_date=eq.${today}&ticker=in.(${tickers.join(",")})&select=ticker,report_date,title,summary,body_md,charts,images,model`
    );
    if (!rows || !rows.length) {
      const latestRows = await supaFetch(
        SUPA_URL,
        SUPA_KEY,
        "research_stock_reports",
        `select=report_date&ticker=in.(${tickers.join(",")})&order=report_date.desc&limit=1`
      );
      const latestDate = latestRows && latestRows[0] ? latestRows[0].report_date : null;
      if (latestDate && latestDate !== today) {
        rows = await supaFetch(
          SUPA_URL,
          SUPA_KEY,
          "research_stock_reports",
          `report_date=eq.${latestDate}&ticker=in.(${tickers.join(",")})&select=ticker,report_date,title,summary,body_md,charts,images,model`
        );
      }
    }
    return jsonResp({ reports: rows || [] });
  }
  if (rest === "sectors") {
    const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    let rows = await supaFetch(
      SUPA_URL,
      SUPA_KEY,
      "research_sector_reports",
      `report_date=eq.${today}&select=sector,report_date,title,summary,body_md,charts,images,model&order=sector.asc`
    );
    if (!rows || !rows.length) {
      const latestRows = await supaFetch(
        SUPA_URL,
        SUPA_KEY,
        "research_sector_reports",
        `select=report_date&order=report_date.desc&limit=1`
      );
      const latestDate = latestRows && latestRows[0] ? latestRows[0].report_date : null;
      if (latestDate && latestDate !== today) {
        rows = await supaFetch(
          SUPA_URL,
          SUPA_KEY,
          "research_sector_reports",
          `report_date=eq.${latestDate}&select=sector,report_date,title,summary,body_md,charts,images,model&order=sector.asc`
        );
      }
    }
    return jsonResp({ reports: rows || [] });
  }
  return errorResp("Unknown research route", 404);
}
__name(handleResearch, "handleResearch");
async function _researchAdminAuth(request, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  const auth = (request.headers.get("Authorization") || "").replace("Bearer ", "").trim();
  if (!auth) return null;
  try {
    const u = await fetch(`${SUPA_URL}/auth/v1/user`, {
      headers: { apikey: SUPA_SVC, Authorization: `Bearer ${auth}` }
    });
    if (!u.ok) return null;
    const ud = await u.json();
    const pr = await fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${ud.id}&select=is_admin&limit=1`, {
      headers: { apikey: SUPA_SVC, Authorization: `Bearer ${SUPA_SVC}` }
    });
    const pj = await pr.json();
    return pj?.[0]?.is_admin ? ud : null;
  } catch {
    return null;
  }
}
__name(_researchAdminAuth, "_researchAdminAuth");
async function handleResearchStartImageGen(request, env) {
  const admin = await _researchAdminAuth(request, env);
  if (!admin) return errorResp("Admin access required", 403);
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { type, report_date, sector, ticker, force } = body;
  if (!type || !report_date) return errorResp("type and report_date required", 400);
  if (!["macro", "sector", "stock"].includes(type)) return errorResp("Invalid type", 400);
  if (type === "sector" && !sector) return errorResp("sector required", 400);
  if (type === "stock" && !ticker) return errorResp("ticker required", 400);
  const table = type === "macro" ? "research_macro_reports" : type === "sector" ? "research_sector_reports" : "research_stock_reports";
  const filter = type === "macro" ? `report_date=eq.${report_date}&select=title&limit=1` : type === "sector" ? `report_date=eq.${report_date}&sector=eq.${sector}&select=title&limit=1` : `report_date=eq.${report_date}&ticker=eq.${encodeURIComponent(ticker)}&select=title&limit=1`;
  const rows = await supaFetch(SUPA_URL, SUPA_SVC, table, filter);
  if (!rows || !rows.length) return errorResp("Report not found \u2014 check type, report_date, sector/ticker", 404);
  const params = new URLSearchParams({ type, report_date });
  if (sector) params.set("sector", sector);
  if (ticker) params.set("ticker", ticker);
  if (force) params.set("force", "1");
  fetch(`${SUPA_URL}/functions/v1/generate-research-images?${params}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPA_SVC}`, "Content-Type": "application/json" }
  }).catch(() => {
  });
  return jsonResp({ started: true });
}
__name(handleResearchStartImageGen, "handleResearchStartImageGen");
async function handleResearchPollImageGen(request, env, url) {
  const admin = await _researchAdminAuth(request, env);
  if (!admin) return errorResp("Admin access required", 403);
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  const genId = url.searchParams.get("genId");
  if (!genId) return errorResp("genId required", 400);
  const pollResp = await fetch(
    `${SUPA_URL}/functions/v1/leonardo-proxy?action=poll&genId=${encodeURIComponent(genId)}`,
    {
      headers: {
        Authorization: `Bearer ${SUPA_SVC}`,
        "x-sv-secret": SUPA_SVC
      }
    }
  );
  if (!pollResp.ok) return errorResp(`Leonardo poll error: ${pollResp.status}`, 502);
  const pollData = await pollResp.json();
  const gen = pollData.generations_by_pk;
  if (!gen) return errorResp("Generation not found", 404);
  if (gen.status === "COMPLETE" && gen.generated_images?.length) {
    return jsonResp({ status: "COMPLETE", imageUrls: gen.generated_images.map((img) => img.url) });
  }
  if (gen.status === "FAILED") return jsonResp({ status: "FAILED" });
  return jsonResp({ status: "PENDING" });
}
__name(handleResearchPollImageGen, "handleResearchPollImageGen");
async function handleResearchStoreImages(request, env) {
  const admin = await _researchAdminAuth(request, env);
  if (!admin) return errorResp("Admin access required", 403);
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_SVC = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON", 400);
  }
  const { type, report_date, sector, ticker, imageUrls, prompt } = body;
  if (!type || !report_date || !Array.isArray(imageUrls) || !imageUrls.length)
    return errorResp("type, report_date, imageUrls required", 400);
  const BUCKET = "research-images";
  const images = [];
  for (let i = 0; i < Math.min(imageUrls.length, 5); i++) {
    try {
      const imgResp = await fetch(imageUrls[i]);
      if (!imgResp.ok) continue;
      const imgBytes = await imgResp.arrayBuffer();
      const pathPfx = type === "macro" ? `macro/${report_date}` : type === "sector" ? `sector/${report_date}_${sector}` : `stock/${report_date}_${(ticker || "").toUpperCase()}`;
      const storagePath = `${pathPfx}_${i}.jpg`;
      const upResp = await fetch(`${SUPA_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPA_SVC}`,
          "Content-Type": "image/jpeg",
          "x-upsert": "true"
        },
        body: imgBytes
      });
      if (!upResp.ok) continue;
      images.push({
        url: `${SUPA_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`,
        alt: (prompt || "").slice(0, 120)
      });
    } catch {
    }
  }
  if (!images.length) return errorResp("Failed to store any images", 502);
  const table = type === "macro" ? "research_macro_reports" : type === "sector" ? "research_sector_reports" : "research_stock_reports";
  const patchFilter = type === "macro" ? `report_date=eq.${report_date}` : type === "sector" ? `report_date=eq.${report_date}&sector=eq.${sector}` : `report_date=eq.${report_date}&ticker=eq.${encodeURIComponent(ticker)}`;
  await fetch(`${SUPA_URL}/rest/v1/${table}?${patchFilter}`, {
    method: "PATCH",
    headers: {
      apikey: SUPA_SVC,
      Authorization: `Bearer ${SUPA_SVC}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ images })
  });
  return jsonResp({ images, count: images.length });
}
__name(handleResearchStoreImages, "handleResearchStoreImages");
async function handleLiqHistory(request, env, url) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_KEY = env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
  const POLY_KEY = env.POLYGON_KEY;
  if (!SUPA_URL || !SUPA_KEY) return errorResp("Supabase not configured", 500);
  if (!POLY_KEY) return errorResp("Polygon API key not configured", 500);
  const ticker = (url.searchParams.get("ticker") || "").toUpperCase().trim();
  if (!ticker) return errorResp("ticker required", 400);
  const todayISO = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const oneYearAgo = new Date(Date.now() - 366 * 864e5).toISOString().slice(0, 10);
  const dbQ = `${SUPA_URL}/rest/v1/liquidity_history?ticker=eq.${encodeURIComponent(ticker)}&trading_date=gte.${oneYearAgo}&order=trading_date.asc&select=trading_date,inflow,outflow,net,inflow_pct,outflow_pct&limit=400`;
  const dbResp = await fetch(dbQ, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
  });
  let rows = dbResp.ok ? await dbResp.json() : [];
  if (!Array.isArray(rows)) rows = [];
  const lastRowDate = rows.length ? rows[rows.length - 1].trading_date : null;
  const needsFull = rows.length < 180;
  const yesterdayISO = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const needsTopUp = !needsFull && lastRowDate && lastRowDate < yesterdayISO;
  if (needsFull || needsTopUp) {
    try {
      const fromDate = needsFull ? oneYearAgo : new Date(new Date(lastRowDate).getTime() + 864e5).toISOString().slice(0, 10);
      const polyUrl = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${fromDate}/${todayISO}?adjusted=true&sort=asc&limit=500&apiKey=${POLY_KEY}`;
      const polyResp = await fetch(polyUrl, { headers: { "User-Agent": "StockVizor/1.0" } });
      if (polyResp.ok) {
        const pj = await polyResp.json();
        const bars = (pj.results || []).filter((b) => b.v > 0 && b.c > 0);
        if (bars.length) {
          const upsertRows = bars.map((b) => {
            const dv = b.v * b.c;
            const inflow = b.c >= b.o ? dv : 0;
            const outflow = b.c < b.o ? dv : 0;
            const net = inflow - outflow;
            return {
              ticker,
              trading_date: new Date(b.t).toISOString().slice(0, 10),
              inflow,
              outflow,
              net,
              inflow_pct: Math.round(inflow / (dv || 1) * 1e4) / 100,
              outflow_pct: Math.round(outflow / (dv || 1) * 1e4) / 100
            };
          });
          const upsertChunks = [];
          for (let i = 0; i < upsertRows.length; i += 100) {
            upsertChunks.push(upsertRows.slice(i, i + 100));
          }
          for (const chunk of upsertChunks) {
            await fetch(`${SUPA_URL}/rest/v1/liquidity_history`, {
              method: "POST",
              headers: {
                apikey: SUPA_KEY,
                Authorization: `Bearer ${SUPA_KEY}`,
                "Content-Type": "application/json",
                Prefer: "resolution=merge-duplicates"
              },
              body: JSON.stringify(chunk)
            });
          }
          if (needsFull) {
            rows = upsertRows;
          } else {
            const existing = new Set(rows.map((r) => r.trading_date));
            const newRows = upsertRows.filter((r) => !existing.has(r.trading_date));
            rows = [...rows, ...newRows].sort((a, b) => a.trading_date.localeCompare(b.trading_date));
          }
        }
      }
    } catch (_) {
    }
  }
  return jsonResp({ ticker, rows });
}
__name(handleLiqHistory, "handleLiqHistory");
async function handleRunStats(request, env, url) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_KEY = env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
  if (!SUPA_URL || !SUPA_KEY) return errorResp("DB not configured", 500);
  const ticker = (url.searchParams.get("ticker") || "").toUpperCase().trim();
  const refresh = url.searchParams.get("refresh") === "1";
  if (!ticker) return errorResp("ticker required", 400);
  const cacheKey = `run-stats:${ticker}`;
  if (!refresh && env.SCREENER_CACHE) {
    const hit = await env.SCREENER_CACHE.get(cacheKey, "json");
    if (hit) return jsonResp(hit);
  }
  const oneYearAgo = new Date(Date.now() - 366 * 864e5).toISOString().slice(0, 10);
  const dbUrl = `${SUPA_URL}/rest/v1/liquidity_history?ticker=eq.${encodeURIComponent(ticker)}&trading_date=gte.${oneYearAgo}&order=trading_date.asc&select=trading_date,net&limit=400`;
  let rows = [];
  try {
    const resp = await fetch(dbUrl, {
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    if (resp.ok) rows = await resp.json();
    if (!Array.isArray(rows)) rows = [];
  } catch (_) {
  }
  if (rows.length < 20) {
    return jsonResp({ ticker, insufficient_data: true, rows: rows.length });
  }
  let cum = 0;
  const cumPts = rows.map((r) => {
    cum += r.net || 0;
    return cum;
  });
  const runs = rsDetectRuns(cumPts);
  const upDur = runs.filter((r) => r.dir === "up" && r.dur >= 1).map((r) => r.dur);
  const downDur = runs.filter((r) => r.dir === "down" && r.dur >= 1).map((r) => r.dur);
  const result = {
    ticker,
    computed_at: (/* @__PURE__ */ new Date()).toISOString(),
    sample_days: rows.length,
    run_count: runs.length,
    up: rsPercentiles(upDur),
    down: rsPercentiles(downDur)
  };
  if (env.SCREENER_CACHE) {
    await env.SCREENER_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 });
  }
  return jsonResp(result);
}
__name(handleRunStats, "handleRunStats");
function rsDetectRuns(cumPts) {
  const runs = [];
  if (cumPts.length < 2) return runs;
  let start = 0;
  let dir = cumPts[1] >= cumPts[0] ? "up" : "down";
  for (let i = 2; i < cumPts.length - 1; i++) {
    const cur = cumPts[i] >= cumPts[i - 1] ? "up" : "down";
    if (cur !== dir) {
      runs.push({ dir, dur: i - 1 - start });
      start = i - 1;
      dir = cur;
    }
  }
  if (cumPts.length - 2 > start) {
    runs.push({ dir, dur: cumPts.length - 2 - start });
  }
  return runs;
}
__name(rsDetectRuns, "rsDetectRuns");
function rsPercentiles(durations) {
  if (!durations.length) return { p25: null, p50: null, p75: null, count: 0 };
  const s = [...durations].sort((a, b) => a - b);
  const n = s.length;
  const p = /* @__PURE__ */ __name((q) => s[Math.round(q * (n - 1))], "p");
  return { p25: p(0.25), p50: p(0.5), p75: p(0.75), mean: Math.round(s.reduce((a, b) => a + b, 0) / n), count: n };
}
__name(rsPercentiles, "rsPercentiles");
async function handlePolygon(request, env, url) {
  const POLY_KEY = env.POLYGON_KEY;
  if (!POLY_KEY) return errorResp("Polygon API key not configured", 500);
  const polyPath = url.pathname.replace("/api/polygon", "");
  const polyParams = new URLSearchParams(url.search);
  polyParams.set("apiKey", POLY_KEY);
  const polyUrl = `https://api.polygon.io${polyPath}?${polyParams.toString()}`;
  try {
    const resp = await fetch(polyUrl, {
      method: request.method,
      headers: { "User-Agent": "StockVizor/1.0" }
    });
    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
        ...CORS_HEADERS
      }
    });
  } catch (e) {
    console.error("[Polygon]", e);
    return errorResp("Data service error", 502);
  }
}
__name(handlePolygon, "handlePolygon");
async function handleStrategies(request, env, url) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_KEY = env.SUPABASE_ANON_KEY;
  if (!SUPA_URL || !SUPA_KEY) return errorResp("Service not configured", 503);
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return errorResp("Unauthorized", 401);
  let userId;
  try {
    const r = await fetch(`${SUPA_URL}/auth/v1/user`, {
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return errorResp("Unauthorized", 401);
    userId = (await r.json())?.id;
    if (!userId) return errorResp("Unauthorized", 401);
  } catch {
    return errorResp("Auth error", 500);
  }
  const TABLE = "user_backtest_strategies";
  const supaHeaders = {
    apikey: SUPA_KEY,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
  if (request.method === "GET" && url.pathname === "/api/strategies") {
    const r = await fetch(
      `${SUPA_URL}/rest/v1/${TABLE}?user_id=eq.${encodeURIComponent(userId)}&order=updated_at.desc`,
      { headers: supaHeaders }
    );
    const rows = await r.json().catch(() => []);
    return jsonResp({ strategies: Array.isArray(rows) ? rows : [] });
  }
  if (request.method === "POST" && url.pathname === "/api/strategies") {
    const body = await request.json().catch(() => null);
    if (!body) return errorResp("Bad request", 400);
    const payload = {
      user_id: userId,
      name: body.name || "Unnamed Strategy",
      scope_type: body.scope_type || "ticker",
      scope_value: body.scope_value || null,
      strategy_json: body.strategy_json || {},
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    const r = await fetch(`${SUPA_URL}/rest/v1/${TABLE}`, {
      method: "POST",
      headers: { ...supaHeaders, Prefer: "return=representation" },
      body: JSON.stringify(payload)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return errorResp(data?.message || "Save failed", r.status);
    return jsonResp({ strategy: Array.isArray(data) ? data[0] : data });
  }
  const idMatch = url.pathname.match(/^\/api\/strategies\/([^/]+)$/);
  if (request.method === "DELETE" && idMatch) {
    const id = idMatch[1];
    const r = await fetch(
      `${SUPA_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`,
      { method: "DELETE", headers: supaHeaders }
    );
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      return errorResp(data?.message || "Delete failed", r.status);
    }
    return jsonResp({ deleted: true });
  }
  return errorResp("Not found", 404);
}
__name(handleStrategies, "handleStrategies");
var _DB_ALIASES = {
  wl: "user_watchlists",
  pos: "user_positions",
  vizai_usage: "vizai_usage",
  vizintelligence_usage: "vizintelligence_usage",
  sector_rotation_daily: "sector_rotation_daily",
  sector_rotation_history: "sector_rotation_history",
  sector_rotation_stock_flow_aggregate: "sector_rotation_stock_flow_aggregate",
  sector_rotation_subsector: "sector_rotation_subsector",
  sector_rotation_constituents: "sector_rotation_constituents",
  sector_rotation_narrative: "sector_rotation_narrative"
};
async function handleSupabaseDB(request, env, url) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_KEY = env.SUPABASE_ANON_KEY;
  if (!SUPA_URL || !SUPA_KEY) return errorResp("Service not configured", 503);
  const alias = url.pathname.replace("/api/db/", "").split("?")[0].split("/")[0];
  const realTable = _DB_ALIASES[alias];
  if (!realTable) return errorResp("Not found", 404);
  const supaUrl = `${SUPA_URL}/rest/v1/${realTable}${url.search}`;
  const authHeader = request.headers.get("Authorization") || `Bearer ${SUPA_KEY}`;
  const preferHeader = request.headers.get("Prefer") || "";
  const headers = {
    "apikey": SUPA_KEY,
    "Authorization": authHeader,
    "Content-Type": "application/json"
  };
  if (preferHeader) headers["Prefer"] = preferHeader;
  try {
    const resp = await fetch(supaUrl, {
      method: request.method,
      headers,
      body: request.method !== "GET" ? await request.text() : void 0
    });
    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS
      }
    });
  } catch {
    console.error("[DB proxy] fetch error");
    return errorResp("Service error", 502);
  }
}
__name(handleSupabaseDB, "handleSupabaseDB");
var POLY_BASE = "https://api.polygon.io";
var PHASE2_COLS = /* @__PURE__ */ new Set(["rsi", "macd_h", "sma50", "sma200", "ema9", "ema20", "ema50"]);
function polyIndicatorUrl(col, ticker, apiKey) {
  const tk = encodeURIComponent(ticker);
  switch (col) {
    case "rsi":
      return `${POLY_BASE}/v1/indicators/rsi/${tk}?timespan=day&window=14&series_type=close&order=desc&limit=1&apiKey=${apiKey}`;
    case "macd_h":
      return `${POLY_BASE}/v1/indicators/macd/${tk}?timespan=day&short_window=12&long_window=26&signal_window=9&series_type=close&order=desc&limit=1&apiKey=${apiKey}`;
    case "sma50":
      return `${POLY_BASE}/v1/indicators/sma/${tk}?timespan=day&window=50&series_type=close&order=desc&limit=1&apiKey=${apiKey}`;
    case "sma200":
      return `${POLY_BASE}/v1/indicators/sma/${tk}?timespan=day&window=200&series_type=close&order=desc&limit=1&apiKey=${apiKey}`;
    case "ema9":
      return `${POLY_BASE}/v1/indicators/ema/${tk}?timespan=day&window=9&series_type=close&order=desc&limit=1&apiKey=${apiKey}`;
    case "ema20":
      return `${POLY_BASE}/v1/indicators/ema/${tk}?timespan=day&window=20&series_type=close&order=desc&limit=1&apiKey=${apiKey}`;
    case "ema50":
      return `${POLY_BASE}/v1/indicators/ema/${tk}?timespan=day&window=50&series_type=close&order=desc&limit=1&apiKey=${apiKey}`;
    default:
      return null;
  }
}
__name(polyIndicatorUrl, "polyIndicatorUrl");
function parsePolyIndicator(col, json) {
  if (!json || json.status === "ERROR") return null;
  if (col === "macd_h") return json?.results?.values?.[0]?.histogram ?? null;
  return json?.results?.values?.[0]?.value ?? null;
}
__name(parsePolyIndicator, "parsePolyIndicator");
async function supaUpsert(supaUrl, supaKey, table, rows) {
  if (!supaUrl || !supaKey || !rows.length) return false;
  try {
    const r = await fetch(`${supaUrl}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: supaKey,
        Authorization: `Bearer ${supaKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates"
      },
      body: JSON.stringify(rows)
    });
    return r.ok;
  } catch {
    return false;
  }
}
__name(supaUpsert, "supaUpsert");
async function enrichMissingIndicators(tickers, cols, tradingDate, polyKey, supaUrl, supaKey) {
  if (!tickers.length || !cols.length || !polyKey) return {};
  const MAX_TICKERS = 40;
  const CONCURRENCY = 10;
  const safeList = tickers.slice(0, MAX_TICKERS);
  const resultMap = {};
  const tasks = [];
  for (const tk of safeList) for (const col of cols) tasks.push({ tk, col });
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async ({ tk, col }) => {
        const url = polyIndicatorUrl(col, tk, polyKey);
        if (!url) return { tk, col, val: null };
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(8e3) });
          if (!r.ok) return { tk, col, val: null };
          const d = await r.json();
          return { tk, col, val: parsePolyIndicator(col, d) };
        } catch {
          return { tk, col, val: null };
        }
      })
    );
    for (const res of settled) {
      if (res.status === "fulfilled" && res.value.val !== null) {
        const { tk, col, val } = res.value;
        if (!resultMap[tk]) resultMap[tk] = {};
        resultMap[tk][col] = val;
      }
    }
  }
  const upsertRows = Object.entries(resultMap).map(([ticker, vals]) => ({ ticker, trading_date: tradingDate, ...vals }));
  const CHUNK = 50;
  for (let i = 0; i < upsertRows.length; i += CHUNK) {
    await supaUpsert(supaUrl, supaKey, "ta_cache", upsertRows.slice(i, i + CHUNK));
  }
  return resultMap;
}
__name(enrichMissingIndicators, "enrichMissingIndicators");
async function handleVizardis(request, env, url) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
  const rest = url.pathname.slice("/api/vizardis/".length);
  if (rest === "signals") {
    const ticker = url.searchParams.get("ticker");
    const combo_id = url.searchParams.get("combo_id");
    const context_key = url.searchParams.get("context_key");
    const horizon_days = url.searchParams.get("horizon_days");
    if (!ticker || !combo_id) return errorResp("ticker and combo_id required", 400);
    let qp = `ticker=eq.${encodeURIComponent(ticker)}&combo_id=eq.${encodeURIComponent(combo_id)}&asset_level=eq.stock&select=signal_date,return_pct,entry_price,exit_price,tier1_pass,context_key&order=signal_date.asc&limit=2000`;
    if (context_key) {
      const seg = context_key.split("|")[0].trim();
      qp += `&context_key=ilike.*${encodeURIComponent(seg)}*`;
    }
    if (horizon_days) qp += `&horizon_days=eq.${encodeURIComponent(horizon_days)}`;
    const rows = await supaFetch(SUPA_URL, SUPA_KEY, "vizardis_backtest_results", qp);
    return jsonResp({ signals: rows || [] });
  }
  if (rest === "screener") {
    const combo_id = url.searchParams.get("combo_id");
    const context_key = url.searchParams.get("context_key");
    const horizon_days = url.searchParams.get("horizon_days");
    const min_win_rate = Math.max(0, Math.min(1, parseFloat(url.searchParams.get("min_win_rate") || "0.55")));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "60", 10)));
    if (!combo_id) return errorResp("combo_id required", 400);
    const firstSeg = context_key ? context_key.split("|")[0].trim() : null;
    let hp = `combo_id=eq.${encodeURIComponent(combo_id)}&win_rate=gte.${min_win_rate}&sample_count=gte.5&order=win_rate.desc.nullslast&limit=100&select=ticker,win_rate,avg_return,confidence_score,sample_count`;
    if (firstSeg) hp += `&context_key=ilike.*${encodeURIComponent(firstSeg)}*`;
    if (horizon_days) hp += `&horizon_days=eq.${encodeURIComponent(horizon_days)}`;
    const hRows = await supaFetch(SUPA_URL, SUPA_KEY, "vizardis_heuristics", hp);
    if (!hRows || !hRows.length) return jsonResp({ results: [], as_of: null });
    const vzMap = /* @__PURE__ */ new Map();
    for (const h of hRows) {
      if (!vzMap.has(h.ticker)) {
        vzMap.set(h.ticker, {
          win_rate: h.win_rate,
          avg_return: h.avg_return,
          confidence_score: h.confidence_score,
          sample_count: h.sample_count
        });
      }
    }
    const tickers = [...vzMap.keys()].slice(0, limit);
    const dtRows = await supaFetch(
      SUPA_URL,
      SUPA_KEY,
      "ta_cache",
      "select=trading_date&order=trading_date.desc&limit=1"
    );
    const latestDt = dtRows?.[0]?.trading_date ?? null;
    let taRows = [];
    if (latestDt && tickers.length) {
      const ta = await supaFetch(
        SUPA_URL,
        SUPA_KEY,
        "ta_cache",
        `ticker=in.(${tickers.join(",")})&trading_date=eq.${latestDt}&select=ticker,price,change_pct,rsi,macd_h,pct_sma20,sma50,sma200,adx14,vol_ratio,sector,regime`
      );
      if (ta) taRows = ta;
    }
    const taMap = /* @__PURE__ */ new Map();
    for (const t of taRows) taMap.set(t.ticker, t);
    const isSell = (context_key || "").toLowerCase().includes("bear");
    const results = tickers.map((tk) => {
      const vz = vzMap.get(tk) || {};
      const ta = taMap.get(tk) || {};
      const wr = Number(vz.win_rate || 0);
      return {
        ticker: tk,
        name: wr >= 0.7 ? "VZD \u2605\u2605" : wr >= 0.65 ? "VZD \u2605" : "VZD",
        price: ta.price ?? null,
        change_pct: ta.change_pct ?? null,
        rsi: ta.rsi ?? null,
        pct_sma20: ta.pct_sma20 ?? null,
        sma200: ta.sma200 ?? null,
        vol_ratio: ta.vol_ratio ?? null,
        macd_h: ta.macd_h ?? null,
        adx14: ta.adx14 ?? null,
        sector: ta.sector ?? null,
        regime: ta.regime ?? null,
        signal_bias: isSell ? "Bearish" : "Bullish",
        // VZD metadata — available for client-side filtering
        _vzd_win_rate: vz.win_rate,
        _vzd_avg_return: vz.avg_return,
        _vzd_confidence: vz.confidence_score,
        _vzd_samples: vz.sample_count
      };
    });
    return jsonResp({ results, as_of: latestDt });
  }
  if (rest === "strategies") {
    const context_key = url.searchParams.get("context_key");
    const ticker = url.searchParams.get("ticker");
    const horizon_days = url.searchParams.get("horizon_days");
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
    const SORTABLE = /* @__PURE__ */ new Set(["win_rate_pct", "avg_return_pct", "avg_sharpe", "confidence_score", "sample_count"]);
    const sort = SORTABLE.has(url.searchParams.get("sort") || "") ? url.searchParams.get("sort") : "win_rate_pct";
    let qp = `order=${sort}.desc.nullslast,confidence_score.desc.nullslast&limit=${limit}&sample_count=gte.5`;
    if (ticker) qp += `&ticker=eq.${encodeURIComponent(ticker)}`;
    if (context_key) {
      const enc = encodeURIComponent(context_key);
      const short = context_key.replace(/\bbullish\b/gi, "bull").replace(/\bbearish\b/gi, "bear");
      if (short !== context_key) {
        const encS = encodeURIComponent(short);
        qp += `&or=(context_key.ilike.*${enc}*,context_key.ilike.*${encS}*)`;
      } else {
        qp += `&context_key=ilike.*${enc}*`;
      }
    }
    if (horizon_days) qp += `&horizon_days=eq.${encodeURIComponent(horizon_days)}`;
    const rows = await supaFetch(SUPA_URL, SUPA_KEY, "vizardis_top_strategies", qp);
    const seen = /* @__PURE__ */ new Map();
    for (const row of rows || []) {
      const key = `${row.ticker}|${row.combo_id}`;
      const isClean = !row.context_key?.split("|").some((s) => s.trim().startsWith("unknown"));
      const prev = seen.get(key);
      if (!prev || isClean && !prev._isClean) {
        row._isClean = isClean;
        seen.set(key, row);
      }
    }
    const deduped = Array.from(seen.values()).map((r) => {
      delete r._isClean;
      return r;
    });
    return jsonResp({ strategies: deduped });
  }
  if (rest.startsWith("user/")) {
    const SUPA_ANON = env.SUPABASE_ANON_KEY || SUPA_KEY;
    const action = rest.slice("user/".length);
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return errorResp("Unauthorized", 401);
    let userId;
    try {
      const userResp = await fetch(`${SUPA_URL}/auth/v1/user`, {
        headers: { apikey: SUPA_ANON, Authorization: `Bearer ${token}` }
      });
      if (!userResp.ok) return errorResp("Unauthorized", 401);
      const userData = await userResp.json();
      userId = userData?.id;
      if (!userId) return errorResp("Unauthorized", 401);
    } catch {
      return errorResp("Auth error", 500);
    }
    const TENANT = "stockvizor";
    const COLS = "id,label,strategy_type,ticker,combo_id,context_key,horizon_days,win_rate_pct,avg_return_pct,avg_sharpe,confidence_score,sample_count,strategy_description,created_at,shape,signal_direction";
    const baseQP = `tenant_id=eq.${TENANT}&user_id=eq.${encodeURIComponent(userId)}&order=created_at.asc`;
    if (action === "signals" && request.method === "GET") {
      const rows = await supaFetch(
        SUPA_URL,
        SUPA_KEY,
        "vizardis_pinned_strategies",
        `${baseQP}&strategy_type=in.(signal,buy_signal,sell_signal)&select=${COLS}`
      );
      return jsonResp({ signals: rows || [] });
    }
    if (action === "indicators" && request.method === "GET") {
      const rows = await supaFetch(
        SUPA_URL,
        SUPA_KEY,
        "vizardis_pinned_strategies",
        `${baseQP}&strategy_type=not.in.(signal,buy_signal,sell_signal,screener)&select=${COLS}`
      );
      return jsonResp({ indicators: rows || [] });
    }
    if (action === "screeners" && request.method === "GET") {
      const rows = await supaFetch(
        SUPA_URL,
        SUPA_KEY,
        "vizardis_pinned_strategies",
        `${baseQP}&strategy_type=eq.screener&select=${COLS}`
      );
      return jsonResp({ screeners: rows || [] });
    }
    if (action === "label" && request.method === "PATCH") {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResp("Invalid JSON", 400);
      }
      const { id, label } = body;
      if (!id || label === void 0) return errorResp("id and label required", 400);
      const trimmed = String(label).trim().slice(0, 200);
      if (!trimmed) return errorResp("Label cannot be empty", 400);
      const res = await fetch(
        `${SUPA_URL}/rest/v1/vizardis_pinned_strategies?id=eq.${encodeURIComponent(id)}&tenant_id=eq.${TENANT}&user_id=eq.${encodeURIComponent(userId)}`,
        {
          method: "PATCH",
          headers: {
            apikey: SUPA_KEY,
            Authorization: `Bearer ${SUPA_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal"
          },
          body: JSON.stringify({ label: trimmed })
        }
      );
      if (!res.ok) return errorResp("Update failed", 500);
      return jsonResp({ ok: true });
    }
    if (action === "shape" && request.method === "PATCH") {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResp("Invalid JSON", 400);
      }
      const { id, shape } = body;
      if (!id || shape === void 0) return errorResp("id and shape required", 400);
      const VALID_SHAPES = /* @__PURE__ */ new Set(["circle", "diamond", "square", "pentagon", "hexagon", "shield", "star", "triangle"]);
      if (shape !== "" && !VALID_SHAPES.has(shape)) return errorResp("Invalid shape", 400);
      const res = await fetch(
        `${SUPA_URL}/rest/v1/vizardis_pinned_strategies?id=eq.${encodeURIComponent(id)}&tenant_id=eq.${TENANT}&user_id=eq.${encodeURIComponent(userId)}`,
        {
          method: "PATCH",
          headers: {
            apikey: SUPA_KEY,
            Authorization: `Bearer ${SUPA_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal"
          },
          body: JSON.stringify({ shape: shape || null })
        }
      );
      if (!res.ok) return errorResp("Update failed", 500);
      return jsonResp({ ok: true });
    }
    if (action === "item" && request.method === "DELETE") {
      let id;
      try {
        const b = await request.json();
        id = b.id;
      } catch {
        return errorResp("Invalid JSON", 400);
      }
      if (!id) return errorResp("id required", 400);
      const res = await fetch(
        `${SUPA_URL}/rest/v1/vizardis_pinned_strategies?id=eq.${encodeURIComponent(id)}&tenant_id=eq.${TENANT}&user_id=eq.${encodeURIComponent(userId)}`,
        {
          method: "DELETE",
          headers: {
            apikey: SUPA_KEY,
            Authorization: `Bearer ${SUPA_KEY}`,
            Prefer: "return=minimal"
          }
        }
      );
      if (!res.ok) return errorResp("Delete failed", 500);
      return jsonResp({ ok: true });
    }
    return errorResp("Unknown user route", 404);
  }
  if (rest === "ticker-settings" && request.method === "GET") {
    const ticker = url.searchParams.get("ticker")?.toUpperCase()?.trim();
    const useCase = url.searchParams.get("use_case");
    if (!ticker) return errorResp("ticker required", 400);
    let qp = `ticker=eq.${encodeURIComponent(ticker)}&select=use_case,indicator_name,params,win_rate_pct,sample_count,confidence_tier,applied_at&order=use_case.asc,win_rate_pct.desc`;
    if (useCase) qp += `&use_case=eq.${encodeURIComponent(useCase)}`;
    const rows = await supaFetch(SUPA_URL, SUPA_KEY, "vizardis_indicator_settings", qp);
    return jsonResp({ ticker, settings: rows || [] });
  }
  if (rest === "pair-markers" && request.method === "GET") {
    const ticker = url.searchParams.get("ticker")?.toUpperCase()?.trim();
    const TENANT_ID = "stockvizor";
    if (!ticker) return errorResp("ticker required", 400);
    const published = await supaFetch(
      SUPA_URL,
      SUPA_KEY,
      "vizardis_published_pairs",
      `ticker=eq.${encodeURIComponent(ticker)}&tenant_id=eq.${encodeURIComponent(TENANT_ID)}&select=pair_id,buy_strategy,sell_strategy,win_rate_pct,profit_factor,expected_value,cycle_count,avg_holding_days,stop_loss_pct,max_hold_days,approved_at,published_at`
    );
    if (!published || !published.length) return jsonResp({ ticker, pairs: [] });
    const pairIds = published.map((p) => p.pair_id).join(",");
    const [allCycles, livePositions] = await Promise.all([
      supaFetch(
        SUPA_URL,
        SUPA_KEY,
        "vizardis_pair_results",
        `pair_id=in.(${pairIds})&select=pair_id,entry_date,exit_date,exit_reason,return_pct&order=entry_date.asc&limit=500`
      ),
      supaFetch(
        SUPA_URL,
        SUPA_KEY,
        "vizardis_live_positions",
        `pair_id=in.(${pairIds})&status=eq.open&select=pair_id,entry_date,entry_price,current_return_pct,current_holding_days`
      )
    ]);
    const cycleMap = {};
    for (const c of allCycles || []) {
      if (!cycleMap[c.pair_id]) cycleMap[c.pair_id] = [];
      cycleMap[c.pair_id].push(c);
    }
    const liveMap = Object.fromEntries((livePositions || []).map((l) => [l.pair_id, l]));
    const pairs = published.map((p) => ({
      ...p,
      live_position: liveMap[p.pair_id] ?? null,
      cycles: cycleMap[p.pair_id] ?? []
    }));
    return jsonResp({ ticker, pairs });
  }
  return errorResp("Unknown vizardis route", 404);
}
__name(handleVizardis, "handleVizardis");
var ScreenerCoordinator = class {
  static {
    __name(this, "ScreenerCoordinator");
  }
  constructor(state, env) {
    this.env = env;
    this.cache = null;
    this.pending = null;
  }
  async fetch(request) {
    const url = new URL(request.url);
    const stratId = url.searchParams.get("strategy");
    const universe = url.searchParams.get("type") || "stocks";
    const cacheKey = `screener:v1:${stratId}:${universe}`;
    if (this.cache && Date.now() < this.cache.expiresAt) {
      return new Response(JSON.stringify({ ...this.cache.payload, _cached: true }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }
    if (this.pending) {
      try {
        const payload = await this.pending;
        return new Response(JSON.stringify({ ...payload, _cached: true }), {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Service error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
    let resolve, reject;
    this.pending = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    try {
      let payload = this.env.SCREENER_CACHE ? await this.env.SCREENER_CACHE.get(cacheKey, "json") : null;
      if (!payload) {
        payload = await runScreener(stratId, universe, this.env);
        if (this.env.SCREENER_CACHE) {
          this.env.SCREENER_CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 300 });
        }
      }
      this.cache = { payload, expiresAt: Date.now() + 5 * 60 * 1e3 };
      this.pending = null;
      resolve(payload);
      return new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    } catch (e) {
      this.pending = null;
      reject(e);
      return new Response(JSON.stringify({ error: "Service error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};
async function runScreener(stratId, universe, env) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_KEY = env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
  const POLY_KEY = env.POLYGON_KEY;
  const strat = SCREENER_STRATEGIES[stratId];
  let latestDate, prevDate;
  const batchRows = await supaFetch(
    SUPA_URL,
    SUPA_KEY,
    "batch_state",
    "select=trading_date&status=eq.complete&order=trading_date.desc&limit=2"
  );
  if (batchRows && batchRows[0]) {
    latestDate = batchRows[0].trading_date;
    prevDate = batchRows[1] ? batchRows[1].trading_date : null;
  } else {
    const dateRows = await supaFetch(
      SUPA_URL,
      SUPA_KEY,
      "ta_cache",
      "select=trading_date&order=trading_date.desc&limit=2"
    );
    if (!dateRows || !dateRows[0]) throw new Error("No TA data available");
    latestDate = dateRows[0].trading_date;
    prevDate = dateRows[1] ? dateRows[1].trading_date : null;
  }
  const SPECIAL_NEEDS = {
    golden_cross: ["sma50", "sma200"],
    death_cross: ["sma50", "sma200"],
    ema_stack_bull: ["ema9"],
    ema_stack_bear: ["ema9"],
    ema_macd_bull: ["ema9"],
    minervini_lite: ["rsi"],
    above_200ma: ["rsi"],
    below_200ma: ["sma200"],
    pullback_50ma: ["sma50"]
  };
  const sp = strat.ta.__special;
  const stratColNames = Object.keys(strat.ta).filter((k) => !k.startsWith("__")).map((k) => {
    for (const sfx of ["_gte", "_lte", "_gt", "_lt", "_eq"]) {
      if (k.endsWith(sfx)) return k.slice(0, -sfx.length);
    }
    return null;
  }).filter(Boolean);
  const enrichNeeds = [.../* @__PURE__ */ new Set([
    ...stratColNames.filter((c) => PHASE2_COLS.has(c)),
    ...sp && SPECIAL_NEEDS[sp] ? SPECIAL_NEEDS[sp] : []
  ])];
  const PHASE1_ONLY_COLS = /* @__PURE__ */ new Set(["pct_sma20", "pct_sma50", "sma20"]);
  const needsPhase1 = stratColNames.some((c) => PHASE1_ONLY_COLS.has(c));
  const needsRsi = enrichNeeds.includes("rsi");
  const needsMacd = enrichNeeds.includes("macd_h");
  const needsAny = enrichNeeds.length > 0;
  if (needsAny && POLY_KEY) {
    const primaryCol = needsRsi ? "rsi" : needsMacd ? "macd_h" : enrichNeeds[0];
    const enrichQuery = buildEnrichCandidateQuery(strat.ta, latestDate, primaryCol);
    const nullRows = await supaFetch(SUPA_URL, SUPA_KEY, "ta_cache", enrichQuery);
    if (nullRows && nullRows.length > 0) {
      const MAX_ENRICH_COLS = 1;
      await enrichMissingIndicators(
        nullRows.map((r) => r.ticker),
        enrichNeeds.slice(0, MAX_ENRICH_COLS),
        latestDate,
        POLY_KEY,
        SUPA_URL,
        SUPA_KEY
      );
    }
  }
  let taRows;
  if (sp) {
    const dt = latestDate;
    const specials = {
      golden_cross: { pre: `sma50=not.is.null&sma200=not.is.null&trading_date=eq.${dt}&limit=5000`, fn: /* @__PURE__ */ __name((r) => r.sma50 > r.sma200, "fn") },
      death_cross: { pre: `sma50=not.is.null&sma200=not.is.null&trading_date=eq.${dt}&limit=5000`, fn: /* @__PURE__ */ __name((r) => r.sma50 < r.sma200, "fn") },
      ema_stack_bull: { pre: `ema9=not.is.null&ema20=not.is.null&ema50=not.is.null&trading_date=eq.${dt}&limit=5000`, fn: /* @__PURE__ */ __name((r) => r.ema9 > r.ema20 && r.ema20 > r.ema50, "fn") },
      ema_stack_bear: { pre: `ema9=not.is.null&ema20=not.is.null&ema50=not.is.null&trading_date=eq.${dt}&limit=5000`, fn: /* @__PURE__ */ __name((r) => r.ema9 < r.ema20 && r.ema20 < r.ema50, "fn") },
      ema_macd_bull: { pre: `ema9=not.is.null&ema20=not.is.null&ema50=not.is.null&macd_h=gt.0&trading_date=eq.${dt}&limit=5000`, fn: /* @__PURE__ */ __name((r) => r.ema9 > r.ema20 && r.ema20 > r.ema50, "fn") },
      minervini_lite: { pre: `sma50=not.is.null&sma200=not.is.null&adx14=gte.20&rsi=gte.50&trading_date=eq.${dt}&limit=5000`, fn: /* @__PURE__ */ __name((r) => r.price != null && r.price > r.sma50 && r.sma50 > r.sma200, "fn") },
      above_200ma: { pre: `sma200=not.is.null&macd_h=gt.0&rsi=gte.50&trading_date=eq.${dt}&limit=5000`, fn: /* @__PURE__ */ __name((r) => r.price != null && r.price > r.sma200, "fn") },
      below_200ma: { pre: `sma200=not.is.null&macd_h=lt.0&trading_date=eq.${dt}&limit=5000`, fn: /* @__PURE__ */ __name((r) => r.price != null && r.price < r.sma200, "fn") },
      pullback_50ma: {
        pre: `sma50=not.is.null&sma200=not.is.null&trading_date=eq.${dt}&limit=5000`,
        fn: /* @__PURE__ */ __name((r) => {
          if (!r.price || !r.sma50 || !r.sma200) return false;
          const pct = (r.price - r.sma50) / r.sma50 * 100;
          return r.price > r.sma200 && pct >= -5 && pct <= 3;
        }, "fn")
      },
      // Smart Candle state strategies — query pre-computed sc_state from ta_cache
      smart_candle_fresh: { pre: `sc_state=eq.FRESH&trading_date=eq.${dt}&limit=5000`, fn: /* @__PURE__ */ __name((_r) => true, "fn") },
      smart_candle_active: { pre: `sc_state=eq.ACTIVE&trading_date=eq.${dt}&limit=5000`, fn: /* @__PURE__ */ __name((_r) => true, "fn") },
      smart_candle_buy: { pre: `sc_state=in.(FRESH,ACTIVE)&trading_date=eq.${dt}&limit=5000`, fn: /* @__PURE__ */ __name((_r) => true, "fn") },
      smart_candle_all: { pre: `sc_state=in.(FRESH,ACTIVE,WATCH)&trading_date=eq.${dt}&limit=5000`, fn: /* @__PURE__ */ __name((_r) => true, "fn") },
      // Sell signal tests — with B (sc_state=SELL, B is prerequisite) vs without B (sc_sell_raw, pure 3 reds)
      smart_candle_sell: { pre: `sc_state=eq.SELL&trading_date=eq.${dt}&limit=5000`, fn: /* @__PURE__ */ __name((_r) => true, "fn") },
      smart_candle_sell_raw: { pre: `sc_sell_raw=eq.true&trading_date=eq.${dt}&limit=5000`, fn: /* @__PURE__ */ __name((_r) => true, "fn") },
      // Smart RSI Recovery-Cross — pre-computed nightly by ta-batch
      smart_rsi_7: { pre: `smart_rsi7_signal=eq.true&trading_date=eq.${dt}&limit=5000`, fn: /* @__PURE__ */ __name((_r) => true, "fn") },
      smart_rsi_5: { pre: `smart_rsi5_signal=eq.true&trading_date=eq.${dt}&limit=5000`, fn: /* @__PURE__ */ __name((_r) => true, "fn") },
      // VizSignal Watch — older buy signal, lowest conviction tier
      smart_candle_watch: { pre: `sc_state=eq.WATCH&trading_date=eq.${dt}&limit=5000`, fn: /* @__PURE__ */ __name((_r) => true, "fn") },
      // Near 52-Week High — within 5% of trailing 52w high, bullish momentum
      high_52w: {
        pre: `pct_from_52h=gte.-5&pct_from_52h=not.is.null&macd_h=gt.0&trading_date=eq.${dt}&limit=5000`,
        fn: /* @__PURE__ */ __name((_r) => true, "fn")
      },
      // VCP (Volatility Contraction Pattern) — Minervini Stage-2 setup
      // Price ≥ 75% of 52w high, above SMA50 > SMA200, RSI ≥ 50
      vcp: {
        pre: `pct_from_52h=gte.-25&pct_from_52h=not.is.null&sma50=not.is.null&sma200=not.is.null&rsi=gte.50&trading_date=eq.${dt}&limit=5000`,
        fn: /* @__PURE__ */ __name((r) => r.price != null && r.sma50 != null && r.sma200 != null && r.price > r.sma50 && r.sma50 > r.sma200, "fn")
      },
      // Volume Spike — today's volume ≥ 3× 20-day average, price ≥ $5
      vol_spike: {
        pre: `vol_ratio=gte.3&vol_ratio=not.is.null&trading_date=eq.${dt}&limit=5000`,
        fn: /* @__PURE__ */ __name((r) => r.price == null || r.price >= 5, "fn")
      }
    };
    const def = specials[sp];
    if (!def) throw new Error(`Unknown special strategy: ${sp}`);
    taRows = await supaFetch(SUPA_URL, SUPA_KEY, "ta_cache", def.pre);
    if (!taRows) {
      return {
        results: [],
        strategy: strat.name,
        count: 0,
        as_of: latestDate,
        reason: "signal_pending",
        disable: true,
        message: `${strat.name} signals are computed nightly. Check back after market hours.`
      };
    }
    taRows = taRows.filter(def.fn);
    if (taRows.length === 0 && prevDate) {
      const prevPre = def.pre.replace(latestDate, prevDate);
      const prevRows = await supaFetch(SUPA_URL, SUPA_KEY, "ta_cache", prevPre);
      if (prevRows) {
        const prevFiltered = prevRows.filter(def.fn);
        if (prevFiltered.length > 0) {
          taRows = prevFiltered;
          latestDate = prevDate;
        } else {
          return {
            results: [],
            strategy: strat.name,
            count: 0,
            as_of: prevDate,
            reason: "signal_pending",
            disable: true,
            message: `No ${strat.name} signals in the last 2 trading sessions. Signals compute nightly \u2014 check back after market hours.`
          };
        }
      }
    }
  } else {
    const qParams = buildTAQueryParams(strat.ta, latestDate);
    taRows = await supaFetch(SUPA_URL, SUPA_KEY, "ta_cache", qParams);
    if (!taRows) throw new Error("Database error fetching TA rows");
  }
  if (universe === "stocks") {
    taRows = taRows.filter((r) => r.sector && r.sector !== "ETF");
  } else if (universe === "etfs") {
    taRows = taRows.filter((r) => !r.sector || r.sector === "ETF");
  }
  if (!taRows.length) {
    const isPhase2Special = !!sp;
    const isSparseData = isPhase2Special || needsRsi || needsMacd || needsPhase1;
    let reason, message;
    if (isSparseData) {
      let indicatorList;
      if (needsPhase1) {
        indicatorList = "SMA20 and SMA50 stretch data (pct_sma20 / pct_sma50)";
      } else if (sp === "ema_stack_bull" || sp === "ema_stack_bear" || sp === "ema_macd_bull") {
        indicatorList = "EMA 9/20/50 data";
      } else if (sp === "golden_cross" || sp === "death_cross") {
        indicatorList = "SMA 50 and SMA 200 data";
      } else if (sp === "minervini_lite" || sp === "above_200ma" || sp === "below_200ma" || sp === "pullback_50ma") {
        indicatorList = "SMA 50, SMA 200, RSI, and MACD data";
      } else {
        indicatorList = "RSI and MACD data";
      }
      reason = "sparse_data";
      message = `No results yet for "${strat.name}". ${indicatorList} is still being populated by the nightly ta-batch job. The batch fills all 5,000+ tickers overnight and completes before market open. Try again after tonight's batch completes, or run it again in a few minutes \u2014 each run enriches more tickers on demand.`;
    } else {
      reason = "market_conditions";
      message = `No stocks match "${strat.name}" today. All indicator data is present \u2014 current market conditions don't meet this screen's criteria. This screen is intentionally selective. Check back tomorrow or try a related strategy.`;
    }
    return { results: [], strategy: strat.name, count: 0, as_of: latestDate, reason, message };
  }
  const tickers = taRows.map((r) => r.ticker);
  const CHUNK = 150;
  const quoteMap = {};
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const chunk = tickers.slice(i, i + CHUNK);
    const qRows = await supaFetch(
      SUPA_URL,
      SUPA_KEY,
      "quote_cache",
      `symbol=in.(${chunk.join(",")})&select=symbol,last_price,change_abs,change_pct,updated_at`
    );
    if (qRows) for (const q of qRows) quoteMap[q.symbol] = q;
  }
  const _qStale = /* @__PURE__ */ __name((q) => !q.updated_at || Date.now() - new Date(q.updated_at).getTime() > 12 * 36e5, "_qStale");
  const results = taRows.map((r) => {
    const q = quoteMap[r.ticker] || {};
    const stale = _qStale(q);
    const qPrice = !stale && q.last_price != null ? q.last_price : null;
    const rowPrice = qPrice ?? r.price ?? null;
    const sig = computeSignal({
      rsi: r.rsi,
      sma50: r.sma50,
      sma200: r.sma200,
      macd_h: r.macd_h,
      mom5: r.mom5
    }, rowPrice);
    return {
      ticker: r.ticker,
      price: rowPrice,
      change_pct: (!stale ? q.change_pct : null) ?? r.change_pct ?? null,
      change_abs: (!stale ? q.change_abs : null) ?? r.change_abs ?? null,
      rsi: r.rsi ?? null,
      macd_h: r.macd_h ?? null,
      sma20: r.sma20 ?? null,
      pct_sma20: r.pct_sma20 ?? null,
      sma50: r.sma50 ?? null,
      pct_sma50: r.pct_sma50 ?? null,
      sma200: r.sma200 ?? null,
      adx14: r.adx14 ?? null,
      stoch_k: r.stoch_k ?? null,
      mom5: r.mom5 ?? null,
      sector: r.sector ?? null,
      tdf_direction: r.tdf_direction ?? null,
      tdf_progress_pct: r.tdf_progress_pct ?? null,
      signal_bias: sig.bias,
      signal_confluence: sig.confluence,
      vol_ratio: r.vol_ratio ?? null,
      sc_state: r.sc_state ?? null,
      sc_bars_since_b: r.sc_bars_since_b ?? null,
      sc_sell_raw: r.sc_sell_raw ?? null,
      sc_tier: r.sc_state === "FRESH" ? "STRONG BUY" : r.sc_state === "ACTIVE" ? "BUY" : r.sc_state === "WATCH" ? "WEAK BUY" : r.sc_state === "SELL" ? "EXIT" : null,
      // ── Signal layer (from ta-batch Phase 1, computed from 200-bar history) ──
      regime: r.regime ?? null,
      bull_div_age: r.bull_div_age ?? 0,
      bear_div_age: r.bear_div_age ?? 0,
      macd_crest18: r.macd_crest18 ?? null,
      macd_depth18: r.macd_depth18 ?? null
    };
  });
  return { results, strategy: strat.name, count: results.length, as_of: latestDate };
}
__name(runScreener, "runScreener");
var SCREENER_STRATEGIES = {
  // ── Momentum (8) ────────────────────────────────────────────────
  rsi_breakout: { name: "RSI Breakout", group: "Momentum", ta: { rsi_gte: 50, rsi_lte: 65, macd_h_gt: 0, adx14_gte: 20 } },
  macd_bullish: { name: "MACD Bullish Cross", group: "Momentum", ta: { macd_h_gt: 0, rsi_gte: 50 } },
  macd_rsi_bull: { name: "MACD + RSI Confluence", group: "Momentum", ta: { macd_h_gt: 0, rsi_gte: 55, adx14_gte: 20 } },
  macd_bearish: { name: "MACD Bearish Cross", group: "Momentum", ta: { macd_h_lt: 0, rsi_lte: 50 } },
  strong_trend: { name: "Strong Trend", group: "Momentum", ta: { adx14_gte: 30, rsi_gte: 50 } },
  bullish_momentum: { name: "Bullish Momentum", group: "Momentum", ta: { rsi_gte: 60, adx14_gte: 25, mom5_gt: 0 } },
  power_breakout: { name: "Power Breakout", group: "Momentum", ta: { rsi_gte: 55, macd_h_gt: 0, adx14_gte: 25, stoch_k_gte: 50 } },
  ema_macd_bull: { name: "EMA Stack + MACD", group: "Momentum", ta: { __special: "ema_macd_bull" } },
  // ── Mean Reversion (9) ───────────────────────────────────────────
  // OB+ / OB regime presets — validated by backtest (regime_extended.py, 2022-2025)
  // Bull: SMA20-anchored (touches first 91.6% of the time; MRT median 14-17 bars)
  //   OB+ Bull: RSI>=78 AND >12% above SMA20 → acc@20d=63%, avg=+5.0%  N=262
  //   OB Bull:  RSI>=70 AND >5%  above SMA20 → acc@20d=58%, avg=+1.8%  N=2913
  // Bear: SMA50-anchored (sustained dislocation; MRT median 11-12 bars)
  //   OB Bear:  RSI<=30 AND >7%  below SMA50 → 100% revert, median 11 bars
  //   OB+ Bear: RSI<=22 AND >15% below SMA50 → acc@20d=77%, avg=+6.9%  N=183
  ob_plus_bull: { name: "OB+ Bull (Overextended)", group: "Mean Reversion", ta: { rsi_gte: 78, pct_sma20_gte: 12 } },
  ob_bull: { name: "OB Bull (Overbought)", group: "Mean Reversion", ta: { rsi_gte: 70, pct_sma20_gte: 5 } },
  ob_plus_bear: { name: "OB+ Bear (Overextended)", group: "Mean Reversion", ta: { rsi_lte: 22, pct_sma50_lte: -15 } },
  ob_bear: { name: "OB Bear (Oversold)", group: "Mean Reversion", ta: { rsi_lte: 30, pct_sma50_lte: -7 } },
  oversold_bounce: { name: "Oversold Bounce", group: "Mean Reversion", ta: { rsi_lte: 35, stoch_k_lte: 25 } },
  deep_oversold: { name: "Deep Oversold", group: "Mean Reversion", ta: { rsi_lte: 25 } },
  stoch_oversold: { name: "Stoch Oversold", group: "Mean Reversion", ta: { stoch_k_lte: 20, rsi_lte: 45 } },
  rsi_recovery: { name: "RSI Recovery", group: "Mean Reversion", ta: { rsi_gte: 35, rsi_lte: 50, macd_h_gt: 0 } },
  overbought: { name: "Overbought Alert", group: "Mean Reversion", ta: { rsi_gte: 70, stoch_k_gte: 75 } },
  // ── Trend Following (11) ─────────────────────────────────────────
  // Pair: Golden / Death Cross — SMA50 vs SMA200
  golden_cross: { name: "Golden Cross", group: "Trend Following", ta: { __special: "golden_cross" } },
  death_cross: { name: "Death Cross", group: "Trend Following", ta: { __special: "death_cross" } },
  // Pair: EMA Stack alignment — 9 / 20 / 50 all pointing same direction
  ema_stack_bull: { name: "EMA Stack Bull", group: "Trend Following", ta: { __special: "ema_stack_bull" } },
  ema_stack_bear: { name: "EMA Stack Bear", group: "Trend Following", ta: { __special: "ema_stack_bear" } },
  // Minervini Trend Template (simplified): price > SMA50 > SMA200, ADX > 20, RSI > 50
  minervini_lite: { name: "Trend Template", group: "Trend Following", ta: { __special: "minervini_lite" } },
  // 200 MA filters
  above_200ma: { name: "Above 200 MA", group: "Trend Following", ta: { __special: "above_200ma" } },
  below_200ma: { name: "200 MA Breakdown", group: "Trend Following", ta: { __special: "below_200ma" } },
  // Uptrend pullback to 50 MA (classic re-entry): price > SMA200, within ±5% of SMA50
  pullback_50ma: { name: "Pullback to 50 MA", group: "Trend Following", ta: { __special: "pullback_50ma" } },
  // TDF (Trend Duration Forecast) stages
  tdf_early_up: { name: "Early Uptrend", group: "Trend Following", ta: { tdf_direction_eq: "long", tdf_progress_pct_lte: 40 } },
  tdf_mid_up: { name: "Riding the Trend", group: "Trend Following", ta: { tdf_direction_eq: "long", tdf_progress_pct_gte: 40, tdf_progress_pct_lte: 70 } },
  tdf_late_up: { name: "Trend Completion", group: "Trend Following", ta: { tdf_direction_eq: "long", tdf_progress_pct_gte: 70 } },
  // ── Volatility / Range (6) ───────────────────────────────────────
  low_vol_squeeze: { name: "Volatility Squeeze", group: "Volatility", ta: { adx14_lte: 20, rsi_gte: 40, rsi_lte: 60 } },
  pre_breakout: { name: "Pre-Breakout Coil", group: "Volatility", ta: { adx14_gte: 15, adx14_lte: 25, rsi_gte: 45, rsi_lte: 55 } },
  range_expansion: { name: "Range Expansion", group: "Volatility", ta: { adx14_gte: 40 } },
  high_momentum: { name: "High Momentum", group: "Volatility", ta: { adx14_gte: 35, macd_h_gt: 0 } },
  bb_breakout: { name: "Bollinger Breakout", group: "Volatility", ta: { boll_pos_gte: 88, adx14_gte: 20 } },
  bb_reversal: { name: "BB Lower Band Bounce", group: "Volatility", ta: { boll_pos_lte: 12, rsi_gte: 25, rsi_lte: 40 } },
  // ── VizSignal ★ — StockVizor proprietary B→S swing signal ───────
  // Two-pass: Pass 1 detects pivot troughs (RSI ≤ 46 gate) → B signal.
  //           Pass 2 scans for 3 consecutive red candles after each B → S signal.
  // Backtest (100 stocks, 2022-2025): FRESH 62.7% acc@20d +3.25% avg
  //   ACTIVE 57.1% +1.75%  WATCH 53.2% +1.07%  (clean tier gradient)
  // SELL variants kept internal for position-exit testing only.
  smart_candle_fresh: { name: "VizSignal Fresh \u2605", group: "VizSignal \u2605", ta: { __special: "smart_candle_fresh" } },
  smart_candle_active: { name: "VizSignal Active \u2605", group: "VizSignal \u2605", ta: { __special: "smart_candle_active" } },
  smart_candle_buy: { name: "VizSignal Buy \u2605", group: "VizSignal \u2605", ta: { __special: "smart_candle_buy" } },
  smart_candle_all: { name: "VizSignal All \u2605", group: "VizSignal \u2605", ta: { __special: "smart_candle_all" } },
  smart_candle_sell: { name: "VizSignal Exit \u2605", group: "VizSignal \u2605", ta: { __special: "smart_candle_sell" } },
  smart_candle_sell_raw: { name: "VizSignal Exit Raw \u2605", group: "VizSignal \u2605", ta: { __special: "smart_candle_sell_raw" } },
  // ── Smart RSI — RSI Recovery-Cross premium strategies ────────────────
  // Signal pre-computed nightly by ta-batch: RSI(fast) crosses above RSI(14)
  // AND was oversold (<35) within 3 bars AND RSI(fast) > 35 (no falling knife).
  smart_rsi_7: { name: "Smart RSI** (RSI 7)", group: "Smart RSI", ta: { __special: "smart_rsi_7" } },
  smart_rsi_5: { name: "Smart RSI* (RSI 5)", group: "Smart RSI", ta: { __special: "smart_rsi_5" } },
  // ── VizSignal Watch ──────────────────────────────────────────────────
  smart_candle_watch: { name: "VizSignal Watch", group: "VizSignal \u2605", ta: { __special: "smart_candle_watch" } },
  // ── Breakout / 52-Week High ──────────────────────────────────────────
  high_52w: { name: "Near 52-Week High", group: "Breakout", ta: { __special: "high_52w" } },
  vcp: { name: "VCP (Stage 2)", group: "Breakout", ta: { __special: "vcp" } },
  // ── Volume Spike ─────────────────────────────────────────────────────
  vol_spike: { name: "Volume Spike", group: "Volatility", ta: { __special: "vol_spike" } }
};
function buildTAQueryParams(ta, latestDate) {
  const parts = [`trading_date=eq.${latestDate}`, "limit=2000"];
  const SUFFIXES = ["_gte", "_lte", "_gt", "_lt", "_eq"];
  for (const [key, val] of Object.entries(ta)) {
    if (key.startsWith("__")) continue;
    for (const sfx of SUFFIXES) {
      if (key.endsWith(sfx)) {
        const col = key.slice(0, -sfx.length);
        const op = sfx.slice(1);
        parts.push(`${col}=${op}.${encodeURIComponent(val)}`);
        break;
      }
    }
  }
  return parts.join("&");
}
__name(buildTAQueryParams, "buildTAQueryParams");
var MAX_ENRICH_TICKERS = 40;
function buildEnrichCandidateQuery(ta, latestDate, missingCol) {
  const parts = [
    `trading_date=eq.${latestDate}`,
    `${missingCol}=is.null`,
    "select=ticker,adx14",
    "order=adx14.desc.nullslast",
    `limit=${MAX_ENRICH_TICKERS}`
  ];
  const SUFFIXES = ["_gte", "_lte", "_gt", "_lt", "_eq"];
  for (const [key, val] of Object.entries(ta)) {
    if (key.startsWith("__")) continue;
    for (const sfx of SUFFIXES) {
      if (key.endsWith(sfx)) {
        const col = key.slice(0, -sfx.length);
        if (col === missingCol) break;
        const op = sfx.slice(1);
        parts.push(`${col}=${op}.${encodeURIComponent(val)}`);
        break;
      }
    }
  }
  return parts.join("&");
}
__name(buildEnrichCandidateQuery, "buildEnrichCandidateQuery");
async function handleScreener(request, env, url, ctx) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_KEY = env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
  const POLY_KEY = env.POLYGON_KEY;
  const rest = url.pathname.slice("/api/screener/".length);
  if (rest === "strategies") {
    const grouped = {};
    for (const [id, s] of Object.entries(SCREENER_STRATEGIES)) {
      if (!grouped[s.group]) grouped[s.group] = [];
      grouped[s.group].push({ id, name: s.name });
    }
    return jsonResp({ groups: grouped });
  }
  if (rest === "run") {
    const stratId = url.searchParams.get("strategy");
    const universe = url.searchParams.get("type") || "stocks";
    if (!stratId || !SCREENER_STRATEGIES[stratId]) {
      return errorResp("Unknown or missing strategy", 400);
    }
    const doId = env.SCREENER_DO.idFromName(`${stratId}:${universe}`);
    const doStub = env.SCREENER_DO.get(doId);
    return doStub.fetch(
      new Request(`https://screener-do/run?strategy=${stratId}&type=${universe}`)
    );
  }
  return errorResp("Unknown screener route", 404);
}
__name(handleScreener, "handleScreener");
async function supaFetch(supaUrl, supaKey, table, qParams) {
  if (!supaUrl || !supaKey) return null;
  try {
    const r = await fetch(`${supaUrl}/rest/v1/${table}?${qParams}`, {
      headers: {
        apikey: supaKey,
        Authorization: `Bearer ${supaKey}`,
        Accept: "application/json"
      }
    });
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}
__name(supaFetch, "supaFetch");
function computeSignal(ta, price) {
  const indicators = [];
  if (ta.rsi != null) {
    const bull = ta.rsi > 50;
    indicators.push({ bull, label: `RSI ${ta.rsi.toFixed(0)} ${bull ? "above" : "below"} 50` });
  }
  if (ta.sma50 != null && price != null) {
    const bull = price > ta.sma50;
    indicators.push({ bull, label: bull ? "Price above 50-day SMA" : "Price below 50-day SMA" });
  }
  if (ta.sma200 != null && price != null) {
    const bull = price > ta.sma200;
    indicators.push({ bull, label: bull ? "Above 200-day moving average" : "Below 200-day moving average" });
  }
  if (ta.macd_h != null) {
    const bull = ta.macd_h > 0;
    indicators.push({ bull, label: bull ? "MACD momentum positive" : "MACD momentum negative" });
  }
  if (ta.mom5 != null) {
    const bull = ta.mom5 > 0;
    indicators.push({ bull, label: bull ? "5-day momentum rising" : "5-day momentum falling" });
  }
  const outOf = Math.min(indicators.length, 5);
  if (outOf === 0) return { bias: "Neutral", confluence: 0, outOf: 5, factors: [] };
  const bullCount = indicators.filter((i) => i.bull).length;
  const bearCount = outOf - bullCount;
  let bias, confluence;
  if (bullCount > bearCount) {
    bias = "Bullish";
    confluence = bullCount;
    indicators.sort((a, b) => (b.bull ? 1 : 0) - (a.bull ? 1 : 0));
  } else if (bearCount > bullCount) {
    bias = "Bearish";
    confluence = bearCount;
    indicators.sort((a, b) => (a.bull ? 1 : 0) - (b.bull ? 1 : 0));
  } else {
    bias = "Neutral";
    confluence = bullCount;
  }
  return {
    bias,
    confluence,
    outOf,
    factors: indicators.slice(0, 5).map((i) => i.label)
  };
}
__name(computeSignal, "computeSignal");
function computeBuySignal(ta, pctAboveSma200) {
  if (pctAboveSma200 != null && pctAboveSma200 < 0.55) {
    return { fires: false, reason: "downtrend_filtered", pct_above_sma200: pctAboveSma200 };
  }
  const scActive = ta.sc_state != null && ["FRESH", "ACTIVE", "WATCH"].includes(ta.sc_state);
  const rsiOversold = ta.rsi != null && ta.rsi < 35;
  const rsi2Oversold = ta.rsi2 != null && ta.rsi2 < 10;
  if (scActive || rsiOversold || rsi2Oversold) {
    const parts = [];
    if (scActive) parts.push(`Smart Candle ${ta.sc_state}`);
    if (rsiOversold) parts.push(`RSI14 ${ta.rsi?.toFixed(1)} < 35`);
    if (rsi2Oversold) parts.push(`RSI2 ${ta.rsi2?.toFixed(1)} < 10`);
    return { fires: true, reason: parts.join(" + "), pct_above_sma200: pctAboveSma200 ?? null };
  }
  return { fires: false, reason: "no_condition", pct_above_sma200: pctAboveSma200 ?? null };
}
__name(computeBuySignal, "computeBuySignal");
async function jitFetchAndCacheQuotes(syms, POLY_KEY, SUPA_URL, SUPA_KEY) {
  if (!syms.length || !POLY_KEY || !SUPA_URL || !SUPA_KEY) return {};
  try {
    const polyUrl = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${encodeURIComponent(syms.join(","))}&apiKey=${POLY_KEY}`;
    const pr = await fetch(polyUrl, { headers: { "User-Agent": "StockVizor/1.0" } });
    if (!pr.ok) return {};
    const pj = await pr.json();
    const tickerArr = pj?.tickers ?? [];
    if (!tickerArr.length) return {};
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const result = {};
    const upsertRows = [];
    for (const t of tickerArr) {
      const sym = t.ticker;
      if (!sym) continue;
      const day = t.day ?? {};
      const prev = t.prevDay ?? {};
      const dayHasData = (day.c ?? 0) > 0;
      const last_price = dayHasData ? day.c ?? null : prev.c ?? null;
      const change_abs = dayHasData ? t.todaysChange ?? null : null;
      const change_pct = dayHasData ? t.todaysChangePerc ?? null : null;
      const prev_close = dayHasData ? prev.c ?? null : prev.o ?? null;
      const day_volume = dayHasData && (day.v ?? 0) > 0 ? Math.trunc(Number(day.v)) : null;
      const data_as_of = t.updated ? new Date(Math.floor(t.updated / 1e6)).toISOString() : null;
      result[sym] = { last_price, change_abs, change_pct };
      upsertRows.push({
        symbol: sym,
        asset_class: "stock",
        last_price,
        prev_close,
        change_abs,
        change_pct,
        day_volume,
        day_high: dayHasData ? day.h ?? null : null,
        day_low: dayHasData ? day.l ?? null : null,
        data_source: "jit",
        fetched_at: now,
        data_as_of,
        updated_at: now
      });
    }
    if (upsertRows.length > 0) {
      fetch(`${SUPA_URL}/rest/v1/quote_cache`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPA_KEY,
          "Authorization": `Bearer ${SUPA_KEY}`,
          "Prefer": "resolution=merge-duplicates"
        },
        body: JSON.stringify(upsertRows)
      }).catch(() => {
      });
    }
    return result;
  } catch {
    return {};
  }
}
__name(jitFetchAndCacheQuotes, "jitFetchAndCacheQuotes");
async function handleDashboard(request, env, url) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
  const POLY_KEY = env.POLYGON_KEY;
  const rest = url.pathname.slice("/api/dashboard/".length);
  const seg = rest.split("/");
  if (seg[0] === "ticker" && seg[1]) {
    const sym = decodeURIComponent(seg[1]).toUpperCase();
    const [taRows, qRows, fpRows] = await Promise.all([
      supaFetch(
        SUPA_URL,
        SUPA_KEY,
        "ta_cache",
        `ticker=eq.${encodeURIComponent(sym)}&order=trading_date.desc&limit=1`
      ),
      supaFetch(
        SUPA_URL,
        SUPA_KEY,
        "quote_cache",
        `symbol=eq.${encodeURIComponent(sym)}&limit=1`
      ),
      supaFetch(
        SUPA_URL,
        SUPA_KEY,
        "vizardis_fingerprints",
        `ticker=eq.${encodeURIComponent(sym)}&select=pct_above_sma200&limit=1`
      )
    ]);
    const ta = taRows && taRows[0] || {};
    let q = qRows && qRows[0] || {};
    const fp = fpRows && fpRows[0] || {};
    const qUpdatedMs = q.updated_at ? new Date(q.updated_at).getTime() : 0;
    const qAgeHours = (Date.now() - qUpdatedMs) / 36e5;
    const _jitNeeded = q.change_abs == null || q.change_abs === 0 && q.change_pct === 0 || qAgeHours > 12;
    if (_jitNeeded && POLY_KEY) {
      const fresh = await jitFetchAndCacheQuotes([sym], POLY_KEY, SUPA_URL, SUPA_KEY);
      if (fresh[sym]) {
        q = { ...q, ...fresh[sym] };
      }
    }
    const qStillStale = !q.updated_at || Date.now() - new Date(q.updated_at).getTime() > 12 * 36e5;
    const price = qStillStale || q.last_price == null ? ta.price ?? q.last_price ?? null : q.last_price;
    let news = [];
    if (POLY_KEY) {
      try {
        const nr = await fetch(
          `https://api.polygon.io/v2/reference/news?ticker=${encodeURIComponent(sym)}&limit=5&apiKey=${POLY_KEY}`,
          { headers: { "User-Agent": "StockVizor/1.0" } }
        );
        if (nr.ok) {
          const nj = await nr.json();
          news = (nj.results || []).map((n) => ({
            headline: n.title,
            publisher: n.publisher?.name || "News",
            published_at: n.published_utc,
            sentiment: (n.insights || []).find((ins) => ins.ticker === sym)?.sentiment || "neutral"
          }));
        }
      } catch {
      }
    }
    const signal = computeSignal({
      rsi: ta.rsi ?? null,
      sma50: ta.sma50 ?? null,
      sma200: ta.sma200 ?? null,
      macd_h: ta.macd_h ?? null,
      mom5: ta.mom5 ?? null
    }, price);
    const buySignal = computeBuySignal({
      sc_state: ta.sc_state ?? null,
      rsi: ta.rsi ?? null,
      rsi2: ta.rsi2 ?? null
      // null until ta-batch stores it
    }, fp.pct_above_sma200 ?? null);
    return jsonResp({
      symbol: sym,
      price,
      change_abs: q.change_abs ?? null,
      change_pct: q.change_pct ?? null,
      sma20: null,
      // not stored in ta_cache; v.html computes from bars if needed
      sma50: ta.sma50 ?? null,
      sma200: ta.sma200 ?? null,
      rsi: ta.rsi ?? null,
      macd_h: ta.macd_h ?? null,
      adx14: ta.adx14 ?? null,
      stoch_k: ta.stoch_k ?? null,
      mom5: ta.mom5 ?? null,
      pivot_s1: ta.pivot_s1 ?? null,
      pivot_s2: ta.pivot_s2 ?? null,
      pivot_r1: ta.pivot_r1 ?? null,
      pivot_r2: ta.pivot_r2 ?? null,
      target1: ta.tg1 ?? null,
      target2: ta.tg2 ?? null,
      // Signal layer — computed by ta-batch Phase 1 from 200-bar history
      sc_state: ta.sc_state ?? null,
      sc_bars_since_b: ta.sc_bars_since_b ?? null,
      regime: ta.regime ?? null,
      bull_div_age: ta.bull_div_age ?? 0,
      bear_div_age: ta.bear_div_age ?? 0,
      macd_crest18: ta.macd_crest18 ?? null,
      macd_depth18: ta.macd_depth18 ?? null,
      // Smart RSI — fired by detect-smart-rsi-daily edge function
      smart_rsi_7_fired: ta.smart_rsi_7_fired ?? false,
      smart_rsi_5_fired: ta.smart_rsi_5_fired ?? false,
      smart_rsi_7_fired_at: ta.smart_rsi_7_fired_at ?? null,
      smart_rsi_5_fired_at: ta.smart_rsi_5_fired_at ?? null,
      signal,
      buy_signal: buySignal,
      pct_above_sma200: fp.pct_above_sma200 ?? null,
      news
    });
  }
  if (seg[0] === "quotes") {
    const tickers = (url.searchParams.get("tickers") || "").split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
    if (!tickers.length) return jsonResp({});
    const rows = await supaFetch(
      SUPA_URL,
      SUPA_KEY,
      "quote_cache",
      `symbol=in.(${tickers.join(",")})&select=symbol,last_price,change_abs,change_pct`
    );
    const out = {};
    const seenSyms = /* @__PURE__ */ new Set();
    for (const r of rows || []) {
      seenSyms.add(r.symbol);
      const pct = r.change_pct ?? 0;
      out[r.symbol] = {
        price: r.last_price != null ? r.last_price.toFixed(2) : "\u2014",
        change: r.change_abs != null ? (r.change_abs >= 0 ? "+" : "") + r.change_abs.toFixed(2) : "\u2014",
        pct: r.change_pct != null ? (r.change_pct >= 0 ? "+" : "") + r.change_pct.toFixed(2) + "%" : "\u2014",
        dir: pct >= 0 ? "bull" : "bear"
      };
    }
    const jitNeeded = tickers.filter(
      (t) => !seenSyms.has(t) || out[t] && (out[t].change === "\u2014" || out[t].change === "+0.00")
    );
    if (jitNeeded.length > 0 && POLY_KEY) {
      const fresh = await jitFetchAndCacheQuotes(jitNeeded, POLY_KEY, SUPA_URL, SUPA_KEY);
      for (const [sym, data] of Object.entries(fresh)) {
        const pct = data.change_pct ?? 0;
        out[sym] = {
          price: data.last_price != null ? data.last_price.toFixed(2) : "\u2014",
          change: data.change_abs != null ? (data.change_abs >= 0 ? "+" : "") + data.change_abs.toFixed(2) : "\u2014",
          pct: data.change_pct != null ? (data.change_pct >= 0 ? "+" : "") + data.change_pct.toFixed(2) + "%" : "\u2014",
          dir: pct >= 0 ? "bull" : "bear"
        };
      }
    }
    return jsonResp(out);
  }
  if (seg[0] === "sparklines") {
    const tickers = (url.searchParams.get("tickers") || "").split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
    const days = Math.min(30, Math.max(2, parseInt(url.searchParams.get("days") || "10", 10)));
    if (!tickers.length || !POLY_KEY) return jsonResp({});
    const toDate = /* @__PURE__ */ new Date();
    const fromDate = new Date(toDate);
    fromDate.setDate(fromDate.getDate() - days * 2);
    const from = fromDate.toISOString().slice(0, 10);
    const to = toDate.toISOString().slice(0, 10);
    const results = await Promise.all(tickers.map(async (sym) => {
      try {
        const r = await fetch(
          `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=${days + 10}&apiKey=${POLY_KEY}`,
          { headers: { "User-Agent": "StockVizor/1.0" } }
        );
        if (!r.ok) return [sym, null];
        const j = await r.json();
        const closes = (j.results || []).slice(-days).map((b) => b.c);
        return [sym, closes.length ? closes : null];
      } catch {
        return [sym, null];
      }
    }));
    const out = {};
    for (const [sym, closes] of results) {
      if (closes) out[sym] = closes;
    }
    return jsonResp(out);
  }
  if (seg[0] === "index") {
    const CACHED_SYMS = ["SPY", "QQQ", "DIA", "IWM", "GLD"];
    const rows = await supaFetch(
      SUPA_URL,
      SUPA_KEY,
      "quote_cache",
      `symbol=in.(${CACHED_SYMS.join(",")})&select=symbol,last_price,change_pct`
    );
    const out = {};
    for (const r of rows || []) {
      const pct = r.change_pct ?? 0;
      out[r.symbol] = {
        price: r.last_price != null ? r.last_price.toFixed(2) : "\u2014",
        pct: r.change_pct != null ? (r.change_pct >= 0 ? "+" : "") + r.change_pct.toFixed(2) + "%" : "\u2014",
        dir: pct >= 0 ? "bull" : "bear"
      };
    }
    if (POLY_KEY) {
      try {
        const r = await fetch(
          `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=VIX&apiKey=${POLY_KEY}`,
          { headers: { "User-Agent": "StockVizor/1.0" } }
        );
        if (r.ok) {
          const j = await r.json();
          const vix = (j.tickers || []).find((t) => t.ticker === "VIX");
          if (vix) {
            const day = vix.day || {};
            const prev = vix.prevDay || {};
            const lp = (day.c || 0) > 0 ? day.c : prev.c || null;
            const cp = vix.todaysChangePerc ?? null;
            if (lp) {
              out["VIX"] = {
                price: lp.toFixed(2),
                pct: cp != null ? (cp >= 0 ? "+" : "") + cp.toFixed(2) + "%" : "\u2014",
                dir: (cp ?? 0) >= 0 ? "bull" : "bear"
              };
            }
          }
        }
      } catch {
      }
    }
    return jsonResp(out);
  }
  return errorResp("Unknown dashboard route", 404);
}
__name(handleDashboard, "handleDashboard");
async function handleVizAI(request, env, ctx) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  const ANON_KEY = env.SUPABASE_ANON_KEY || SUPA_KEY;
  const ANTH_KEY = env.ANTHROPIC_KEY;
  if (!SUPA_URL) return errorResp("Database not configured", 503);
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return errorResp("Unauthorized", 401);
  let userId;
  try {
    const userResp = await fetch(`${SUPA_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!userResp.ok) return errorResp("Unauthorized", 401);
    const userData = await userResp.json();
    userId = userData?.id;
    if (!userId) return errorResp("Unauthorized", 401);
  } catch {
    return errorResp("Auth error", 500);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON body", 400);
  }
  const { mode = "analyze", ticker, context, entryPrice, qty, direction, question, user_api_key } = body;
  if (!ticker) return errorResp("Missing ticker", 400);
  const effectiveKey = ANTH_KEY || (typeof user_api_key === "string" ? user_api_key.trim() : "");
  if (!effectiveKey) return errorResp("No AI key configured. Add your Anthropic key in VizAI Studio \u2192 Settings.", 503);
  const feature = mode === "tradeplan" ? "tradeplan" : mode === "coach" ? "coach" : "analyze";
  const LIMIT = 5;
  const today = (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  let currentCount = 0;
  try {
    const rows = await supaFetch(
      SUPA_URL,
      SUPA_KEY,
      "vizai_usage",
      `user_id=eq.${userId}&usage_date=eq.${encodeURIComponent(today)}&feature=eq.${feature}&select=count`
    );
    currentCount = rows?.[0]?.count ?? 0;
  } catch {
  }
  if (currentCount >= LIMIT) {
    return jsonResp(
      { error: "Daily limit reached", limitReached: true, usage: currentCount, limit: LIMIT },
      429
    );
  }
  const SYSTEM_PROMPTS = {
    analyze: `You are VizAI, an expert stock market analyst embedded in a retail trading app called StockVizor. Give a concise, actionable technical read on the ticker. Cover: current momentum, key support/resistance levels, signal strength, and one clear takeaway. Skip disclaimers \u2014 retail traders need direct answers. Max 200 words.`,
    tradeplan: `You are VizAI, a professional trade planner inside StockVizor. Output a structured trade plan using EXACTLY this format \u2014 no preamble, no extra text:
THESIS: one sentence on why the trade makes sense
STOP: price level and % loss from entry (e.g. "STOP: $148.50 \u2014 2.3% risk")
T1: first target with R:R (e.g. "T1: $158.00 \u2014 1:2 R:R")
T2: extended target with R:R (e.g. "T2: $167.00 \u2014 1:3.8 R:R")
TIME: expected holding period

Use real numbers. Max 120 words.`,
    coach: `You are VizAI, a trading coach inside StockVizor. The user just performed a chart action. Give a short, practical tip about technique, pattern recognition, or discipline. Be direct and encouraging. Max 80 words.`
  };
  const system = SYSTEM_PROMPTS[feature] || SYSTEM_PROMPTS.analyze;
  let userMsg = `Ticker: ${String(ticker).toUpperCase()}
`;
  if (context) userMsg += `Chart context: ${context}
`;
  if (feature === "tradeplan" && entryPrice) {
    userMsg += `Entry: $${entryPrice}`;
    if (qty) userMsg += ` \xD7 ${qty} shares`;
    if (direction) userMsg += ` (${direction})`;
    userMsg += "\n";
  }
  if (feature === "coach" && question) userMsg += `Action: ${question}
`;
  const ACTION_PHRASE = { analyze: "Analyze this ticker.", tradeplan: "Generate the trade plan.", coach: "Give a coaching tip." };
  userMsg += ACTION_PHRASE[feature] || ACTION_PHRASE.analyze;
  ctx.waitUntil(
    fetch(`${SUPA_URL}/rest/v1/vizai_usage`, {
      method: "POST",
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates"
      },
      body: JSON.stringify([{
        user_id: userId,
        usage_date: today,
        feature,
        count: currentCount + 1
      }])
    }).catch(() => {
    })
  );
  let anthResp;
  try {
    anthResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": effectiveKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        stream: true,
        system,
        messages: [{ role: "user", content: userMsg }]
      })
    });
  } catch (e) {
    console.error("[VizAI]", e);
    return errorResp("AI service unreachable", 502);
  }
  if (!anthResp.ok) {
    const errBody = await anthResp.text().catch(() => "");
    console.error("[VizAI] Anthropic error", anthResp.status, errBody);
    let detail = "AI service error";
    try {
      const j = JSON.parse(errBody);
      detail = j.error?.message || detail;
    } catch {
    }
    return errorResp(`[${anthResp.status}] ${detail}`, 502);
  }
  return new Response(anthResp.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...CORS_HEADERS
    }
  });
}
__name(handleVizAI, "handleVizAI");
async function handleVizDetect(request, env, ctx) {
  const SUPA_URL = env.SUPABASE_URL;
  const SUPA_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  const ANON_KEY = env.SUPABASE_ANON_KEY || SUPA_KEY;
  const ANTH_KEY = env.ANTHROPIC_KEY;
  if (!SUPA_URL) return errorResp("Database not configured", 503);
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return errorResp("Unauthorized", 401);
  let userId;
  try {
    const userResp = await fetch(`${SUPA_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!userResp.ok) return errorResp("Unauthorized", 401);
    const userData = await userResp.json();
    userId = userData?.id;
    if (!userId) return errorResp("Unauthorized", 401);
  } catch {
    return errorResp("Auth error", 500);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResp("Invalid JSON body", 400);
  }
  const { ticker, tf, bars, contextBars = [], priceTop, priceBottom, user_api_key } = body;
  if (!ticker) return errorResp("Missing ticker", 400);
  if (!Array.isArray(bars) || bars.length < 5)
    return errorResp("Need at least 5 bars", 400);
  if (bars.length > 200) return errorResp("Max 200 bars", 400);
  const effectiveKey = ANTH_KEY || (typeof user_api_key === "string" ? user_api_key.trim() : "");
  if (!effectiveKey) return errorResp("No AI key configured. Add your Anthropic key in VizAI Studio \u2192 Settings.", 503);
  const LIMIT = 10;
  const feature = "vizdetect";
  const today = (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  let currentCount = 0;
  try {
    const rows = await supaFetch(
      SUPA_URL,
      SUPA_KEY,
      "vizai_usage",
      `user_id=eq.${userId}&usage_date=eq.${encodeURIComponent(today)}&feature=eq.${feature}&select=count`
    );
    currentCount = rows?.[0]?.count ?? 0;
  } catch {
  }
  if (currentCount >= LIMIT) {
    return jsonResp(
      { error: "Daily VizDetect limit reached", limitReached: true, usage: currentCount, limit: LIMIT },
      429
    );
  }
  const fmt = /* @__PURE__ */ __name((b) => `${b.time},${(+b.open).toFixed(2)},${(+b.high).toFixed(2)},${(+b.low).toFixed(2)},${(+b.close).toFixed(2)},${Math.round(+b.volume || 0)}`, "fmt");
  const ctxTable = contextBars.length ? `Context bars (prior trend \u2014 ${contextBars.length} bars before selection):
time,open,high,low,close,volume
${contextBars.map(fmt).join("\n")}

` : "";
  const selTable = `Selected bars (${bars.length} candles, timeframe: ${tf || "unknown"}):
time,open,high,low,close,volume
${bars.map(fmt).join("\n")}`;
  const priceRange = priceTop != null && priceBottom != null ? `
Price range of selection: $${(+priceBottom).toFixed(2)} \u2013 $${(+priceTop).toFixed(2)}` : "";
  let fundamentalsBlock = "";
  if (env.POLYGON_KEY) {
    try {
      const funds = await fetchTickerFundamentals(ticker, env.POLYGON_KEY, env.SCREENER_CACHE);
      fundamentalsBlock = formatFundamentalsBlock(funds);
    } catch (e) {
      console.warn("[VizDetect] fundamentals fetch failed", e?.message);
    }
  }
  const system = `You are VizDetect, an expert technical analyst embedded in StockVizor. Analyze the provided OHLCV candle data and identify the dominant chart pattern. Be precise and direct \u2014 no disclaimers. When fundamentals are provided, incorporate them into your WHAT_HAPPENED and OUTCOME sections.

Respond using EXACTLY this format (no extra text before or after):
PATTERN: <pattern name, e.g. Bull Flag, Head & Shoulders, Double Bottom>
CONFIDENCE: <integer 0-100>%
WHAT_HAPPENED:
<2-3 sentences describing what price did during the selected window \u2014 describe the shape, structure, and any notable price action. Note any fundamental context that is relevant.>
OUTCOME:
<2-3 sentences on the most probable next move: direction, approximate magnitude, and timeframe. Factor in both technical setup and fundamental backdrop.>
WATCH:
- <key level or signal to confirm the pattern \u2014 be specific>
- <key level or condition that would invalidate the pattern>
- <one more watchpoint if applicable>
LEVELS:
- ENTRY: <price or N/A>
- STOP: <price or N/A>
- T1: <first price target or N/A>
- T2: <extended price target or N/A>`;
  const userMsg = `Ticker: ${String(ticker).toUpperCase()}
${ctxTable}${selTable}${priceRange}${fundamentalsBlock}

Identify the pattern and fill in all sections.`;
  ctx.waitUntil(
    fetch(`${SUPA_URL}/rest/v1/vizai_usage`, {
      method: "POST",
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates"
      },
      body: JSON.stringify([{
        user_id: userId,
        usage_date: today,
        feature,
        count: currentCount + 1
      }])
    }).catch(() => {
    })
  );
  let anthResp;
  try {
    anthResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": effectiveKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 600,
        stream: true,
        system,
        messages: [{ role: "user", content: userMsg }]
      })
    });
  } catch (e) {
    console.error("[VizDetect]", e);
    return errorResp("AI service unreachable", 502);
  }
  if (!anthResp.ok) {
    const errBody = await anthResp.text().catch(() => "");
    console.error("[VizDetect] Anthropic error", anthResp.status, errBody);
    if (anthResp.status === 402 || /credit|billing|balance|payment/i.test(errBody)) {
      return errorResp("VizDetect is temporarily unavailable \u2014 API credits are being replenished. Try again later.", 402);
    }
    let detail = "AI service error";
    try {
      const j = JSON.parse(errBody);
      detail = j.error?.message || detail;
    } catch {
    }
    return errorResp(detail, 502);
  }
  return new Response(anthResp.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-VizDetect-Usage": String(currentCount + 1),
      "X-VizDetect-Limit": String(LIMIT),
      "X-VizDetect-Cache": "MISS",
      ...CORS_HEADERS
    }
  });
}
__name(handleVizDetect, "handleVizDetect");
async function handleMaintenance(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const stored = (env.MAINT_SECRET || "").trim();
    const sent = (body.secret || "").trim();
    if (!stored || sent !== stored) {
      return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
    }
    const mode = body.mode === "on" ? "true" : "false";
    const svcKey = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
    const resp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/app_config?key=eq.maintenance_mode`,
      {
        method: "PATCH",
        headers: {
          "apikey": svcKey,
          "Authorization": `Bearer ${svcKey}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal"
        },
        body: JSON.stringify({ value: mode })
      }
    );
    if (!resp.ok) {
      console.error("[Maintenance] Supabase error", resp.status);
      return errorResp("Service error", 502);
    }
    return jsonResp({ ok: true, mode });
  } catch (e) {
    console.error("[Maintenance]", e);
    return errorResp("Service error", 500);
  }
}
__name(handleMaintenance, "handleMaintenance");
async function fetchTickerFundamentals(ticker, polyKey, cache) {
  const cacheKey = `fund:${ticker}`;
  if (cache) {
    const hit = await cache.get(cacheKey, "json");
    if (hit) return hit;
  }
  const [detailsRes, financialsRes] = await Promise.allSettled([
    fetch(`https://api.polygon.io/v3/reference/tickers/${encodeURIComponent(ticker)}?apiKey=${polyKey}`),
    fetch(`https://api.polygon.io/vX/reference/financials?ticker=${encodeURIComponent(ticker)}&timeframe=quarterly&limit=4&apiKey=${polyKey}`)
  ]);
  const result = { ticker, sector: "", marketCap: null, name: "", financials: [] };
  if (detailsRes.status === "fulfilled" && detailsRes.value.ok) {
    const d = await detailsRes.value.json();
    const r = d.results;
    if (r) {
      result.name = r.name || ticker;
      result.sector = r.sic_description || "";
      result.marketCap = r.market_cap || null;
    }
  }
  if (financialsRes.status === "fulfilled" && financialsRes.value.ok) {
    const d = await financialsRes.value.json();
    result.financials = (d.results || []).map((q) => ({
      period: `${q.fiscal_year} ${q.fiscal_period}`,
      revenue: q.financials?.income_statement?.revenues?.value ?? null,
      netIncome: q.financials?.income_statement?.net_income_loss?.value ?? null,
      eps: q.financials?.income_statement?.basic_earnings_per_share?.value ?? null
    }));
  }
  if (cache && (result.sector || result.financials.length)) {
    await cache.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 });
  }
  return result;
}
__name(fetchTickerFundamentals, "fetchTickerFundamentals");
function formatFundamentalsBlock(f) {
  if (!f) return "";
  const lines = [];
  if (f.sector) lines.push(`Sector: ${f.sector}`);
  if (f.marketCap) {
    const mc = f.marketCap >= 1e9 ? `$${(f.marketCap / 1e9).toFixed(1)}B` : `$${(f.marketCap / 1e6).toFixed(0)}M`;
    lines.push(`Market Cap: ${mc}`);
  }
  if (f.financials?.length) {
    const qs = [...f.financials].reverse();
    const fmtV = /* @__PURE__ */ __name((v, div, unit) => v != null ? `${(v / div).toFixed(2)}${unit}` : "N/A", "fmtV");
    lines.push(`Revenue (${qs.map((q) => q.period).join(" > ")}): ${qs.map((q) => fmtV(q.revenue, 1e9, "B")).join(" > ")}`);
    lines.push(`EPS     (${qs.map((q) => q.period).join(" > ")}): ${qs.map((q) => fmtV(q.eps, 1, "")).join(" > ")}`);
    const revs = qs.map((q) => q.revenue).filter((v) => v != null);
    if (revs.length >= 2) lines.push(`Revenue trend: ${revs[revs.length - 1] > revs[0] ? "growing" : "declining"}`);
    const epss = qs.map((q) => q.eps).filter((v) => v != null);
    if (epss.length >= 2) lines.push(`EPS trend: ${epss[epss.length - 1] > epss[0] ? "improving" : "deteriorating"}`);
  }
  if (!lines.length) return "";
  return "\n\nFundamentals:\n" + lines.join("\n");
}
__name(formatFundamentalsBlock, "formatFundamentalsBlock");
async function handleFundamentals(request, env) {
  const ticker = (new URL(request.url).searchParams.get("ticker") || "").toUpperCase().trim();
  if (!ticker) return errorResp("Missing ticker", 400);
  const POLY_KEY = env.POLYGON_KEY;
  if (!POLY_KEY) return errorResp("API key not configured", 503);
  try {
    const data = await fetchTickerFundamentals(ticker, POLY_KEY, env.SCREENER_CACHE);
    return jsonResp(data);
  } catch (e) {
    return errorResp("Fundamentals fetch failed", 502);
  }
}
__name(handleFundamentals, "handleFundamentals");
export {
  ScreenerCoordinator,
  index_default as default
};
