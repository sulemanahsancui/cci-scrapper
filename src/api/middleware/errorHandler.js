import { FrameworkError, ValidationError } from '../../errors/index.js';
import logger from '../../logger/index.js';

/** Express error-handling middleware — must be registered last. */
export function errorHandler(err, req, res, next) {
  // Log all errors
  logger.error('API error', {
    path: req.path,
    method: req.method,
    error: err.message,
    code: err.code,
    stack: err.stack,
  });

  if (err instanceof ValidationError) {
    return res.status(400).json({ error: err.message, code: err.code });
  }

  if (err instanceof FrameworkError) {
    return res.status(500).json({ error: err.message, code: err.code });
  }

  // Express validation errors (express-validator)
  if (err.array) {
    return res.status(400).json({ error: 'Validation failed', details: err.array() });
  }

  // Generic
  const status = err.status ?? err.statusCode ?? 500;
  res.status(status).json({
    error: status < 500 ? err.message : 'Internal server error',
  });
}
