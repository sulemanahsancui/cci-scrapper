/**
 * PlaywrightAdapter — wraps Playwright behind the framework's standard browser
 * interface.
 *
 * Features:
 *   - Stealth mode via playwright-extra + puppeteer-extra-plugin-stealth
 *   - Persistent browser context (cookies / localStorage survive across runs)
 *     when `userDataDir` is provided
 *   - Regular ephemeral context when no `userDataDir` is set
 */

import { chromium as chromiumBase, firefox, webkit } from 'playwright';
import { BrowserError } from '../../../errors/index.js';
import logger from '../../../logger/index.js';

// playwright-extra + stealth are loaded lazily so the adapter still works
// when those packages are absent (e.g. pure-puppeteer environments).
let _stealthChromium = null;
async function getStealthChromium() {
  if (_stealthChromium) return _stealthChromium;
  const { chromium: extraChromium } = await import('playwright-extra');
  const { default: StealthPlugin }  = await import('puppeteer-extra-plugin-stealth');
  extraChromium.use(StealthPlugin());
  _stealthChromium = extraChromium;
  return _stealthChromium;
}

export class PlaywrightAdapter {
  /**
   * @param {object}  options
   * @param {boolean} options.headless      default true
   * @param {string}  options.browserType   chromium | firefox | webkit
   * @param {number}  options.slowMo        ms between actions
   * @param {string[]}options.args          extra launch flags
   * @param {boolean} options.stealth       enable playwright-extra stealth plugin
   * @param {string}  options.userDataDir   path on disk for persistent context;
   *                                        omit for an ephemeral session
   */
  constructor(options = {}) {
    this.options = {
      headless:    true,
      browserType: 'chromium',
      slowMo:      0,
      args:        [],
      stealth:     false,
      userDataDir: null,
      ...options,
    };

    this._browser    = null;   // set when NOT using persistent context
    this._context    = null;   // set when using persistent context
    this._persistent = false;
  }

  // ── Launch ──────────────────────────────────────────────────────────────────

  async launch(proxyConfig = null) {
    const { headless, slowMo, args, stealth, userDataDir, browserType } = this.options;

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      ...args,
    ];

    const launchOptions = {
      headless,
      slowMo,
      args: launchArgs,
    };

    if (proxyConfig) {
      launchOptions.proxy = {
        server:   `${proxyConfig.protocol}://${proxyConfig.host}:${proxyConfig.port}`,
        username: proxyConfig.username,
        password: proxyConfig.password,
      };
    }

    // Pick the right engine
    let engine;
    if (stealth && browserType === 'chromium') {
      engine = await getStealthChromium();
    } else {
      const map = { chromium: chromiumBase, firefox, webkit };
      engine = map[browserType] ?? chromiumBase;
    }

    try {
      if (userDataDir) {
        // ── Persistent context ──────────────────────────────────────────────
        // launchPersistentContext returns a BrowserContext directly — no
        // separate browser.newContext() call needed.
        this._context    = await engine.launchPersistentContext(userDataDir, launchOptions);
        this._persistent = true;
        logger.debug('Playwright persistent context launched', { userDataDir, stealth, browserType });
      } else {
        // ── Ephemeral browser ───────────────────────────────────────────────
        this._browser    = await engine.launch(launchOptions);
        this._persistent = false;
        logger.debug('Playwright browser launched', { browserType, stealth });
      }

      return this._browser ?? this._context;
    } catch (err) {
      throw new BrowserError(`Failed to launch Playwright: ${err.message}`, { browserType });
    }
  }

  // ── Context & page ──────────────────────────────────────────────────────────

  async newContext(contextOptions = {}) {
    if (this._persistent) {
      // The persistent context is the one context — return it as-is.
      return this._context;
    }
    if (!this._browser) throw new BrowserError('Browser not launched');
    return this._browser.newContext({
      ignoreHTTPSErrors: true,
      ...contextOptions,
    });
  }

  async newPage(contextOptions = {}) {
    const ctx  = await this.newContext(contextOptions);
    const page = await ctx.newPage();
    return { page, context: ctx };
  }

  // ── Teardown ────────────────────────────────────────────────────────────────

  async close() {
    if (this._persistent && this._context) {
      await this._context.close();
      this._context = null;
      logger.debug('Playwright persistent context closed');
    } else if (this._browser) {
      await this._browser.close();
      this._browser = null;
      logger.debug('Playwright browser closed');
    }
  }

  get engine() { return 'playwright'; }
}

export default PlaywrightAdapter;
