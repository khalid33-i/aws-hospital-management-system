class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

module.exports = {
  HttpError,
  badRequest: (message, details, code = 'BAD_REQUEST') => new HttpError(400, code, message, details),
  unauthorized: (message = 'Authentication required') => new HttpError(401, 'UNAUTHORIZED', message),
  forbidden: (message = 'You do not have permission to perform this action') => new HttpError(403, 'FORBIDDEN', message),
  notFound: (message = 'Resource not found') => new HttpError(404, 'NOT_FOUND', message),
  conflict: (message, code = 'CONFLICT', details) => new HttpError(409, code, message, details),
};
