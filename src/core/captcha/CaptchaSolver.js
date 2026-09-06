/**
 * CaptchaSolver — provider-agnostic captcha resolution layer.
 *
 * Usage:
 *   const token = await captchaSolver.solve({
 *     type: 'recaptcha_v2',
 *     siteKey: '...',
 *     pageUrl: 'https://...',
 *   });
 *
 * Inject the returned token into the page:
 *   await page.evaluate((t) => {
 *     document.getElementById('g-recaptcha-response').value = t;
 *   }, token);
 */

import { TwoCaptchaProvider } from './providers/TwoCaptchaProvider.js';
import { CapSolverProvider }  from './providers/CapSolverProvider.js';
import { CaptchaError }       from '../../errors/index.js';
import logger                 from '../../logger/index.js';
import Monitor                from '../../monitoring/Monitor.js';

export class CaptchaSolver {
  constructor(options = {}) {
    this._providers = new Map();
    this.defaultProvider = options.defaultProvider ?? '2captcha';

    // Register built-in providers
    try { this.registerProvider(new TwoCaptchaProvider(options.twoCaptcha)); } catch { /* no key */ }
    try { this.registerProvider(new CapSolverProvider(options.capSolver));   } catch { /* no key */ }
  }

  registerProvider(provider) {
    this._providers.set(provider.name, provider);
    logger.debug('Captcha provider registered', { provider: provider.name });
  }

  /**
   * Solve a captcha challenge.
   *
   * @param {object} opts
   * @param {string} opts.type           - 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'turnstile'
   * @param {string} opts.siteKey        - Site key from the target page
   * @param {string} opts.pageUrl        - URL of the page with the captcha
   * @param {string} opts.provider       - Override provider name
   * @returns {string} Solution token
   */
  async solve(opts) {
    const providerName = opts.provider ?? this.defaultProvider;
    const provider = this._providers.get(providerName);

    if (!provider) throw new CaptchaError(`Captcha provider not available: ${providerName}`);

    const start = Date.now();
    logger.info('Solving captcha', { type: opts.type, provider: providerName });

    try {
      const token = await provider.solve(opts);
      const duration = Date.now() - start;
      logger.info('Captcha solved', { type: opts.type, provider: providerName, durationMs: duration });
      Monitor.increment('captcha.solved', { provider: providerName, type: opts.type });
      return token;
    } catch (err) {
      Monitor.increment('captcha.failed', { provider: providerName, type: opts.type });
      throw err;
    }
  }

  /**
   * Detect and solve a captcha challenge on the current page automatically.
   * Inspects the DOM for known captcha iframe patterns.
   */
  async autoSolve(page, opts = {}) {
    const type = await this._detectCaptchaType(page);
    if (!type) return null;

    const siteKey = await this._extractSiteKey(page, type);
    const pageUrl = page.url();

    logger.info('Auto-detected captcha', { type, siteKey: siteKey?.slice(0, 10) });

    const token = await this.solve({ type, siteKey, pageUrl, ...opts });
    await this._injectToken(page, type, token);
    return token;
  }

  async _detectCaptchaType(page) {
    const html = await page.content();
    if (html.includes('g-recaptcha') || html.includes('recaptcha/api.js')) return 'recaptcha_v2';
    if (html.includes('hcaptcha.com/1/api.js'))                            return 'hcaptcha';
    if (html.includes('challenges.cloudflare.com'))                         return 'turnstile';
    return null;
  }

  async _extractSiteKey(page, type) {
    try {
      return await page.evaluate((t) => {
        if (t === 'recaptcha_v2') {
          const el = document.querySelector('[data-sitekey], .g-recaptcha');
          return el?.dataset?.sitekey ?? null;
        }
        if (t === 'hcaptcha') {
          const el = document.querySelector('[data-sitekey].h-captcha, .h-captcha');
          return el?.dataset?.sitekey ?? null;
        }
        if (t === 'turnstile') {
          const el = document.querySelector('[data-sitekey].cf-turnstile, .cf-turnstile');
          return el?.dataset?.sitekey ?? null;
        }
        return null;
      }, type);
    } catch {
      return null;
    }
  }

  async _injectToken(page, type, token) {
    await page.evaluate(({ t, token }) => {
      if (t === 'recaptcha_v2') {
        const el = document.getElementById('g-recaptcha-response');
        if (el) { el.value = token; el.style.display = 'block'; }
      }
      if (t === 'hcaptcha') {
        const el = document.querySelector('[name="h-captcha-response"]');
        if (el) el.value = token;
      }
      if (t === 'turnstile') {
        const el = document.querySelector('[name="cf-turnstile-response"]');
        if (el) el.value = token;
      }
    }, { t: type, token });
  }
}

export default CaptchaSolver;
