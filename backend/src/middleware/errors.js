const { ZodError } = require('zod');
const { HttpError } = require('../utils/httpError');

const notFoundHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
};

// MySQL / MariaDB error codes -> friendly HTTP responses
function mapDbError(err) {
  switch (err.code) {
    case 'ER_DUP_ENTRY':
      return { status: 409, code: 'DUPLICATE', message: 'A record with the same unique value already exists' };
    case 'ER_NO_REFERENCED_ROW_2':
      return { status: 400, code: 'INVALID_REFERENCE', message: 'A referenced record does not exist' };
    case 'ER_ROW_IS_REFERENCED_2':
      return { status: 409, code: 'IN_USE', message: 'This record is in use and cannot be removed. Deactivate it instead' };
    case 'ER_CHECK_CONSTRAINT_VIOLATED':
    case 'ER_CONSTRAINT_FAILED':
      return { status: 409, code: 'CONSTRAINT_VIOLATION', message: 'The operation would violate a data integrity rule' };
    default:
      return null;
  }
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
  }
  const mapped = mapDbError(err);
  if (mapped) return res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });

  // Unexpected error: log details server-side only, return a generic message to the client
  console.error(JSON.stringify({ level: 'error', message: err.message, code: err.code, stack: err.stack, path: req.originalUrl }));
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
}

module.exports = { notFoundHandler, errorHandler };
