/**
 * Scraping & Automation Framework — public API surface.
 *
 * Import anything you need:
 *
 *   import { ScraperFactory, BaseScraper, WorkflowEngine } from './src/index.js';
 *
 * Or use ScraperFactory to assemble a scraper in one call:
 *
 *   import { ScraperFactory } from './src/index.js';
 *   import { MyScraper }      from './src/scrapers/MyScraper.js';
 *
 *   const scraper = ScraperFactory.create(MyScraper, {
 *     browser: { engine: 'playwright', headless: false },
 *     proxy:   { provider: 'brightdata', country: 'US' },
 *     captcha: { provider: '2captcha' },
 *     export:  { format: 'json' },
 *   });
 *
 *   await scraper.run({ pages: 3 });
 */

// ── Factory (main entry point for users) ─────────────────────────────────────
export { ScraperFactory }        from './ScraperFactory.js';

// ── Base classes ─────────────────────────────────────────────────────────────
export { BaseScraper }           from './scrapers/base/BaseScraper.js';

// ── Scrapers ──────────────────────────────────────────────────────────────────
export { CciFrScraper }          from './scrapers/CciFrScraper.js';

// ── Core services ─────────────────────────────────────────────────────────────
export { BrowserManager }        from './core/browser/BrowserManager.js';
export { ProxyManager }          from './core/proxy/ProxyManager.js';
export { CaptchaSolver }         from './core/captcha/CaptchaSolver.js';
export { RecaptchaV2Service }    from './core/captcha/RecaptchaV2Service.js';
export { CloudflareHandler }     from './core/cloudflare/CloudflareHandler.js';
export { TurnstileInterceptor }  from './core/cloudflare/TurnstileInterceptor.js';
export { AntiDetection }         from './core/anti-detection/AntiDetection.js';
export { RequestManager }        from './core/requests/RequestManager.js';
export { WorkflowEngine }        from './core/workflow/WorkflowEngine.js';

// ── Proxy providers ────────────────────────────────────────────────────────────
export { BrightDataProvider }    from './core/proxy/providers/BrightDataProvider.js';
export { OxylabsProvider }       from './core/proxy/providers/OxylabsProvider.js';
export { SmartProxyProvider }    from './core/proxy/providers/SmartProxyProvider.js';
export { CustomProvider }        from './core/proxy/providers/CustomProvider.js';

// ── Captcha providers ──────────────────────────────────────────────────────────
export { TwoCaptchaProvider }    from './core/captcha/providers/TwoCaptchaProvider.js';
export { CapSolverProvider }     from './core/captcha/providers/CapSolverProvider.js';

// ── Browser adapters ───────────────────────────────────────────────────────────
export { PlaywrightAdapter }     from './core/browser/adapters/PlaywrightAdapter.js';
export { PuppeteerAdapter }      from './core/browser/adapters/PuppeteerAdapter.js';
export { KameleoAdapter }        from './core/browser/adapters/KameleoAdapter.js';

// ── Infrastructure ─────────────────────────────────────────────────────────────
export { QueueManager }          from './queues/QueueManager.js';
export { Scheduler }             from './scheduler/Scheduler.js';
export { Exporter }              from './exports/Exporter.js';
export { default as Monitor }    from './monitoring/Monitor.js';
export { default as logger }     from './logger/index.js';

// ── Errors ─────────────────────────────────────────────────────────────────────
export {
  FrameworkError,
  BrowserError,
  ProxyError,
  CaptchaError,
  CloudflareError,
  ParsingError,
  ValidationError,
  RateLimitError,
  SessionExpiredError,
} from './errors/index.js';

// ── CLI ────────────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('index.js')) {
  const [,, command, arg] = process.argv;
  if (!command) {
    console.log(`
  Scraping & Automation Framework

  Commands:
    node src/index.js api                     Start REST API server (:3000)
    node src/queues/workers/ScrapingWorker.js Start queue worker
    node src/database/migrate.js              Apply DB migrations
    `);
  } else if (command === 'api') {
    await import('./api/server.js');
  }
}



// https://www.google.com/recaptcha/api2/userverify?k=6LeEnNcZAAAAAEb-MZUOsNIGFL1HGG531_jEYZCl