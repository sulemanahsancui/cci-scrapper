/**
 * Centralised error hierarchy.
 *
 * Every domain error carries:
 *   - code      → machine-readable string (for consumers / monitoring)
 *   - retryable → hint to retry logic whether to attempt again
 *   - context   → arbitrary metadata for structured logging
 */

export class FrameworkError extends Error {
  constructor(message, { code = 'FRAMEWORK_ERROR', retryable = false, context = {} } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.retryable = retryable;
    this.context = context;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class BrowserError extends FrameworkError {
  constructor(message, context = {}) {
    super(message, { code: 'BROWSER_ERROR', retryable: true, context });
  }
}

export class ProxyError extends FrameworkError {
  constructor(message, context = {}) {
    super(message, { code: 'PROXY_ERROR', retryable: true, context });
  }
}

export class CaptchaError extends FrameworkError {
  constructor(message, context = {}) {
    super(message, { code: 'CAPTCHA_ERROR', retryable: true, context });
  }
}

export class CloudflareError extends FrameworkError {
  constructor(message, context = {}) {
    super(message, { code: 'CLOUDFLARE_ERROR', retryable: true, context });
  }
}

export class ParsingError extends FrameworkError {
  constructor(message, context = {}) {
    super(message, { code: 'PARSING_ERROR', retryable: false, context });
  }
}

export class ValidationError extends FrameworkError {
  constructor(message, context = {}) {
    super(message, { code: 'VALIDATION_ERROR', retryable: false, context });
  }
}

export class RateLimitError extends FrameworkError {
  constructor(message, retryAfterMs = 60_000, context = {}) {
    super(message, { code: 'RATE_LIMIT_ERROR', retryable: true, context });
    this.retryAfterMs = retryAfterMs;
  }
}

export class SessionExpiredError extends FrameworkError {
  constructor(message, context = {}) {
    super(message, { code: 'SESSION_EXPIRED', retryable: true, context });
  }
}
