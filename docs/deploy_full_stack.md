# Deploy: Full Stack

End-to-end deployment runbook for StockVizor. Covers Cloudflare Worker (frontend + API gateway), Supabase Edge Functions, and Supabase SQL changes.

**Source of truth for the live state:** this repository's `main` branch.

---

## Prerequisites — verify once per machine

Run these once. They confirm your environment is ready to deploy.

```bash
# Wrangler authenticated
wrangler whoami
# Expected: "You are logged in with an OAuth Token, associated with the email <yours>"

# Supabase logged in
supabase projects list
# Expected: row with ● in LINKED column for hkamukkkkpqhdpcradau (optionlens-trades)

# Repo is clean and on main
git status     # nothing to commit
git pull       # up to date
```

If any of those fail, fix that first. Re-auth: `wrangler login` / `supabase login`. Re-link: `supabase link --project-ref hkamukkkkpqhdpcradau` from the repo root.

---

## Deploy order

Always in this order:

1. **SQL** (database schema + cron + functions)
2. **Edge Functions** (Supabase / Deno)
3. **Cloudflare Worker + static assets** (frontend)

**Why:** schema must exist before edge functions try to use it; edge functions must be deployed before frontend code that calls their endpoints. Reverse the order and you get a window where the live frontend hits endpoints that 404.

---

## Step 1 — SQL changes

**SQL is applied manually via the Supabase Dashboard SQL editor — not via `supabase db push`.** See `sql/README.md` for the rationale (existing schema was applied via Dashboard, not registered in `supabase_migrations.schema_migrations`, so `db push` would re-apply already-applied SQL).

### Procedure

1. Open `sql/README.md` and find the file(s) with status `⏳ pending`
2. Open the Supabase SQL editor: https://supabase.com/dashboard/project/hkamukkkkpqhdpcradau/sql/new
3. For each pending file, in order:
   - Open the file in your editor, read it end-to-end
   - Copy the contents into the SQL editor
   - Click **Run**
   - Verify the expected return (e.g. `CREATE TABLE` returns success, `SELECT` returns the expected rows)
4. Update `sql/README.md`: change the file's status from `⏳ pending` to `✅ applied`, commit + push that change. The README is the project's record of what's live.

### Skip if no SQL changes

If no files are pending, skip to Step 2.

### Verification

```sql
-- Run in the SQL editor to spot-check that your changes landed
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;
```

### Rollback

There is no automated rollback for Dashboard SQL. Write the reverse migration as a new file in `sql/` (e.g. `phase-a-watchlist_rollback.sql`), apply it via the Dashboard, update `sql/README.md`. Test reverse migrations on a non-prod table first if possible.

---

## Step 2 — Edge Functions

### Pre-flight check

```bash
# What's deployed remotely vs. what's in the repo
supabase functions list
ls supabase/functions/
```

If the remote has a function that is not in the repo (`iv-batch` and `universe-fan-out` were like this until 2026-05-03), download it first so the repo stays source of truth:

```bash
supabase functions download <name>
git add supabase/functions/<name>
git commit -m "Sync <name> from remote"
git push
```

### Deploy one function at a time (recommended)

```bash
# From repo root
supabase functions deploy <name> --project-ref hkamukkkkpqhdpcradau --use-api
```

**Flags explained:**
- `--project-ref hkamukkkkpqhdpcradau` — explicit project ref, even though we're linked. Prevents accidental cross-project deploys.
- `--use-api` — required because Docker isn't running on this machine. Bundles server-side. Without this flag, deploy fails with "Docker is not running."

### Deploy all local functions at once (for major releases)

```bash
supabase functions deploy --project-ref hkamukkkkpqhdpcradau --use-api
```

This deploys every function in `supabase/functions/`. Use sparingly — one bad function fails the batch.

### NEVER use `--prune` without thinking

`supabase functions deploy --prune` deletes any remote function NOT present locally. If your local repo is out of sync, this will silently delete production functions. Only use after verifying `supabase functions list` matches `ls supabase/functions/` exactly.

### Verification

```bash
supabase functions list
```

Confirm the deployed function shows a higher VERSION number and a recent UPDATED_AT than before. Hit a known endpoint to confirm runtime works:

```bash
# For ai-summary, fetching cached market thesis (no auth required for cached read)
curl --ssl-no-revoke -sS "https://hkamukkkkpqhdpcradau.supabase.co/functions/v1/ai-summary?cache_key=market" \
  -H "apikey: $SUPABASE_ANON_KEY" | head -c 200
```

(`SUPABASE_ANON_KEY` is the project's anon key — public-by-design, found in the Supabase Dashboard under Settings → API.)

### Rollback

```bash
# Revert the function file to the previous commit, redeploy
git log --oneline supabase/functions/<name>/index.ts | head -5    # find previous good commit
git checkout <prev-commit-sha> -- supabase/functions/<name>/index.ts
supabase functions deploy <name> --project-ref hkamukkkkpqhdpcradau --use-api
git checkout main -- supabase/functions/<name>/index.ts            # restore working tree to current main
```

The redeploy creates a new VERSION on the remote (it does not delete the bad one) — Supabase keeps the version history. If you rolled back v6 by deploying v5's code, the result is v7 on remote with v5's content.

---

## Step 3 — Cloudflare Worker + static assets

### Dry-run first (always)

```bash
# From repo root
wrangler deploy --dry-run
```

Confirms:
- `wrangler.toml` is valid
- All assets in `public/` are readable
- Bundle size is reasonable
- Bindings (`ASSETS`) are correctly configured

Expected output ends with `--dry-run: exiting now.` Do NOT proceed to real deploy if dry-run errors.

### Real deploy

```bash
wrangler deploy
```

Expected: prints the new Worker version ID and the deploy URL.

### Verification

1. **Worker version:** `wrangler deployments list` — most recent entry should be ~30 seconds old
2. **Live site smoke test:**
   ```bash
   curl --ssl-no-revoke -sI https://stockvizor.com/        # 200, no-cache headers
   curl --ssl-no-revoke -sI https://stockvizor.com/v       # 200, X-Robots-Tag noindex
   curl --ssl-no-revoke -sI https://stockvizor.com/screener # 404 (URL obfuscation working)
   ```
3. **In-browser:** open https://stockvizor.com/v, sign in, confirm dashboard renders.

### Rollback

```bash
wrangler rollback
# Or, revert in git and redeploy:
git revert HEAD
git push
wrangler deploy
```

`wrangler rollback` is fastest — points the live route back to a previous Worker version. Use this when you need to recover immediately. Follow up with a git revert so the repo matches what's live.

---

## Coordinated full-stack deploy

When a single change touches all three layers (e.g. a new feature with new SQL, new edge function, and new frontend code):

```bash
# 1. Pull and confirm clean state
git pull
git status

# 2. SQL via Dashboard (manual). Update sql/README.md status. Commit.

# 3. Edge function deploys
supabase functions deploy <name1> --project-ref hkamukkkkpqhdpcradau --use-api
supabase functions deploy <name2> --project-ref hkamukkkkpqhdpcradau --use-api
supabase functions list                # verify versions bumped

# 4. Cloudflare Worker dry-run, then real
wrangler deploy --dry-run
wrangler deploy
wrangler deployments list              # verify new version

# 5. Smoke test live site
curl --ssl-no-revoke -sI https://stockvizor.com/v
# Open https://stockvizor.com/v in browser; sign in; confirm feature works
```

If any step fails, **stop**. Fix the failure or roll back the steps that succeeded before continuing. Do not paper over a failure with a hot fix.

---

## Common mistakes (don't repeat these)

- **Pushing without `git pull` first** → divergent history, painful merge
- **Deploying frontend before edge functions it depends on** → live 404s
- **Forgetting `--use-api`** → "Docker is not running" failure
- **Using `--prune` without checking first** → silently deletes production functions
- **Forgetting to flip `MFA_REQUIRED = true` in `public/v.html` and `public/s.html` before production launch** — see `docs/TECH-DEBT.md` Item 6
- **Committing secrets** — GitHub secret-scanner will block, but rotate anyway. Tokens that landed in any file are exposed
- **Running `supabase db push`** — see `sql/README.md` for why this is dangerous against this project
- **Running deploys with uncommitted local changes** → repo and prod drift; you cannot tell what is live

---

## Related

- `sql/README.md` — SQL apply-status table and rationale for not using `db push`
- `docs/TECH-DEBT.md` — known issues; Items 1, 6 affect deploy correctness
- `docs/MORNING-SUMMARY.md` — most recent ship notes (live Worker version)
- `docs/dashboard-build-plan.md` — Phase B1 build plan
- `wrangler.toml` — Worker config
- `supabase/config.toml` — linked project ref
