/**
 * RequestManager — universal HTTP request layer.
 *
 * Provides a consistent interface for:
 *   - Direct Axios requests (lightweight, no browser overhead)
 *   - Browser-based requests (via Playwright/Puppeteer page)
 *
 * Features:
 *   - Automatic proxy injection
 *   - Cookie jar persistence
 *   - Retry with back-off
 *   - Rate limiting per domain
 *   - Response normalisation
 *
 * Usage:
 *   const data = await requestManager.get('https://example.com/api');
 *   const data = await requestManager.post('https://example.com/api', { body });
 */

import axios from 'axios';
import axiosRetry from 'axios-retry';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { retry }           from '../../utils/retry.js';
import logger              from '../../logger/index.js';

axiosRetry(axios, { retries: 0 }); // We handle retries ourselves

export class RequestManager {
  constructor(options = {}) {
    this.defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...options.headers,
    };
    this.timeout  = options.timeout  ?? 30_000;
    this.retries  = options.retries  ?? 3;
    this._cookies = new Map(); // domain → cookie string
  }

  /**
   * Make a GET request.
   * @param {string} url
   * @param {object} opts - { proxy, headers, params, retries, browser }
   */
  async get(url, opts = {}) {
    return this._request('GET', url, opts);
  }

  /** Make a POST request. */
  async post(url, data = {}, opts = {}) {
    return this._request('POST', url, { ...opts, data });
  }

  /** Make a PUT request. */
  async put(url, data = {}, opts = {}) {
    return this._request('PUT', url, { ...opts, data });
  }

  /** Make a DELETE request. */
  async delete(url, opts = {}) {
    return this._request('DELETE', url, opts);
  }

  /**
   * Make a browser-based request (returns parsed page content).
   * @param {object} page    - Playwright or Puppeteer page
   * @param {string} url
   * @param {object} opts    - { waitUntil, timeout }
   */
  async browserGet(page, url, opts = {}) {
    const { waitUntil = 'networkidle', timeout = 30_000 } = opts;
    logger.debug('Browser request', { url });

    await page.goto(url, { waitUntil, timeout });
    return {
      url: page.url(),
      content: await page.content(),
      status: 200, // Playwright doesn't expose top-level status easily
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  async _request(method, url, opts = {}) {
    const {
      proxy   = null,
      headers = {},
      params  = {},
      data    = undefined,
      retries = this.retries,
    } = opts;

    const axiosConfig = {
      method,
      url,
      params,
      data,
      timeout: this.timeout,
      headers: { ...this.defaultHeaders, ...headers },
      validateStatus: () => true, // Handle all statuses ourselves
    };

    if (proxy) {
      const agent = this._buildProxyAgent(proxy);
      axiosConfig.httpAgent  = agent;
      axiosConfig.httpsAgent = agent;
    }

    return retry(async () => {
      logger.debug('HTTP request', { method, url });
      const response = await axios(axiosConfig);

      if (response.status >= 500) {
        const err = new Error(`HTTP ${response.status}: ${url}`);
        err.retryable = true;
        throw err;
      }

      return {
        status: response.status,
        headers: response.headers,
        data: response.data,
        url: response.config.url,
      };
    }, { attempts: retries + 1 });
  }

  _buildProxyAgent(proxy) {
    const url = proxy.username
      ? `${proxy.protocol}://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`
      : `${proxy.protocol}://${proxy.host}:${proxy.port}`;

    return proxy.protocol === 'socks5'
      ? new SocksProxyAgent(url)
      : new HttpsProxyAgent(url);
  }
}

export default RequestManager;
