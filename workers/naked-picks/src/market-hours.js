// NYSE / NASDAQ regular-session calendar (both exchanges share it).
// Times are America/New_York. Extend the tables each December.

export const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

// 13:00 ET early closes
export const EARLY_CLOSES = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const EARLY_CLOSE_MIN = 13 * 60;

// { date: 'YYYY-MM-DD', minutes: minutes since ET midnight, dow: 0..6 }
export function etParts(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
    }).formatToParts(now).map(p => [p.type, p.value]),
  );
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    dow,
  };
}

export function isTradingDay(date, dow) {
  return dow >= 1 && dow <= 5 && !HOLIDAYS.has(date);
}

export function sessionClose(date) {
  return EARLY_CLOSES.has(date) ? EARLY_CLOSE_MIN : CLOSE_MIN;
}

export function marketStatus(now = new Date()) {
  const { date, minutes, dow } = etParts(now);
  const trading = isTradingDay(date, dow);
  const close = sessionClose(date);
  const open = trading && minutes >= OPEN_MIN && minutes <= close;
  return { date, minutes, open, trading, closeMinutes: close };
}

// Whole calendar days between two YYYY-MM-DD dates.
export function daysBetween(fromDate, toDate) {
  const a = Date.UTC(...fromDate.split('-').map((v, i) => (i === 1 ? v - 1 : +v)));
  const b = Date.UTC(...toDate.split('-').map((v, i) => (i === 1 ? v - 1 : +v)));
  return Math.round((b - a) / 86400000);
}

export function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
