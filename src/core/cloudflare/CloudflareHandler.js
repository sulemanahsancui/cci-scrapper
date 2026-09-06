/**
 * CloudflareHandler — detects and bypasses Cloudflare protection layers.
 *
 * Supported challenges:
 *   1. JS challenge (5-second shield)   → wait for auto-resolve
 *   2. reCAPTCHA v2 (checkbox + grid)  → RecaptchaV2Service
 *   3. Turnstile                        → TurnstileInterceptor (intercept + callback)
 *
 * Turnstile usage — inject BEFORE navigation, bypass AFTER:
 *
 *   await cloudflareHandler.prepareForTurnstile(page); // before page.goto()
 *   await page.goto(url);
 *   await cloudflareHandler.bypass(page);              // after page load
 *
 * Or for simple cases where you are unsure if Turnstile will appear:
 *
 *   await cloudflareHandler.bypass(page);              // detects & routes automatically
 */

import { CloudflareError }  from '../../errors/index.js';
import { sleep }            from '../../utils/sleep.js';
import RecaptchaV2Service   from '../captcha/RecaptchaV2Service.js';
import TurnstileInterceptor from './TurnstileInterceptor.js';
import logger               from '../../logger/index.js';

const CF_INDICATORS = [
  'Just a moment',
  'Checking your browser',
  'Verification',
  'challenge-platform',
  'cf-browser-verification',
  'cf_clearance',
  'DDoS protection by Cloudflare',
  'cloudflare.com/cdn-cgi',
];

export class CloudflareHandler {
  constructor(options = {}) {
    this.maxWait      = options.maxWait      ?? 30_000;
    this.pollInterval = options.pollInterval ?? 2_000;

    // Lazy-init — only constructed when a 2Captcha key is present
    this._recaptchaV2   = options.recaptchaV2Service  ?? null;
    this._interceptor   = options.turnstileInterceptor ?? null;
  }

  // ── Lazy accessors ──────────────────────────────────────────────────────────

  get recaptchaV2() {
    if (!this._recaptchaV2) {
      try { this._recaptchaV2 = RecaptchaV2Service.getInstance(); } catch { /* no key */ }
    }
    return this._recaptchaV2;
  }

  get interceptor() {
    if (!this._interceptor) {
      try { this._interceptor = new TurnstileInterceptor(); } catch { /* no key */ }
    }
    return this._interceptor;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Inject the Turnstile interceptor BEFORE page.goto().
   * This patches window.turnstile.render so all Cloudflare params are captured.
   * Call once per page immediately after creation.
   *
   * @param {import('playwright').Page} page
   */
  async prepareForTurnstile(page) {
    if (this.interceptor) {
      await this.interceptor.injectInterceptor(page);
    }
  }

  /**
   * Detect and bypass a Cloudflare challenge on the current page.
   *
   * Returns true  → challenge was present and bypassed.
   * Returns false → no challenge detected.
   * Throws CloudflareError → challenge detected but could not be solved.
   *
   * @param {import('playwright').Page} page
   */
  async bypass(page) {
    if (!await this.isBlocked(page)) return false;

    logger.info('Cloudflare challenge detected', { url: page.url() });

    // 1. Wait for JS-only challenge to auto-resolve (5-second shield)
    const autoResolved = await this._waitForResolution(page);
    if (autoResolved) {
      logger.info('Cloudflare JS challenge auto-resolved');
      return true;
    }

    // 2. Turnstile — use interceptor (fires original tsCallback with all params)
    const hasTurnstile = await this._hasTurnstile(page);
    if (hasTurnstile) {
      if (!this.interceptor) {
        throw new CloudflareError(
          'Turnstile detected but TWO_CAPTCHA_API_KEY is not configured',
          { url: page.url() },
        );
      }
      const solved = await this.interceptor.solve(page);
      if (solved) return true;
    }

    // 3. reCAPTCHA v2 (checkbox + grid) — appears in some CF managed challenges
    const hasRecaptcha = await this._hasRecaptchaV2(page);
    if (hasRecaptcha) {
      if (!this.recaptchaV2) {
        throw new CloudflareError(
          'reCAPTCHA v2 detected but TWO_CAPTCHA_API_KEY is not configured',
          { url: page.url() },
        );
      }
      logger.info('Cloudflare reCAPTCHA v2 detected');
      const result = await this.recaptchaV2.detectAndSolveGmailCaptcha(page);
      if (result.success) {
        logger.info('Cloudflare reCAPTCHA v2 solved', { solution: result.solution });
        return true;
      }
      logger.warn('Cloudflare reCAPTCHA v2 failed', { error: result.error });
    }

    throw new CloudflareError('Could not bypass Cloudflare challenge', { url: page.url() });
  }

  /** Returns true if the current page is showing a Cloudflare challenge. */
  async isBlocked(page) {
    try {
      const [title, content] = await Promise.all([
        page.title().catch(() => ''),
        page.content().catch(() => ''),
      ]);
      return CF_INDICATORS.some(
        (indicator) => title.includes(indicator) || content.includes(indicator),
      );
    } catch {
      return false;
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  async _waitForResolution(page) {
    const deadline = Date.now() + this.maxWait;
    while (Date.now() < deadline) {
      await sleep(this.pollInterval);
      if (!await this.isBlocked(page)) return true;
    }
    return false;
  }

  async _hasTurnstile(page) {
    try {
      // Either the DOM widget exists OR the interceptor already captured cfParams
      return await page.evaluate(() =>
        !!document.querySelector('.cf-turnstile, [data-sitekey][class*="turnstile"]') ||
        !!window.cfParams,
      );
    } catch {
      return false;
    }
  }

  async _hasRecaptchaV2(page) {
    try {
      return (await page.$('iframe[title="reCAPTCHA"]')) !== null;
    } catch {
      return false;
    }
  }
}

export default CloudflareHandler;
