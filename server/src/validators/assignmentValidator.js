import { MAX_ESTIMATED_MINUTES, PRIORITIES, STATUSES, TYPES } from '../models/Assignment.js';
import { readBody, readEnum, readText, throwIfErrors } from '../utils/validation.js';
import { readDate, readReference, readTime } from './fieldReaders.js';

const isEmpty = (value) => value === undefined || value === null || value === '';

function readEstimatedMinutes(input, errors) {
  const value = input.estimatedMinutes;
  if (isEmpty(value)) return null;

  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > MAX_ESTIMATED_MINUTES) {
    errors.push({ field: 'estimatedMinutes', message: `Estimated minutes must be a whole number from 1 to ${MAX_ESTIMATED_MINUTES}.` });
    return null;
  }
  return number;
}

// Picks ONLY the fields users may set (so _id, createdAt, priorityRank etc. in the body are ignored).
export function validateAssignmentInput(req) {
  const input = readBody(req);
  const errors = [];

  const assignment = {
    title: readText(input, 'title', { label: 'Title', max: 150, required: true }, errors),
    description: readText(input, 'description', { label: 'Description', max: 2000 }, errors),
    subject: readReference(input, 'subject', { label: 'Subject', noun: 'subject' }, errors),
    dueDate: readDate(input, 'dueDate', 'Due date', errors),
    dueTime: readTime(input, 'dueTime', 'Due time', errors),
    priority: readEnum(input, 'priority', { label: 'Priority', values: PRIORITIES, defaultValue: 'Medium' }, errors),
    status: readEnum(input, 'status', { label: 'Status', values: STATUSES, defaultValue: 'Not Started' }, errors),
    estimatedMinutes: readEstimatedMinutes(input, errors),
    type: readEnum(input, 'type', { label: 'Type', values: TYPES, defaultValue: '' }, errors),
  };

  throwIfErrors(errors);
  return assignment;
}

export function validateStatusInput(req) {
  const errors = [];
  const status = readEnum(readBody(req), 'status', { label: 'Status', values: STATUSES, defaultValue: null }, errors);
  if (status === null && errors.length === 0) errors.push({ field: 'status', message: 'Status is required.' });
  throwIfErrors(errors);
  return status;
}
