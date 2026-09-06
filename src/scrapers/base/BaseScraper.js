/**
 * BaseScraper — abstract base class for all scrapers.
 *
 * Provides out-of-the-box:
 *   - Browser lifecycle management
 *   - Proxy handling
 *   - Captcha solving
 *   - Cloudflare bypass
 *   - Retry logic
 *   - Structured logging
 *   - Export to CSV / JSON / DB
 *   - Monitoring hooks
 *
 * Extend this class and implement scrape():
 *
 *   class ZillowScraper extends BaseScraper {
 *     async scrape() {
 *       await this.navigate('https://zillow.com');
 *       const results = await this.extract();
 *       await this.save(results);
 *     }
 *   }
 */

import BrowserManager    from '../../core/browser/BrowserManager.js';
import ProxyManager      from '../../core/proxy/ProxyManager.js';
import CaptchaSolver     from '../../core/captcha/CaptchaSolver.js';
import CloudflareHandler from '../../core/cloudflare/CloudflareHandler.js';
import RequestManager    from '../../core/requests/RequestManager.js';
import AntiDetection     from '../../core/anti-detection/AntiDetection.js';
import Exporter          from '../../exports/Exporter.js';
import Monitor           from '../../monitoring/Monitor.js';
import { retry }         from '../../utils/retry.js';
import { randomSleep }   from '../../utils/sleep.js';
import logger            from '../../logger/index.js';
import config            from '../../config/index.js';

export class BaseScraper {
  /**
   * @param {object} options
   * @param {string} options.name          - Unique scraper name (used in logs/metrics)
   * @param {string} options.engine        - 'playwright' | 'puppeteer' | 'kameleo'
   * @param {object} options.proxy         - Proxy selection options
   * @param {object} options.captcha       - Captcha provider options
   * @param {number} options.retries       - Max retry attempts
   * @param {number} options.concurrency   - Max concurrent pages
   */
  constructor(options = {}) {
    this.name     = options.name     ?? this.constructor.name;
    this.engine   = options.engine   ?? 'playwright';
    this.retries  = options.retries  ?? config.scraper?.retries ?? 3;
    this.delayMin = options.delayMin ?? config.scraper?.delayMin ?? 500;
    this.delayMax = options.delayMax ?? config.scraper?.delayMax ?? 2000;

    this.browserManager    = options.browserManager    ?? new BrowserManager({ engine: this.engine });
    this.proxyManager      = options.proxyManager      ?? new ProxyManager();
    this.captchaSolver     = options.captchaSolver     ?? new CaptchaSolver();
    this.cloudflareHandler = options.cloudflareHandler ?? new CloudflareHandler();
    this.requestManager    = options.requestManager    ?? new RequestManager();
    this.antiDetection     = options.antiDetection     ?? new AntiDetection();
    this.exporter          = options.exporter          ?? new Exporter();

    this._log       = logger.child({ scraper: this.name });
    this.page       = null;
    this.context    = null;
    this._sessionId = null;
    this._proxy     = null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Called once before scraping starts. Override to perform setup. */
  async setup() {}

  /** Called once after scraping ends (success or failure). Override for teardown. */
  async teardown() {}

  /**
   * Main entry point. Runs setup → scrape → teardown with error handling.
   * @param {object} input - Job-specific input data passed from the queue
   */
  async run(input = {}) {
    const start = Date.now();
    this._log.info('Scraper started', { input });
    Monitor.increment(`scraper.${this.name}.started`);

    try {
      await this.setup();
      await this._initBrowser();
      const result = await retry(() => this.scrape(input), {
        attempts: this.retries + 1,
        onRetry: (err, attempt) => {
          this._log.warn('Scrape attempt failed, retrying', { attempt, error: err.message });
        },
      });

      const duration = Date.now() - start;
      this._log.info('Scraper completed', { durationMs: duration });
      Monitor.increment(`scraper.${this.name}.success`);
      Monitor.timing(`scraper.${this.name}.duration`, duration);

      return result;
    } catch (err) {
      Monitor.increment(`scraper.${this.name}.failed`);
      this._log.error('Scraper failed', { error: err.message, stack: err.stack });
      throw err;
    } finally {
      await this._closeBrowser();
      await this.teardown();
    }
  }

  /**
   * Implement the actual scraping logic here.
   * @param {object} input
   * @abstract
   */
  async scrape(input) {
    throw new Error(`${this.name}.scrape() must be implemented`);
  }

  // ── Helpers available to child scrapers ────────────────────────────────────

  /**
   * Navigate to a URL, bypassing Cloudflare if needed.
   * Injects the Turnstile interceptor before the request so all CF params
   * are captured even if the challenge fires during initial page load.
   */
  async navigate(url, opts = {}) {
    this._log.debug('Navigating', { url });
    // Must be called before goto() so the interceptor is in place before CF JS runs
    await this.cloudflareHandler.prepareForTurnstile(this.page);
    await this.requestManager.browserGet(this.page, url, opts);
    await this.cloudflareHandler.bypass(this.page);
    return this;
  }

  /** Click an element with human-like mouse movement. */
  async click(selector) {
    await this.antiDetection.humanClick(this.page, selector, this.engine);
    return this;
  }

  /** Type text with human-like delays. */
  async type(selector, text) {
    await this.antiDetection.humanType(this.page, selector, text, this.engine);
    return this;
  }

  /** Scroll down the page to load lazy content. */
  async scroll(opts = {}) {
    await this.antiDetection.humanScroll(this.page, opts);
    return this;
  }

  /** Pause for a randomised delay to appear more human. */
  async pause(min, max) {
    await randomSleep(min ?? this.delayMin, max ?? this.delayMax);
    return this;
  }

  /** Solve any captcha on the current page. */
  async solveCaptcha(opts = {}) {
    return this.captchaSolver.autoSolve(this.page, opts);
  }

  /** Extract data from the current page using a selector map. */
  async extract(selectorMap) {
    const results = {};
    for (const [key, selector] of Object.entries(selectorMap)) {
      try {
        results[key] = await this.page.locator(selector).first().textContent({ timeout: 5000 });
      } catch {
        results[key] = null;
      }
    }
    return results;
  }

  /** Extract all items matching a repeating selector. */
  async extractAll(itemSelector, selectorMap) {
    return this.page.$$eval(itemSelector, (elements, map) =>
      elements.map((el) => {
        const item = {};
        for (const [key, sel] of Object.entries(map)) {
          item[key] = el.querySelector(sel)?.textContent?.trim() ?? null;
        }
        return item;
      }),
    selectorMap);
  }

  /** Save results using the configured exporter. */
  async save(data, opts = {}) {
    return this.exporter.export(data, { scraper: this.name, ...opts });
  }

  /** Get a fresh proxy (rotated automatically). */
  async getProxy(opts = {}) {
    this._proxy = await this.proxyManager.getProxy(opts);
    return this._proxy;
  }

  // ── Browser lifecycle (internal) ───────────────────────────────────────────

  async _initBrowser() {
    const proxy = await this.proxyManager.getProxy().catch(() => null);
    const { page, context, sessionId } = await this.browserManager.launch({
      engine: this.engine,
      proxy,
    });
    this.page       = page;
    this.context    = context;
    this._sessionId = sessionId;
  }

  async _closeBrowser() {
    if (this._sessionId) {
      await this.browserManager.close(this._sessionId);
      this.page       = null;
      this.context    = null;
      this._sessionId = null;
    }
  }
}

export default BaseScraper;
