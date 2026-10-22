// An error we throw on purpose, with the HTTP status code to send back.
// Example: throw new AppError('Subject not found', 404);
export class AppError extends Error {
  constructor(message, statusCode = 500, details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
  }
}
