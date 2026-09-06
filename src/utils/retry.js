import { sleep } from './sleep.js';
import logger from '../logger/index.js';

/**
 * Retry an async function with exponential back-off.
 *
 * @param {Function} fn          - Async function to retry
 * @param {object}   opts
 * @param {number}   opts.attempts   - Max attempts (default 3)
 * @param {number}   opts.baseDelay  - Initial delay in ms (default 1000)
 * @param {number}   opts.maxDelay   - Cap on delay in ms (default 30 000)
 * @param {Function} opts.onRetry    - Called before each retry (err, attempt)
 * @param {Function} opts.shouldRetry - Return false to abort early
 */
export async function retry(fn, opts = {}) {
  const {
    attempts = 3,
    baseDelay = 1000,
    maxDelay = 30_000,
    onRetry = null,
    shouldRetry = (err) => err?.retryable !== false,
  } = opts;

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !shouldRetry(err)) throw err;

      const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      const jitter = Math.random() * delay * 0.2; // ±20 % jitter
      const wait   = Math.round(delay + jitter);

      logger.warn(`Retry ${attempt}/${attempts - 1} in ${wait}ms`, {
        error: err.message,
        code: err.code,
      });

      if (onRetry) await onRetry(err, attempt);
      await sleep(wait);
    }
  }
  throw lastError;
}
