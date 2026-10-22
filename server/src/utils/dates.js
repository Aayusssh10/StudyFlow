// Date helpers. Due dates are stored as plain "YYYY-MM-DD" text (and times as "HH:mm"),
// NOT as JavaScript Date objects. A Date is a moment in UTC, so converting it to a local
// day can shift the calendar date by one. Plain text never shifts.

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const NOW_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;

export const MIN_DATE = '2000-01-01';
export const MAX_DATE = '2100-12-31';
export const DUE_SOON_DAYS = 3;

// True only for real calendar dates ("2026-02-30" is rejected).
export function isValidDateString(value) {
  const match = typeof value === 'string' && DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const isValidTimeString = (value) => typeof value === 'string' && TIME_PATTERN.test(value);

// Adds days to a "YYYY-MM-DD" date using UTC arithmetic (no daylight-saving surprises).
export function addDays(dateString, days) {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

const pad = (number) => String(number).padStart(2, '0');

// The current date and time on this computer, as { date: "YYYY-MM-DD", time: "HH:mm" }.
export function localNow() {
  const now = new Date();
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
}

// Parses "YYYY-MM-DDTHH:mm" (the browser's local time, sent as ?now=...). Returns null if invalid.
export function parseNow(value) {
  const match = typeof value === 'string' && NOW_PATTERN.exec(value);
  if (!match || !isValidDateString(match[1]) || !isValidTimeString(match[2])) return null;
  return { date: match[1], time: match[2] };
}

// Whole days from `from` to `to` (both "YYYY-MM-DD"); negative when `to` is earlier.
export function daysBetween(from, to) {
  const toUtc = (value) => {
    const [year, month, day] = value.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtc(to) - toUtc(from)) / 86400000);
}

export const WEEK_STARTS = ['monday', 'sunday'];

// The 7-day week that contains `dateString`, as { from, to } ("YYYY-MM-DD" each). It starts on Monday (the default)
// or Sunday, following the week-start preference from the Settings page.
export function weekRange(dateString, weekStart = 'monday') {
  const [year, month, day] = dateString.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  const daysSinceStart = weekStart === 'sunday' ? weekday : (weekday + 6) % 7;
  const from = addDays(dateString, -daysSinceStart);
  return { from, to: addDays(from, 6) };
}
