import { MAX_DURATION_MINUTES, SESSION_TYPES } from '../models/StudySession.js';
import { readBody, readEnum, readText, throwIfErrors } from '../utils/validation.js';
import { readDate, readReference, readTime } from './fieldReaders.js';

const isEmpty = (value) => value === undefined || value === null || value === '';

// Duration in whole minutes, 1 to 1440. Accepts a number or a string of digits (a form field value).
function readDuration(input, errors) {
  const value = input.durationMinutes;
  if (isEmpty(value)) {
    errors.push({ field: 'durationMinutes', message: 'Duration is required.' });
    return null;
  }
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > MAX_DURATION_MINUTES) {
    errors.push({ field: 'durationMinutes', message: `Duration must be a whole number of minutes from 1 to ${MAX_DURATION_MINUTES}.` });
    return null;
  }
  return number;
}

// Picks ONLY the fields users may set (so _id, createdAt etc. in the body are ignored).
// The subject is REQUIRED; the assignment is optional.
export function validateStudySessionInput(req) {
  const input = readBody(req);
  const errors = [];

  const session = {
    subject: readReference(input, 'subject', { label: 'Subject', noun: 'subject' }, errors),
    assignment: readReference(input, 'assignment', { label: 'Assignment', noun: 'assignment' }, errors),
    date: readDate(input, 'date', 'Date', errors),
    startTime: readTime(input, 'startTime', 'Start time', errors),
    durationMinutes: readDuration(input, errors),
    notes: readText(input, 'notes', { label: 'Notes', max: 1000 }, errors),
    type: readEnum(input, 'type', { label: 'Type', values: SESSION_TYPES, defaultValue: '' }, errors),
  };

  if (!session.subject && isEmpty(input.subject)) errors.push({ field: 'subject', message: 'Subject is required.' });

  throwIfErrors(errors);
  return session;
}
