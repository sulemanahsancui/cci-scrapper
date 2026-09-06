/**
 * BrowserManager — fully dynamic browser lifecycle manager.
 *
 * Every option set in the constructor becomes a default that can be
 * overridden per-launch call. Users control every aspect:
 *
 *   // Playwright, headed, chromium, no proxy, stealth ON
 *   const bm = new BrowserManager({
 *     engine:   'playwright',
 *     type:     'chromium',
 *     headless: false,
 *     stealth:  true,
 *   });
 *
 *   // Puppeteer, headless, with BrightData proxy
 *   const bm = new BrowserManager({
 *     engine:   'puppeteer',
 *     headless: true,
 *     stealth:  true,
 *   });
 *   const { page } = await bm.launch({ proxy: proxyConfig });
 *
 *   // Kameleo
 *   const bm = new BrowserManager({ engine: 'kameleo' });
 *   const { page } = await bm.launch({ baseBrowser: 'chrome', os: 'windows' });
 *
 *   // Override engine at launch time
 *   const { page } = await bm.launch({ engine: 'firefox' });
 */

import { PlaywrightAdapter } from './adapters/PlaywrightAdapter.js';
import { PuppeteerAdapter }  from './adapters/PuppeteerAdapter.js';
import { KameleoAdapter }    from './adapters/KameleoAdapter.js';
import { AntiDetection }     from '../anti-detection/AntiDetection.js';
import { BrowserError }      from '../../errors/index.js';
import config                from '../../config/index.js';
import logger                from '../../logger/index.js';

export class BrowserManager {
  /**
   * @param {object} defaults  — applied to every launch() call unless overridden
   * @param {'playwright'|'puppeteer'|'kameleo'} defaults.engine
   * @param {'chromium'|'firefox'|'webkit'}      defaults.type      (playwright only)
   * @param {boolean}  defaults.headless
   * @param {number}   defaults.slowMo            ms between actions
   * @param {string[]} defaults.args              extra launch flags
   * @param {boolean}  defaults.stealth           apply anti-detection layer
   * @param {object}   defaults.antiDetection     AntiDetection options
   * @param {object}   defaults.kameleo           Kameleo profile options
   */
  constructor(defaults = {}) {
    this._defaults = {
      engine:   'playwright',
      type:     'chromium',
      headless: true,
      slowMo:   0,
      args:     [],
      stealth:  true,
      ...defaults,
    };

    this.antiDetection = new AntiDetection(defaults.antiDetection ?? {});
    this._adapters = new Map();
  }

  /**
   * Launch a browser session. All fields default to what was passed in the
   * constructor; anything passed here overrides those defaults.
   *
   * @param {object}  opts
   * @param {'playwright'|'puppeteer'|'kameleo'} [opts.engine]
   * @param {'chromium'|'firefox'|'webkit'}      [opts.type]
   * @param {boolean}  [opts.headless]
   * @param {number}   [opts.slowMo]
   * @param {string[]} [opts.args]
   * @param {boolean}  [opts.stealth]
   * @param {object}   [opts.proxy]        — proxy config from ProxyManager
   * @param {object}   [opts.contextOpts]  — extra Playwright context options
   * @param {object}   [opts.kameleo]      — Kameleo profile options
   * @returns {{ page, context?, sessionId, engine }}
   */
  async launch(opts = {}) {
    // Merge constructor defaults → call-time overrides
    const merged = { ...this._defaults, ...opts };

    const {
      engine      = 'playwright',
      type        = 'chromium',
      headless    = true,
      slowMo      = 0,
      args        = [],
      stealth     = true,
      proxy       = null,
      contextOpts = {},
      kameleo     = {},
    } = merged;

    const adapterOpts = { type, headless, slowMo, args, stealth, userDataDir: merged.userDataDir ?? null };
    const adapter = this._createAdapter(engine, adapterOpts);
    let result;

    switch (engine) {
      case 'playwright':
        await adapter.launch(proxy);
        result = await adapter.newPage(contextOpts);
        break;

      case 'puppeteer':
        await adapter.launch(proxy);
        result = await adapter.newPage(proxy);
        break;

      case 'kameleo':
        result = await adapter.launch({
          baseBrowser: kameleo.baseBrowser ?? 'chrome',
          os:          kameleo.os          ?? 'windows',
          language:    kameleo.language    ?? 'en-us',
          ...kameleo,
        });
        break;

      default:
        throw new BrowserError(
          `Unknown engine "${engine}". Valid: playwright, puppeteer, kameleo`,
        );
    }

    // Apply anti-detection patches (Kameleo manages its own fingerprint)
    if (stealth && engine !== 'kameleo') {
      await this.antiDetection.applyTo(result.page, engine);
    }

    const sessionId = `${engine}-${Date.now()}`;
    this._adapters.set(sessionId, adapter);
    result.sessionId = sessionId;
    result.engine    = engine;

    logger.info('Browser session started', { sessionId, engine, type, headless, stealth });
    return result;
  }

  /** Close one session by its sessionId. */
  async close(sessionId) {
    const adapter = this._adapters.get(sessionId);
    if (adapter) {
      await adapter.close();
      this._adapters.delete(sessionId);
      logger.info('Browser session closed', { sessionId });
    }
  }

  /** Close every open session. */
  async closeAll() {
    for (const [id] of this._adapters) await this.close(id);
  }

  /** Change a default for all future launch() calls. */
  setDefault(key, value) {
    this._defaults[key] = value;
    return this;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _createAdapter(engine, opts) {
    switch (engine) {
      case 'playwright':
        return new PlaywrightAdapter({
          headless:    opts.headless     ?? config.browser?.headless ?? true,
          browserType: opts.type         ?? 'chromium',
          slowMo:      opts.slowMo       ?? 0,
          args:        opts.args         ?? [],
          stealth:     opts.stealth      ?? false,
          userDataDir: opts.userDataDir  ?? null,
        });

      case 'puppeteer':
        return new PuppeteerAdapter({
          headless: opts.headless ?? config.browser?.headless ?? true,
          slowMo:   opts.slowMo   ?? 0,
          args:     opts.args     ?? [],
        });

      case 'kameleo':
        return new KameleoAdapter();

      default:
        throw new BrowserError(
          `Unknown engine "${engine}". Valid: playwright, puppeteer, kameleo`,
        );
    }
  }
}

export default BrowserManager;
