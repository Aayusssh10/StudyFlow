import mongoose from 'mongoose';
import { AppError } from '../utils/AppError.js';
import { daysBetween } from '../utils/dates.js';
import { isObjectId, throwIfErrors } from '../utils/validation.js';
import { createQueryReader } from './queryHelpers.js';

export const EVENT_TYPES = ['assignment', 'task', 'session'];
export const MAX_RANGE_DAYS = 62; // a month view plus the days of the neighbouring weeks fits comfortably

// GET /api/calendar?from=&to=&types=assignment,task,session&subject=<id>&now=
// from/to are required and inclusive. Every value must be one plain string of a known format; anything else is a 400.
export function parseCalendarQuery(query) {
  const errors = [];
  const read = createQueryReader(query, errors);

  const from = read.date('from');
  const to = read.date('to');
  if (query.from === undefined || query.from === '') errors.push({ field: 'from', message: '"from" is required.' });
  if (query.to === undefined || query.to === '') errors.push({ field: 'to', message: '"to" is required.' });

  let types = EVENT_TYPES;
  const typesText = read.text('types');
  if (typesText !== undefined) {
    const requested = typesText.split(',').map((type) => type.trim());
    const unknown = requested.filter((type) => !EVENT_TYPES.includes(type));
    if (unknown.length > 0) {
      errors.push({ field: 'types', message: `"types" must be a comma-separated list of: ${EVENT_TYPES.join(', ')}.` });
    } else {
      types = EVENT_TYPES.filter((type) => requested.includes(type));
    }
  }

  const subject = read.text('subject');
  if (subject !== undefined && !isObjectId(subject)) errors.push({ field: 'subject', message: '"subject" must be a subject id.' });
  const now = read.now();

  throwIfErrors(errors);

  if (from > to) throw new AppError('"from" must not be after "to".', 400);
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) {
    throw new AppError(`The date range can be at most ${MAX_RANGE_DAYS} days.`, 400);
  }

  return { from, to, types, subject: subject ? new mongoose.Types.ObjectId(subject) : undefined, now };
}
