import { DEFAULT_SUBJECT_COLOR } from '../models/Subject.js';
import { readBody, readText, throwIfErrors } from '../utils/validation.js';

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

// Picks ONLY the fields users are allowed to set (prevents "mass assignment":
// a client cannot sneak in _id, createdAt or database operators like $set).
export function validateSubjectInput(req) {
  const input = readBody(req);
  const errors = [];

  const subject = {
    name: readText(input, 'name', { label: 'Subject name', max: 100, required: true }, errors),
    code: readText(input, 'code', { label: 'Subject code', max: 20 }, errors),
    description: readText(input, 'description', { label: 'Description', max: 500 }, errors),
    instructor: readText(input, 'instructor', { label: 'Instructor', max: 100 }, errors),
    color: DEFAULT_SUBJECT_COLOR,
  };

  if (input.color !== undefined && input.color !== null && input.color !== '') {
    if (typeof input.color === 'string' && COLOR_PATTERN.test(input.color)) {
      subject.color = input.color.toLowerCase();
    } else {
      errors.push({ field: 'color', message: 'Color must look like #4f46e5.' });
    }
  }

  throwIfErrors(errors);
  return subject;
}
