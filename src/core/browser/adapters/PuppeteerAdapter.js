/**
 * PuppeteerAdapter — wraps Puppeteer (with puppeteer-extra stealth) behind
 * the framework's standard browser interface.
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { BrowserError } from '../../../errors/index.js';
import logger from '../../../logger/index.js';

puppeteer.use(StealthPlugin());

export class PuppeteerAdapter {
  constructor(options = {}) {
    this.options = {
      headless: 'new',
      slowMo:   0,
      args:     [],
      ...options,
    };
    this._browser = null;
  }

  async launch(proxyConfig = null) {
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      ...this.options.args,
    ];

    if (proxyConfig) {
      args.push(`--proxy-server=${proxyConfig.protocol}://${proxyConfig.host}:${proxyConfig.port}`);
    }

    try {
      this._browser = await puppeteer.launch({
        headless: this.options.headless,
        slowMo:   this.options.slowMo,
        args,
      });
      logger.debug('Puppeteer browser launched');
      return this._browser;
    } catch (err) {
      throw new BrowserError(`Failed to launch Puppeteer: ${err.message}`);
    }
  }

  async newPage(proxyAuth = null) {
    if (!this._browser) throw new BrowserError('Browser not launched');
    const page = await this._browser.newPage();
    if (proxyAuth) {
      await page.authenticate({ username: proxyAuth.username, password: proxyAuth.password });
    }
    return { page };
  }

  async close() {
    if (this._browser) {
      await this._browser.close();
      this._browser = null;
      logger.debug('Puppeteer browser closed');
    }
  }

  get engine() { return 'puppeteer'; }
}

export default PuppeteerAdapter;
