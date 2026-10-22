import { AppError } from '../utils/AppError.js';
import { WEEK_STARTS, isValidDateString, localNow, parseNow } from '../utils/dates.js';
import { isObjectId } from '../utils/validation.js';

export const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parsePositiveInt(value, fallback, max = Infinity) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? Math.min(number, max) : fallback;
}

// Reads values from a query string safely. Every value must be one plain string of a known
// format or list; anything else (an array, an unknown word, a bad date) adds a problem to `errors`.
export function createQueryReader(query, errors) {
  const text = (name) => {
    const value = query[name];
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string') {
      errors.push({ field: name, message: `"${name}" must be a single value.` });
      return undefined;
    }
    return value;
  };

  const oneOf = (name, values) => {
    const value = text(name);
    if (value !== undefined && !values.includes(value)) {
      errors.push({ field: name, message: `"${name}" must be one of: ${values.join(', ')}.` });
      return undefined;
    }
    return value;
  };

  const date = (name) => {
    const value = text(name);
    if (value !== undefined && !isValidDateString(value)) {
      errors.push({ field: name, message: `"${name}" must be a real date written as YYYY-MM-DD.` });
      return undefined;
    }
    return value;
  };

  const bool = (name) => {
    const value = oneOf(name, ['true', 'false']);
    return value === undefined ? undefined : value === 'true';
  };

  // A subject/assignment filter: an id, or "none" for records without one.
  const reference = (name) => {
    const value = text(name);
    if (value !== undefined && value !== 'none' && !isObjectId(value)) {
      errors.push({ field: name, message: `"${name}" must be an id or "none".` });
      return undefined;
    }
    return value;
  };

  // "now" = the user's local date and time, so overdue/due-soon match what they see on their clock.
  const now = () => {
    const value = text('now');
    const parsed = value === undefined ? localNow() : parseNow(value);
    if (!parsed) errors.push({ field: 'now', message: '"now" must look like 2026-10-21T14:30.' });
    return parsed;
  };

  const search = () => {
    const value = text('q')?.trim();
    if (value && value.length > 100) errors.push({ field: 'q', message: 'Search text must be at most 100 characters.' });
    return value;
  };

  // The week-start preference sent by the browser ("monday" when not sent).
  const weekStart = () => oneOf('weekStart', WEEK_STARTS) ?? 'monday';

  return { text, oneOf, date, bool, reference, now, search, weekStart };
}

// For single-record endpoints: reads ?now= (or uses the computer's clock).
export function parseNowQuery(query) {
  if (query.now === undefined || query.now === '') return localNow();
  const now = parseNow(query.now);
  if (!now) throw new AppError('"now" must look like 2026-10-21T14:30.', 400);
  return now;
}

// For endpoints that group days into weeks: reads ?weekStart=monday|sunday (monday when missing).
export function parseWeekStartQuery(query) {
  const errors = [];
  const weekStart = createQueryReader(query, errors).weekStart();
  if (errors.length > 0) throw new AppError(errors[0].message, 400, errors);
  return weekStart;
}
