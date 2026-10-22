import mongoose from 'mongoose';
import { AppError } from '../utils/AppError.js';
import { isObjectId, throwIfErrors } from '../utils/validation.js';
import { createQueryReader } from './queryHelpers.js';

export const EXPORT_TYPES = ['assignments', 'tasks', 'study-sessions'];

// GET /api/reports/summary and /api/reports/export share these filters:
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD (both optional and inclusive; leave both out for "all time")
//   &subject=<id> (optional) &weekStart=monday|sunday &now=YYYY-MM-DDTHH:mm
// Every value must be one plain string of a known format; anything else is a 400.
export function parseReportQuery(query, { exporting = false } = {}) {
  const errors = [];
  const read = createQueryReader(query, errors);

  const from = read.date('from');
  const to = read.date('to');
  const subject = read.text('subject');
  if (subject !== undefined && !isObjectId(subject)) errors.push({ field: 'subject', message: '"subject" must be a subject id.' });
  const weekStart = read.weekStart();
  const now = read.now();

  let type;
  if (exporting) {
    type = read.oneOf('type', EXPORT_TYPES);
    if (type === undefined && !errors.some((error) => error.field === 'type')) {
      errors.push({ field: 'type', message: `"type" is required: one of ${EXPORT_TYPES.join(', ')}.` });
    }
  }

  throwIfErrors(errors);
  if (from && to && from > to) throw new AppError('"from" must not be after "to".', 400);

  return { from, to, subject: subject ? new mongoose.Types.ObjectId(subject) : undefined, weekStart, now, type };
}
