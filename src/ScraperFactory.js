/**
 * ScraperFactory — single entry point to configure and assemble any scraper.
 *
 * Instead of manually constructing every service, pass one config object and
 * get a fully wired scraper instance back.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUICK START
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   import { ScraperFactory } from './src/index.js';
 *   import { MyScraper }      from './src/scrapers/MyScraper.js';
 *
 *   const scraper = ScraperFactory.create(MyScraper, {
 *     browser: { engine: 'playwright', headless: false },
 *     proxy:   { provider: 'brightdata', country: 'US' },
 *     captcha: { provider: '2captcha' },
 *   });
 *
 *   await scraper.run({ url: 'https://example.com' });
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FULL CONFIG REFERENCE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   ScraperFactory.create(ScraperClass, {
 *
 *     // ── Browser ────────────────────────────────────────────────────────────
 *     browser: {
 *       engine:   'playwright',   // 'playwright' | 'puppeteer' | 'kameleo'
 *       type:     'chromium',     // 'chromium' | 'firefox' | 'webkit'  (playwright only)
 *       headless: true,           // false = open a real browser window
 *       slowMo:   0,              // ms delay between actions (good for debugging)
 *       stealth:  true,           // apply anti-detection patches
 *       args:     [],             // extra browser launch flags
 *
 *       kameleo: {                // only used when engine: 'kameleo'
 *         baseBrowser: 'chrome',
 *         os:          'windows',
 *         language:    'en-us',
 *       },
 *     },
 *
 *     // ── Proxy ──────────────────────────────────────────────────────────────
 *     proxy: {
 *       enabled:  true,
 *       provider: 'brightdata',   // 'brightdata' | 'oxylabs' | 'smartproxy' | 'custom' | false
 *       country:  'US',           // ISO-2 country code
 *       sticky:   false,          // reuse same IP across requests in one session
 *
 *       // Only for provider: 'custom'
 *       proxies:  [
 *         'http://user:pass@1.2.3.4:8080',
 *         { protocol:'http', host:'5.6.7.8', port:8080, username:'u', password:'p' },
 *       ],
 *       strategy: 'round-robin',  // 'round-robin' | 'random'
 *
 *       // Override credentials (otherwise reads from .env)
 *       credentials: { username: '', password: '', host: '', port: 0 },
 *     },
 *
 *     // ── Captcha ────────────────────────────────────────────────────────────
 *     captcha: {
 *       provider: '2captcha',     // '2captcha' | 'capsolver' | false
 *       apiKey:   '',             // optional: overrides env var
 *     },
 *
 *     // ── Cloudflare ─────────────────────────────────────────────────────────
 *     cloudflare: {
 *       enabled:      true,
 *       maxWait:      30000,      // ms to wait for JS challenge to auto-clear
 *       pollInterval: 2000,
 *     },
 *
 *     // ── Anti-Detection ─────────────────────────────────────────────────────
 *     antiDetection: {
 *       enabled:     true,
 *       humanMouse:  true,        // bezier-curve mouse movement
 *       humanScroll: true,        // gradual scrolling
 *       humanTyping: true,        // random per-keystroke delays
 *       fingerprint: {},          // override specific fingerprint fields
 *     },
 *
 *     // ── Export ─────────────────────────────────────────────────────────────
 *     export: {
 *       format:    'json',        // 'json' | 'csv' | 'db' | 'all'
 *       outputDir: './exports/output',
 *     },
 *
 *     // ── Scraper behaviour ──────────────────────────────────────────────────
 *     retries:  3,
 *     delayMin: 500,              // ms min pause between page actions
 *     delayMax: 2000,             // ms max pause between page actions
 *   });
 */

import BrowserManager         from './core/browser/BrowserManager.js';
import ProxyManager           from './core/proxy/ProxyManager.js';
import { BrightDataProvider } from './core/proxy/providers/BrightDataProvider.js';
import { OxylabsProvider }    from './core/proxy/providers/OxylabsProvider.js';
import { SmartProxyProvider } from './core/proxy/providers/SmartProxyProvider.js';
import { CustomProvider }     from './core/proxy/providers/CustomProvider.js';
import CaptchaSolver          from './core/captcha/CaptchaSolver.js';
import CloudflareHandler      from './core/cloudflare/CloudflareHandler.js';
import AntiDetection          from './core/anti-detection/AntiDetection.js';
import RequestManager         from './core/requests/RequestManager.js';
import Exporter               from './exports/Exporter.js';
import { ValidationError }    from './errors/index.js';
import logger                 from './logger/index.js';

export class ScraperFactory {
  /**
   * Create a fully configured scraper instance.
   *
   * @param {typeof import('./scrapers/base/BaseScraper.js').BaseScraper} ScraperClass
   * @param {object} cfg — see full config reference in JSDoc above
   * @returns {InstanceType<ScraperClass>}
   */
  static create(ScraperClass, cfg = {}) {
    const browserCfg    = cfg.browser       ?? {};
    const proxyCfg      = cfg.proxy         ?? {};
    const captchaCfg    = cfg.captcha       ?? {};
    const cfCfg         = cfg.cloudflare    ?? {};
    const adCfg         = cfg.antiDetection ?? {};
    const exportCfg     = cfg.export        ?? {};

    // ── Browser ───────────────────────────────────────────────────────────────
    const engine = browserCfg.engine ?? 'playwright';

    const browserManager = new BrowserManager({
      engine,
      type:     browserCfg.type     ?? 'chromium',
      headless: browserCfg.headless ?? true,
      slowMo:   browserCfg.slowMo   ?? 0,
      stealth:  browserCfg.stealth  ?? true,
      args:     browserCfg.args     ?? [],
      kameleo:  browserCfg.kameleo  ?? {},
      antiDetection: adCfg.enabled !== false ? adCfg : { enabled: false },
    });

    // ── Anti-Detection ────────────────────────────────────────────────────────
    const antiDetection = new AntiDetection({
      humanMouse:  adCfg.humanMouse  ?? true,
      humanScroll: adCfg.humanScroll ?? true,
      humanTyping: adCfg.humanTyping ?? true,
      fingerprint: adCfg.fingerprint ?? {},
    });

    // ── Proxy ─────────────────────────────────────────────────────────────────
    const proxyManager = ScraperFactory._buildProxyManager(proxyCfg);

    // ── Captcha ───────────────────────────────────────────────────────────────
    const captchaSolver = ScraperFactory._buildCaptchaSolver(captchaCfg);

    // ── Cloudflare ────────────────────────────────────────────────────────────
    const cloudflareHandler = cfCfg.enabled === false
      ? null
      : new CloudflareHandler({
          maxWait:      cfCfg.maxWait      ?? 30_000,
          pollInterval: cfCfg.pollInterval ?? 2_000,
        });

    // ── Request / Export ──────────────────────────────────────────────────────
    const requestManager = new RequestManager();
    const exporter = new Exporter({
      defaultFormat: exportCfg.format    ?? 'json',
      outputDir:     exportCfg.outputDir ?? './exports/output',
    });

    // ── Assemble ──────────────────────────────────────────────────────────────
    const instance = new ScraperClass({
      engine,
      retries:        cfg.retries  ?? 3,
      delayMin:       cfg.delayMin ?? 500,
      delayMax:       cfg.delayMax ?? 2000,
      browserManager,
      proxyManager,
      captchaSolver,
      cloudflareHandler,
      antiDetection,
      requestManager,
      exporter,
    });

    logger.info('ScraperFactory assembled', {
      scraper:  ScraperClass.name,
      engine,
      type:     browserCfg.type     ?? 'chromium',
      headless: browserCfg.headless ?? true,
      stealth:  browserCfg.stealth  ?? true,
      proxy:    proxyCfg.provider   ?? 'none',
      captcha:  captchaCfg.provider ?? 'none',
      export:   exportCfg.format    ?? 'json',
    });

    return instance;
  }

  // ── Private builders ────────────────────────────────────────────────────────

  static _buildProxyManager(proxyCfg) {
    // Proxy disabled
    if (proxyCfg.enabled === false || proxyCfg.provider === false || !proxyCfg.provider) {
      return {
        getProxy:       async () => null,
        blacklist:      () => {},
        releaseSession: () => {},
      };
    }

    const provider = proxyCfg.provider;

    // Create a bare ProxyManager (no auto-registered providers)
    const pm = new ProxyManager({ providers: false, healthCheck: false });

    switch (provider) {
      case 'brightdata':
        pm.registerProvider(new BrightDataProvider(proxyCfg.credentials ?? {}));
        pm.defaultProvider = 'brightdata';
        break;

      case 'oxylabs':
        pm.registerProvider(new OxylabsProvider(proxyCfg.credentials ?? {}));
        pm.defaultProvider = 'oxylabs';
        break;

      case 'smartproxy':
        pm.registerProvider(new SmartProxyProvider(proxyCfg.credentials ?? {}));
        pm.defaultProvider = 'smartproxy';
        break;

      case 'custom':
        if (!proxyCfg.proxies?.length) {
          throw new ValidationError(
            'proxy.proxies[] is required when provider is "custom"',
          );
        }
        pm.registerProvider(
          new CustomProvider(proxyCfg.proxies, { strategy: proxyCfg.strategy ?? 'round-robin' }),
        );
        pm.defaultProvider = 'custom';
        break;

      default:
        throw new ValidationError(
          `Unknown proxy provider: "${provider}". Valid: brightdata, oxylabs, smartproxy, custom, false`,
        );
    }

    // Wrap getProxy to inject country/sticky defaults from config
    const _get = pm.getProxy.bind(pm);
    pm.getProxy = (opts = {}) => _get({
      country: proxyCfg.country ?? 'US',
      sticky:  proxyCfg.sticky  ?? false,
      ...opts,
    });

    return pm;
  }

  static _buildCaptchaSolver(captchaCfg) {
    if (captchaCfg.enabled === false || captchaCfg.provider === false || !captchaCfg.provider) {
      return null;
    }

    const provider = captchaCfg.provider;
    const apiKey   = captchaCfg.apiKey;   // optional override

    switch (provider) {
      case '2captcha':
        return new CaptchaSolver({
          defaultProvider: '2captcha',
          twoCaptcha: apiKey ? { apiKey } : undefined,
        });

      case 'capsolver':
        return new CaptchaSolver({
          defaultProvider: 'capsolver',
          capSolver: apiKey ? { apiKey } : undefined,
        });

      default:
        throw new ValidationError(
          `Unknown captcha provider: "${provider}". Valid: 2captcha, capsolver, false`,
        );
    }
  }
}

export default ScraperFactory;
