/**
 * KameleoAdapter — connects to a running Kameleo instance via its REST API
 * and returns a Playwright-compatible page driven through the Kameleo profile.
 *
 * Kameleo exposes a WebSocket endpoint that Playwright can connect to,
 * so the returned `page` is a standard Playwright Page object.
 */

import axios from 'axios';
import { chromium } from 'playwright';
import { BrowserError } from '../../../errors/index.js';
import config from '../../../config/index.js';
import logger from '../../../logger/index.js';

export class KameleoAdapter {
  constructor(options = {}) {
    this.apiUrl = options.apiUrl ?? config.kameleo.apiUrl;
    this.apiKey  = options.apiKey  ?? config.kameleo.apiKey;
    this._profileId = null;
    this._browser   = null;
    this.options = options;
  }

  /** Create a new Kameleo profile and start it. */
  async launch({ baseBrowser = 'chrome', os = 'windows', language = 'en-us' } = {}) {
    try {
      // 1. Create profile
      const { data: profile } = await axios.post(
        `${this.apiUrl}/api/v1/profiles`,
        { baseProfile: { browser: baseBrowser, os, language } },
        { headers: this._headers() },
      );
      this._profileId = profile.id;
      logger.debug('Kameleo profile created', { profileId: profile.id });

      // 2. Start profile
      await axios.post(
        `${this.apiUrl}/api/v1/profiles/${this._profileId}/start`,
        {},
        { headers: this._headers() },
      );

      // 3. Get WebSocket debug URL from Kameleo
      const { data: ws } = await axios.get(
        `${this.apiUrl}/api/v1/profiles/${this._profileId}/browser-ws`,
        { headers: this._headers() },
      );

      // 4. Connect Playwright to the running browser
      this._browser = await chromium.connectOverCDP(ws.url);
      const context = this._browser.contexts()[0];
      const page    = context.pages()[0] ?? await context.newPage();

      logger.debug('Playwright connected to Kameleo', { profileId: this._profileId });
      return { page, context, browser: this._browser };
    } catch (err) {
      throw new BrowserError(`Kameleo launch failed: ${err.message}`, {
        profileId: this._profileId,
      });
    }
  }

  async close() {
    try {
      if (this._browser) await this._browser.close();
      if (this._profileId) {
        await axios.post(
          `${this.apiUrl}/api/v1/profiles/${this._profileId}/stop`,
          {},
          { headers: this._headers() },
        );
        logger.debug('Kameleo profile stopped', { profileId: this._profileId });
      }
    } catch (err) {
      logger.warn('Error closing Kameleo profile', { error: err.message });
    } finally {
      this._browser   = null;
      this._profileId = null;
    }
  }

  _headers() {
    return this.apiKey ? { 'X-API-Key': this.apiKey } : {};
  }

  get engine() { return 'kameleo'; }
}

export default KameleoAdapter;
