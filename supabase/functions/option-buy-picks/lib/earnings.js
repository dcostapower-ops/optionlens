// COPY of workers/naked-picks/src/earnings.js — keep identical (checked by workers/naked-picks/test/sync.test.js).
// Next earnings date from Nasdaq's public analyst endpoint (Zacks data).
// Returns { date: 'YYYY-MM-DD', estimated: boolean } or null when Nasdaq has
// no upcoming date.

const NASDAQ_URL = 'https://api.nasdaq.com/api/analyst/{sym}/earnings-date';

export function parseNasdaqEarnings(json) {
  const text = json?.data?.reportText ?? '';
  const m = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return { date: `${m[3]}-${m[1]}-${m[2]}`, estimated: /estimated/i.test(text) };
}

export async function fetchEarningsDate(env, underlying) {
  const url = (env.EARNINGS_URL || NASDAQ_URL).replace('{sym}', encodeURIComponent(underlying));
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (OptionLens)', Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`earnings ${r.status}`);
  return parseNasdaqEarnings(await r.json());
}
