# StockVizor — Tech Debt Log

## Item 1: Screener legacy `pKey()` gating checks
**Captured:** 2026-04-28
**Status:** Sentinel fix shipped; proper refactor pending
**Severity:** Low (cosmetic; product works)
**Affected file:** `screener.html` (legacy 19,162-line file)

### Background
The legacy `screener.html` file contains a `pKey()` function and an `EMBEDDED_KEY` constant that pre-date the Cloudflare Worker proxy (`/api/polygon/*`). All actual Polygon API calls now route through the worker proxy via `POLY_CM = '/api/polygon'`, which injects the real key from `env.POLYGON_KEY` server-side. The browser does not need a key.

However, multiple gating checks in screener.html still call `pKey()` to validate before letting the user proceed. Since the original `EMBEDDED_KEY = ''` was empty, these gates would block:

- Line 13211 — `runTASearch()` — TA chart open from search
- Line 13218 — `_runTASearchLegacy_unused` — legacy unused
- Line 14647 — chart price fetch
- Line 16482 — `runOptsPageAnalysis()` — Options analyzer

When users visited the screener, clicked "Analyze options chain" or similar, they'd see `'API key required'` even though the actual API call would have worked through the proxy.

### Fix shipped (sentinel approach)
Changed line 1673:
```javascript
// BEFORE:
const EMBEDDED_KEY = ''; // Moved to Worker secret

// AFTER:
const EMBEDDED_KEY = 'proxied'; // Sentinel — real key lives in Cloudflare Worker (/api/polygon/*)
```

This makes `pKey()` return a truthy string (`'proxied'`), so the gating checks pass. The string `'proxied'` is never sent anywhere — the actual fetches use `${POLY_CM}/...` URLs which route through the worker.

**Side effect:** Line 12925 populates the visible (and hidden duplicate) `<input id="polyKey">` field with `EMBEDDED_KEY` if empty. Users may see `••••••••` (8 dots) in the password input field. Cosmetic only, no functional impact.

### Proper refactor (when revisiting screener)

Two cleaner approaches, in order of preference:

**Option 1 — Remove the gates entirely (recommended)**
Since all real API calls go through `/api/polygon/*` (worker proxy), the `pKey()` gates protect nothing. Remove all 4 gating checks:
- Lines 13211, 13218, 14647, 16482

Also remove:
- Line 1680: `function pKey()` — no longer called
- Line 1673: `const EMBEDDED_KEY` — no longer referenced
- Line 12925: `if(_ki && !_ki.value) _ki.value = EMBEDDED_KEY;` — populates dead input
- Both `<input id="polyKey">` HTML elements (lines 74 and 18383) — also gives us a chance to fix the duplicate-ID HTML bug

**Option 2 — Make the gates check whether the proxy responds**
Instead of checking for a key, `pKey()` could be replaced with `proxyAvailable()` that pings `/api/polygon/healthz` (a route we'd add). More work, marginal benefit.

### Why we used Option 1 (sentinel) instead of fixing properly today
- Surgical 1-line change minimizes risk to the 19K-line legacy file
- Phase 5 work was active, didn't want to context-switch into legacy refactor
- Proper refactor is a 30-60 minute job ideally done with focused attention

### When to do the proper refactor
- Whenever next we touch screener.html for any reason (consolidate the work)
- Or as part of Phase B2 (chart page) work, since chart and screener share UI patterns
- Not urgent — the sentinel fix is functionally complete

### Related
- Cloudflare Worker proxy: `/home/claude/deploy/index.js` lines 28-30 + `handlePolygon()` function
- Worker secret name: `env.POLYGON_KEY` (Cloudflare Workers secret, separate from Supabase `POLYGON_API_KEY` used by Edge Functions)
- Both keys ARE the same value (the user's Polygon Stocks Starter API key) but stored in two different secret stores

## Item 2: Duplicate HTML ID `polyKey`
**Captured:** 2026-04-28
**Status:** Pre-existing, untouched
**Severity:** Low (HTML validation issue; works in practice)
**Affected file:** `screener.html` lines 74 and 18383

Both lines have `<input ... id="polyKey">`. HTML5 specifies IDs must be unique per document. `document.getElementById('polyKey')` returns only the first match (line 74, hidden). The second visible one is unreachable by ID-based JS.

**Recommended fix:** Either remove one of them or rename one to `polyKey2`. Best handled as part of Item 1's refactor.

## Item 3: Supabase Edge Runtime "DNS cache overflow" 503 errors
**Captured:** 2026-04-26
**Status:** Support ticket draft prepared, pending submission
**Severity:** Medium (degraded service, intermittent, not blocking)
**Affected:** All Edge Function invocations and REST API queries

Recurring 503 errors with body `DNS cache overflow` at `*.supabase.co/functions/v1/*` and `*.supabase.co/rest/v1/*`. Self-resolves in 15-60 minutes. Hit at least 5 times across our build sessions.

Architecture mitigates: cron retries on schedule, frontend graceful fallback, UPSERT pattern means missed runs don't lose data.

**Action item:** Submit ticket from `/mnt/user-data/outputs/SUPABASE-TICKET-DRAFT.md` and follow up.

## Item 4: Commercial data licensing migration (deferred)
**Captured:** 2026-04-28 (initial), expanded 2026-04-30 after vendor research
**Status:** SUPERSEDED — see comprehensive findings below
**Severity:** Medium (no current legal exposure at single-user scale; becomes blocker before public Premium launch)
**Affected:** Polygon stock data + EODHD news + entire dashboard

### TL;DR
StockVizor currently runs on **personal-tier / non-commercial-licensed data feeds**. This is fine while the product has 1 active user (fdcosta) and is not publicly marketed as commercial. **It must be addressed before**: (a) signing first paying Premium customer, (b) publicly marketing the Premium tier, or (c) onboarding more than a small invite-only beta group.

### Conscious decision (2026-04-30)
**"Business as usual, no change. Address this concern once the site is completely up and running. Will partner with another entity if possible."** — Franklin

### Three vendors with current licensing issues

| Vendor | What we use | License problem |
|---|---|---|
| **Polygon (Individual plan)** | Stock prices, snapshots, charts, top movers, technical indicators, news | Market Data ToS clause (c) forbids redistribute/display/derive works to third parties; ToS clause: "may not use Market Data to build an application intended for use by end users other than you" |
| **EODHD News** | News headlines, sentiment, ticker tagging | Confirmed non-commercial by user discovery on 2026-04-28 |
| **Anthropic (Haiku 4.5)** | AI Summary generation | ✅ Already commercial — no action needed |

### Vendor research conducted 2026-04-30 (full pricing matrix)

| Path | Stocks (commercial) | News (commercial) | Year 1 cost | Year 2 cost |
|---|---|---|---|---|
| **A. Polygon Business + Benzinga** | Polygon Business $1,999/mo | Benzinga partner data (price TBD via sales) | ~$1,000 + news (with 50% startup discount) | ~$2,000 + news |
| **B. Twelve Data Venture + Finlight Pro** ⭐ recommended path | Twelve Data Venture $499/mo | Finlight Pro $99/mo | **$598/mo** | $598/mo |
| **C. Stay personal-tier** | Polygon Individual $79-199/mo | EODHD or Polygon news (non-commercial) | $99-200/mo | $99-200/mo |

### Why Path B (Twelve Data Venture + Finlight Pro) when migration triggers
- **$598/mo total** vs ~$1,000+ for Polygon Business
- Twelve Data Venture has explicit ToS language: *"External display data access — ideal for companies showcasing data on client-facing apps or websites"*
- 70+ exchanges, fundamentals data, EOD global, real-time US stocks (we'd use 15-min delayed)
- 10+ years historical daily bars (matches our requirement)
- 99.95% SLA
- No sales call required — direct signup with Stripe payment
- Finlight Pro: real-time financial news, sentiment analysis, WebSocket streaming, historical since 2007
- Engineering migration cost: 2-3 focused days (Polygon → Twelve Data has similar JSON structure for OHLCV)

### Polygon Business "startup discount" worth knowing about
From polygon.io/business: *"We offer startups up to a 50% discount on the first year so they can build their business on the best foundation. Contact sales@massive.com to see if you qualify."*
At $1,999/mo regular, that's ~$1,000/mo first year. Still more expensive than Path B but worth knowing if user wants to stay on Polygon for technical reasons.

### Vendors we evaluated and rejected

- **Yahoo Finance / yfinance** ❌ — Yahoo's official API ToS explicitly prohibits commercial use; no official API exists since 2017; yfinance is unofficial scraping and breaks unpredictably
- **Marketaux paid plans** ⚠️ — Website ToS says "personal, non-commercial use only"; would need written confirmation that paid API tier permits commercial display
- **NewsAPI.ai (Event Registry) 5K plan $90/mo** — Bloomberg/IBM/Spotify customers suggest commercial OK, but pricing for our scope is higher than Finlight and overkill (designed for analytics workflows, not dashboard display)
- **Twelve Data Individual** ❌ — All Individual plans through $999/mo Ultra are personal-use-only despite being expensive

### Migration triggers (when to act)
1. **First paying Premium customer signs up** — automatic trigger
2. **Public marketing launch** of Premium tier (homepage, paid ads, press) — automatic trigger
3. **Beta exceeds ~25 active users** — judgment call but recommended trigger
4. **Anthropic, vendor cease-and-desist letter, or DMCA complaint** — emergency trigger
5. **Partnership opportunity that bundles licensed data** — opportunistic, may bypass need

### What to do in migration sprint (when triggered)
1. Email sales@massive.com asking about Polygon Business startup discount (use as bargaining leverage even if going with Path B)
2. Sign up for Twelve Data Venture trial — verify their endpoint shapes match our usage
3. Sign up for Finlight Pro trial — verify ToS in writing, test news quality
4. Migrate `news-fan-out` Edge Function: EODHD → Finlight (~4 hours)
5. Migrate Cloudflare Worker proxy: Polygon → Twelve Data (~1-2 days)
6. Update `quote-fan-out`, `movers-fan-out`, `ta-batch`, `iv-batch` to call new endpoints (~1 day)
7. Update screener.html chart and TA endpoints (~half day)
8. Cancel Polygon Individual + EODHD subscriptions
9. Update legal disclaimer in footer/onboarding to remove "personal use" framing

### Things to monitor in the meantime
- EODHD support reply (sent earlier; was the trigger for this whole investigation)
- Polygon hasn't audited or rate-limited the account — if traffic patterns change, this could trigger their attention
- Don't publicly announce Premium tier on social media or press until migration complete
- Keep StockVizor "invite-only" or "beta" framing in any external communication

### Action item
**No action required today.** Revisit this section when any migration trigger above fires. The full vendor comparison, contact details, and migration plan are documented above.


## Item 5: MFA emergency escape hatch (CRITICAL — read this if you can't sign in)

**Captured:** 2026-05-02
**Status:** Active runbook
**Severity:** Critical (account lockout = product unusable)

### What this is
StockVizor's dashboard (`/v`), screener (`/s`), and admin monitor (`/m`) all require:
1. Email + password authentication (Supabase Auth)
2. TOTP MFA code from authenticator app (Supabase native MFA)

If you (fdcosta@yahoo.com) lose access to your authenticator app — phone broken, app uninstalled, OS reset, etc. — you will be locked out of StockVizor entirely. **This is the recovery procedure.**

### Recovery procedure

You need:
- Your Supabase access token (PAT): retrieve from your password manager (must have admin access to project hkamukkkkpqhdpcradau). The original PAT was rotated 2026-05-03; never commit the value back to this file.
- A computer with internet
- The Supabase project URL: https://supabase.com/dashboard/project/hkamukkkkpqhdpcradau

#### Option A — Supabase Dashboard (easiest, recommended)
1. Open https://supabase.com/dashboard/project/hkamukkkkpqhdpcradau/sql/new
2. Sign in to Supabase with your Supabase account
3. Paste this SQL:
   ```sql
   -- Disable MFA for fdcosta@yahoo.com
   DELETE FROM auth.mfa_factors
   WHERE user_id = 'bca7572d-c59f-4cf0-85e6-9ba5faf4ef36';
   ```
4. Click Run
5. Go to https://stockvizor.com/v
6. Sign in with email + password (no MFA prompt this time)
7. You'll be prompted to re-enroll MFA — scan the new QR code with your new authenticator app

#### Option B — API call (faster, no Supabase login)
From any terminal. Replace `${SUPABASE_PAT}` with the active token from your password manager before running (or `export SUPABASE_PAT=...` first):
```bash
curl -X POST "https://api.supabase.com/v1/projects/hkamukkkkpqhdpcradau/database/query" \
  -H "Authorization: Bearer ${SUPABASE_PAT}" \
  -H "Content-Type: application/json" \
  -H "User-Agent: cli" \
  -d '{"query":"DELETE FROM auth.mfa_factors WHERE user_id='\''bca7572d-c59f-4cf0-85e6-9ba5faf4ef36'\'';"}'
```

### Other admin/security operations

#### Force-disable MFA for any specific user (by email)
```sql
DELETE FROM auth.mfa_factors
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'user@example.com');
```

#### List all enrolled MFA factors
```sql
SELECT u.email, f.factor_type, f.status, f.created_at, f.friendly_name
FROM auth.mfa_factors f
JOIN auth.users u ON u.id = f.user_id
ORDER BY f.created_at DESC;
```

#### Sign out all sessions for a user (force re-login on all devices)
```sql
DELETE FROM auth.sessions WHERE user_id = 'bca7572d-c59f-4cf0-85e6-9ba5faf4ef36';
```

### Important configuration to verify in Supabase

After the auth migration to obfuscated paths, you must update Supabase Auth settings:

1. Open https://supabase.com/dashboard/project/hkamukkkkpqhdpcradau/auth/url-configuration
2. **Site URL** must be: `https://stockvizor.com`  (not /dashboard)
3. **Redirect URLs** allow list should include:
   - `https://stockvizor.com/v`
   - `https://stockvizor.com/s`
   - `https://stockvizor.com/m`
   - `https://stockvizor.com/`

Without these settings, magic links and password reset emails will redirect users to the wrong path.

### What NOT to do
- Don't share the Supabase PAT outside this runbook
- Don't modify `auth.users` directly — let Supabase handle user records
- Don't run `DROP` or `TRUNCATE` on `auth.*` tables — you'll wipe all users


## Item 6: MFA enforcement temporarily disabled (development mode)

**Captured:** 2026-05-02
**Status:** Active feature flag — MUST flip before production
**Severity:** Critical (security regression if shipped to production)

### What this is
During active development, the constant `MFA_REQUIRED = false` is set at the top of:
- `/public/v.html` (line ~1675)
- `/public/s.html` (line ~558)

When `MFA_REQUIRED = false`:
- Email + password sign-in alone grants full dashboard access
- TOTP challenge panel never appears
- aal2 enforcement is skipped in `authInit()`, `checkAuthAndShow()`, and screener auth

### Why it's set this way
TOTP friction during dev iteration is unhelpful. Re-enrolling MFA after every clean test, computing TOTP codes for puppeteer testing, and password-resetting MFA after lockout were all eating session time. Disabling for dev removes that friction.

### What to do before production
1. Edit `/public/v.html`: change `const MFA_REQUIRED = false;` → `const MFA_REQUIRED = true;`
2. Edit `/public/s.html`: change `const MFA_REQUIRED = false;` → `const MFA_REQUIRED = true;`
3. Deploy
4. Test full sign-in flow: email + password → MFA challenge → dashboard
5. Verify aal1 sessions are bounced to login panel at /v
6. Verify /s redirects to /v if not aal2

### Related
- Item 5 documents the SQL escape hatch for MFA lockouts (still valid even when MFA_REQUIRED=true)
