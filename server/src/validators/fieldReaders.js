import { MAX_DATE, MIN_DATE, isValidDateString, isValidTimeString } from '../utils/dates.js';
import { isObjectId } from '../utils/validation.js';

// Readers for request-body fields shared by assignments and tasks. Each one adds problems to `errors`
// and returns a cleaned value. Request bodies are plain JSON, so every value is checked for its TYPE too.

const isEmpty = (value) => value === undefined || value === null || value === '';

// A real calendar date written YYYY-MM-DD (so "2026-02-30" is rejected), required.
export function readDate(input, field, label, errors) {
  const value = input[field];
  if (isEmpty(value)) {
    errors.push({ field, message: `${label} is required.` });
  } else if (!isValidDateString(value)) {
    errors.push({ field, message: `${label} must be a real date written as YYYY-MM-DD.` });
  } else if (value < MIN_DATE || value > MAX_DATE) {
    errors.push({ field, message: `${label} must be between ${MIN_DATE} and ${MAX_DATE}.` });
  }
  return typeof value === 'string' ? value : '';
}

// An optional time of day written HH:mm (24-hour). Empty means "no time".
export function readTime(input, field, label, errors) {
  const value = input[field];
  if (isEmpty(value)) return '';
  if (!isValidTimeString(value)) {
    errors.push({ field, message: `${label} must be written as HH:mm (24-hour), for example 14:30.` });
    return '';
  }
  return value;
}

// An optional link to another record: empty means "none"; otherwise it must look like an id.
// (Whether that record EXISTS is checked inside the transaction that saves the link, not here.)
export function readReference(input, field, { label, noun }, errors) {
  const value = input[field];
  if (isEmpty(value)) return null;
  if (!isObjectId(value)) {
    errors.push({ field, message: `${label} must be a valid ${noun} id.` });
    return null;
  }
  return value;
}
