import { PRIORITIES } from '../models/Task.js';
import { readBody, readEnum, readText, throwIfErrors } from '../utils/validation.js';
import { readDate, readReference, readTime } from './fieldReaders.js';

// Picks ONLY the fields users may set (so _id, createdAt, priorityRank, timeSort etc. in the body are ignored).
export function validateTaskInput(req) {
  const input = readBody(req);
  const errors = [];

  const task = {
    title: readText(input, 'title', { label: 'Title', max: 150, required: true }, errors),
    description: readText(input, 'description', { label: 'Description', max: 1000 }, errors),
    date: readDate(input, 'date', 'Date', errors),
    time: readTime(input, 'time', 'Time', errors),
    priority: readEnum(input, 'priority', { label: 'Priority', values: PRIORITIES, defaultValue: 'Medium' }, errors),
    completed: readCompleted(input, 'completed', errors, false),
    subject: readReference(input, 'subject', { label: 'Subject', noun: 'subject' }, errors),
    assignment: readReference(input, 'assignment', { label: 'Assignment', noun: 'assignment' }, errors),
  };

  if (task.subject && task.assignment) {
    errors.push({ field: 'assignment', message: 'A task links to a subject or an assignment, not both.' });
  }

  throwIfErrors(errors);
  return task;
}

// PATCH /:id/completed: only the done/not-done flag.
export function validateCompletedInput(req) {
  const errors = [];
  const completed = readCompleted(readBody(req), 'completed', errors, null);
  if (completed === null && errors.length === 0) errors.push({ field: 'completed', message: 'Completed is required (true or false).' });
  throwIfErrors(errors);
  return completed;
}

// Only the JSON booleans true / false are accepted (not "true", 1 or {}).
function readCompleted(input, field, errors, defaultValue) {
  const value = input[field];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    errors.push({ field, message: 'Completed must be true or false.' });
    return defaultValue;
  }
  return value;
}
