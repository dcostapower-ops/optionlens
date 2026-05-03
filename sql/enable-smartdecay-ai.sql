-- StockVizor — Enable SmartDecay AI for Premium tier
-- Run in Supabase SQL Editor: Dashboard → SQL Editor → New Query
-- Project: hkamukkkkpqhdpcradau

UPDATE subscription_tiers
SET features = jsonb_set(features, '{forecast,smart_decay}', 'true'::jsonb)
WHERE id = 'premium';

UPDATE subscription_tiers
SET features = jsonb_set(features, '{forecast,smart_decay}', 'false'::jsonb)
WHERE id IN ('free', 'pro');

-- Verify
SELECT id, features->'forecast'->'smart_decay' AS smart_decay
FROM subscription_tiers
ORDER BY id;
-- Expected:
--   free    | false
--   premium | true
--   pro     | false
