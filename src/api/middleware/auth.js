import jwt from 'jsonwebtoken';
import config from '../../config/index.js';
import { ValidationError } from '../../errors/index.js';

/**
 * JWT auth middleware.
 * Accepts either:
 *   Authorization: Bearer <jwt>
 *   X-API-Key: <api_key>
 */
export function authenticate(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && config.auth.apiKey && apiKey === config.auth.apiKey) {
    req.user = { role: 'api' };
    return next();
  }

  const authHeader = req.headers['authorization'] ?? '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    req.user = jwt.verify(token, config.auth.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
