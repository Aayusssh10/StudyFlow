import { AppError } from '../utils/AppError.js';
import { isProduction } from '../config/env.js';

// Unknown routes, e.g. GET /api/nothing-here
export function notFound(req, res) {
  res.status(404).json({
    success: false,
    error: { message: `Route not found: ${req.method} ${req.originalUrl}` },
  });
}

// Turns known problems into clean responses. Express calls this for any error.
function describeError(error) {
  if (error instanceof AppError) {
    return { status: error.statusCode, message: error.message, details: error.details };
  }
  // express.json() rejects malformed JSON bodies
  if (error.type === 'entity.parse.failed') {
    return { status: 400, message: 'Request body is not valid JSON.' };
  }
  if (error.type === 'entity.too.large') {
    return { status: 413, message: 'Request body is too large.' };
  }
  // Mongoose validation (e.g. a required field is missing)
  if (error.name === 'ValidationError' && error.errors) {
    const details = Object.values(error.errors).map((e) => ({ field: e.path, message: e.message }));
    return { status: 400, message: 'Validation failed.', details };
  }
  // A transaction kept conflicting with other work for too long (it is retried automatically for up to
  // about 100 seconds, for example while waiting out a crashed request's unfinished transaction)
  if (error.errorLabels?.includes?.('TransientTransactionError') || error.hasErrorLabel?.('TransientTransactionError')) {
    return { status: 503, message: 'The server is busy with another change to the same data. Please try again in a moment.' };
  }
  // The record was deleted by another request between our lookup and our save
  if (error.name === 'DocumentNotFoundError') {
    return { status: 404, message: 'Record not found.' };
  }
  // MongoDB unique-index violation (e.g. two requests created the same subject name at once)
  if (error.code === 11000) {
    return { status: 409, message: 'A record with that value already exists.' };
  }
  // Mongoose could not cast a value, e.g. a bad ObjectId
  if (error.name === 'CastError') {
    return { status: 400, message: `Invalid value for "${error.path}".` };
  }
  return { status: 500, message: 'Something went wrong on the server.' };
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  const { status, message, details } = describeError(error);
  if (status === 500) {
    console.error(isProduction() ? error.message : error); // log server-side only
  }

  const body = { success: false, error: { message } };
  if (details) body.error.details = details;
  res.status(status).json(body);
}
