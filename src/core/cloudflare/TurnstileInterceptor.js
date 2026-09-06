/**
 * TurnstileInterceptor — Cloudflare Turnstile bypass via render() interception.
 *
 * How it works:
 *   1. injectInterceptor(page) must be called BEFORE page.goto() — it patches
 *      window.turnstile.render so Cloudflare's own JS hands us the full params
 *      (sitekey, action, cData, chlPageData, userAgent) instead of us having to
 *      scrape them from the DOM.
 *   2. solve(page) waits for those params to appear, sends them to 2captcha's
 *      turnstile endpoint (with all extra fields for a higher solve rate), then
 *      fires the original tsCallback — the same path Cloudflare uses internally.
 *
 * This is superior to DOM-injection because:
 *   - cData / chlPageData / action are captured automatically (improve solve rate)
 *   - The token is delivered via the original JS callback, not a hidden input
 *   - No need to find or submit a form
 *
 * Usage:
 *   // Before navigation:
 *   await interceptor.injectInterceptor(page);
 *   await page.goto(url);
 *
 *   // After navigation, if Cloudflare wall is detected:
 *   await interceptor.solve(page);
 */

import axios  from 'axios';
import config from '../../config/index.js';
import logger from '../../logger/index.js';
import { sleep } from '../../utils/sleep.js';
import { CloudflareError } from '../../errors/index.js';

const TWO_CAPTCHA_IN  = 'https://2captcha.com/in.php';
const TWO_CAPTCHA_RES = 'https://2captcha.com/res.php';
const POLL_INTERVAL   = 5_000;
const POLL_TIMEOUT    = 120_000; // 2 min max

export class TurnstileInterceptor {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? config.captcha.twoCaptcha.apiKey ?? '';
    if (!this.apiKey) {
      throw new CloudflareError('TWO_CAPTCHA_API_KEY is required for TurnstileInterceptor');
    }
  }

  /**
   * Patch window.turnstile.render BEFORE page load so we capture all params.
   * Call this immediately after creating the page, before any navigation.
   *
   * @param {import('playwright').Page} page
   */
  async injectInterceptor(page) {
    await page.addInitScript(() => {
      const i = setInterval(() => {
        if (window.turnstile) {
          clearInterval(i);

          window.turnstile.render = (a, b) => {
            // Capture every param Cloudflare passes — these improve 2captcha solve rate
            window.cfParams = {
              sitekey:     b.sitekey,
              action:      b.action,
              cData:       b.cData,
              chlPageData: b.chlPageData,
              userAgent:   navigator.userAgent,
            };
            // Preserve the original callback so we can fire it with the token
            window.tsCallback = b.callback;
            return 'foo';
          };
        }
      }, 10);
    });

    logger.debug('Turnstile interceptor injected');
  }

  /**
   * Detect Cloudflare challenge, extract intercepted params, solve via 2captcha,
   * and fire the original tsCallback with the solution token.
   *
   * @param {import('playwright').Page} page
   * @returns {Promise<boolean>} true if solved, false if no challenge detected
   */
  async solve(page) {
    const title = await page.title().catch(() => '');
    const isCfChallenge = title.includes('Just a moment') || title.includes('Verification');
    if (!isCfChallenge) return false;

    logger.info('Cloudflare Turnstile challenge detected', { url: page.url() });

    const params = await this._waitForParams(page);
    logger.debug('Turnstile params extracted', {
      sitekey: params.sitekey,
      action:  params.action,
    });

    const token = await this._submitTo2Captcha(params, page.url());
    logger.debug('Turnstile token received from 2captcha');

    await this._fireCallback(page, token);

    await page.waitForNavigation({ timeout: 60_000 }).catch(() => {});
    logger.info('Cloudflare Turnstile challenge passed');
    return true;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Wait until the intercepted window.cfParams is populated.
   * The interceptor sets this when Cloudflare calls turnstile.render().
   */
  async _waitForParams(page) {
    const handle = await page.waitForFunction(
      () => window.cfParams,
      { timeout: 20_000 },
    );
    return handle.jsonValue();
  }

  /**
   * Submit to 2captcha's turnstile method with all available params.
   * The extra fields (action, data, pagedata, userAgent) raise the solve rate.
   */
  async _submitTo2Captcha(params, pageUrl) {
    const payload = new URLSearchParams({
      method:    'turnstile',
      key:       this.apiKey,
      sitekey:   params.sitekey,
      pageurl:   pageUrl,
      json:      '1',
      ...(params.action      && { action:    params.action }),
      ...(params.cData       && { data:      params.cData }),
      ...(params.chlPageData && { pagedata:  params.chlPageData }),
      ...(params.userAgent   && { userAgent: params.userAgent }),
    });

    const { data: submitData } = await axios.post(TWO_CAPTCHA_IN, payload.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (submitData.status !== 1) {
      throw new CloudflareError('2captcha Turnstile submit failed', {
        response: submitData,
      });
    }

    const requestId = submitData.request;
    logger.debug('2captcha Turnstile task created', { requestId });

    return this._pollResult(requestId);
  }

  /** Poll 2captcha until the token is ready or timeout is reached. */
  async _pollResult(requestId) {
    const deadline = Date.now() + POLL_TIMEOUT;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL);

      const { data } = await axios.get(TWO_CAPTCHA_RES, {
        params: {
          key:    this.apiKey,
          action: 'get',
          id:     requestId,
          json:   1,
        },
      });

      if (data.status === 1) return data.request;
      if (data.request !== 'CAPCHA_NOT_READY') {
        throw new CloudflareError('2captcha Turnstile poll error', { response: data });
      }
    }

    throw new CloudflareError('2captcha Turnstile polling timed out', { requestId });
  }

  /**
   * Deliver the token by firing Cloudflare's own callback — the same mechanism
   * the browser uses when a real user solves the widget.
   */
  async _fireCallback(page, token) {
    await page.evaluate((t) => {
      if (window.tsCallback) window.tsCallback(t);
    }, token);
  }
}

export default TurnstileInterceptor;
