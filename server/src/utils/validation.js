import { AppError } from './AppError.js';

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

// A MongoDB id is exactly 24 hex characters. Reject anything else before it reaches the database.
export function isObjectId(value) {
  return typeof value === 'string' && OBJECT_ID_PATTERN.test(value);
}

// Express middleware: validates a URL parameter such as /subjects/:id
export function validateIdParam(paramName = 'id') {
  return (req, res, next) => {
    if (!isObjectId(req.params[paramName])) {
      return next(new AppError(`"${req.params[paramName]}" is not a valid id.`, 400));
    }
    next();
  };
}

// The request body must be a plain JSON object (not an array, not empty).
export function readBody(req) {
  const body = req.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

// Reads one text field. Problems are added to `errors`; the cleaned (trimmed) text is returned.
export function readText(input, field, { label, max, required = false }, errors) {
  const value = input[field];

  if (value === undefined || value === null) {
    if (required) errors.push({ field, message: `${label} is required.` });
    return '';
  }
  if (typeof value !== 'string') {
    errors.push({ field, message: `${label} must be text.` });
    return '';
  }

  const trimmed = value.trim();
  if (required && !trimmed) errors.push({ field, message: `${label} cannot be blank.` });
  if (trimmed.length > max) errors.push({ field, message: `${label} must be at most ${max} characters.` });
  return trimmed;
}

// Reads a field that must be one of a fixed list. Missing/empty falls back to `defaultValue`.
export function readEnum(input, field, { label, values, defaultValue }, errors) {
  const value = input[field];
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value !== 'string' || !values.includes(value)) {
    errors.push({ field, message: `${label} must be one of: ${values.join(', ')}.` });
    return defaultValue;
  }
  return value;
}

export function throwIfErrors(errors) {
  if (errors.length > 0) throw new AppError('Validation failed.', 400, errors);
}

// Shared JSON output format for models: "id" instead of "_id", and no "__v".
export const jsonOptions = {
  versionKey: false,
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
};
