# Deploying ai-summary edge function — 5 minutes

You'll run these commands on YOUR machine. The Supabase CLI handles auth via browser
login, so no tokens get pasted anywhere.

## Step 1 — Install Supabase CLI (one-time, ~2 min)

### Mac
```bash
brew install supabase/tap/supabase
```

### Windows
Download from https://github.com/supabase/cli/releases — grab the latest
`supabase_windows_amd64.tar.gz`, extract, and either add to PATH or run from the
extracted folder.

OR using Scoop:
```powershell
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
```

### Verify
```bash
supabase --version
```
Should print something like `2.x.x`.


## Step 2 — Login (one-time, ~30 sec)

```bash
supabase login
```

This opens your browser. You authenticate via the Supabase web UI you're already
logged into. The CLI stores a token locally — not pasted anywhere, not visible
to me or anyone else. This is the right way to do auth.


## Step 3 — Stage the function file (~1 min)

```bash
# Mac/Linux
mkdir -p ~/sv-deploy/supabase/functions/ai-summary
cd ~/sv-deploy
cp ~/Downloads/ai-summary.ts supabase/functions/ai-summary/index.ts
```

```powershell
# Windows
mkdir $HOME\sv-deploy\supabase\functions\ai-summary
cd $HOME\sv-deploy
copy $HOME\Downloads\ai-summary.ts supabase\functions\ai-summary\index.ts
```

(Adjust `~/Downloads/ai-summary.ts` to wherever you saved the file.)


## Step 4 — Deploy (~30 sec)

```bash
supabase functions deploy ai-summary --project-ref hkamukkkkpqhdpcradau --no-verify-jwt
```

You should see output ending in:
```
Deployed Function ai-summary on project hkamukkkkpqhdpcradau
You can inspect your deployment in the Dashboard:
https://supabase.com/dashboard/project/hkamukkkkpqhdpcradau/functions/ai-summary/details
```


## Step 5 — Force regeneration so the new prompt takes effect (~30 sec)

In Supabase Dashboard → SQL Editor, run:

```sql
DELETE FROM dashboard_ai_cache WHERE cache_key IN ('market', 'fdcosta-watchlist');
```

Next time you load the dashboard, fresh AI summaries will generate using the v3
prompt with EXACTLY 2-3 image tokens per summary.


## If something goes wrong

### "Docker is not running" warning
This is fine — it's a warning, not an error. The deploy proceeds without Docker.
Docker is only needed for local function testing.

### "Project not linked"
Run this once before the deploy:
```bash
supabase link --project-ref hkamukkkkpqhdpcradau
```

### "Permission denied" or "Unauthorized"
Means your `supabase login` session expired. Re-run `supabase login`.

### Function still shows old behavior after deploy
Cached AI summary from v2 is still in the database. Run the DELETE in Step 5.


## Total time

- First deploy ever: ~5 minutes (includes install + login)
- Future deploys: ~30 seconds (just Step 4)


## Why this approach

- No tokens pasted anywhere outside Supabase's own auth flow
- Tokens stored locally on YOUR machine only
- Standard, documented Supabase deploy method
- Zero exposure risk
