/**
 * ProxyManager — unified proxy lifecycle management.
 *
 * Features:
 *   - Provider-agnostic interface (BrightData, Oxylabs, SmartProxy, Custom, …)
 *   - Proxy health checking & validation via HEAD request
 *   - Blacklist management (auto-ban failing proxies)
 *   - Sticky sessions (same proxy across page loads for a session)
 *   - Country-based selection
 *   - Automatic failover to next healthy proxy
 *
 * Usage:
 *   const proxy = await proxyManager.getProxy({ country: 'US', sticky: true });
 */

import axios from 'axios';
import { BrightDataProvider } from './providers/BrightDataProvider.js';
import { OxylabsProvider }    from './providers/OxylabsProvider.js';
import { CustomProvider }     from './providers/CustomProvider.js';
import { ProxyError }         from '../../errors/index.js';
import logger                 from '../../logger/index.js';

const VALIDATION_URL    = 'https://httpbin.org/ip';
const VALIDATION_TIMEOUT = 10_000;

export class ProxyManager {
  constructor(options = {}) {
    this._providers  = new Map();
    this._blacklist  = new Set();
    this._sessions   = new Map(); // sessionId → proxy
    this._healthCache = new Map(); // proxyKey → { ok, checkedAt }

    // Register built-in providers if credentials are available
    const { brightData, oxylabs, custom } = options.providers ?? {};
    if (brightData !== false) this.registerProvider(new BrightDataProvider(brightData));
    if (oxylabs    !== false) this.registerProvider(new OxylabsProvider(oxylabs));
    if (custom)               this.registerProvider(new CustomProvider(custom));

    this.defaultProvider = options.defaultProvider ?? 'brightdata';
    this.healthCheckEnabled = options.healthCheck ?? true;
  }

  /** Register an additional proxy provider. */
  registerProvider(provider) {
    this._providers.set(provider.name, provider);
    logger.debug('Proxy provider registered', { provider: provider.name });
  }

  /**
   * Get a proxy matching the given criteria.
   *
   * @param {object}  opts
   * @param {string}  opts.country       - ISO-2 country code (e.g. 'US')
   * @param {boolean} opts.sticky        - Keep same proxy for this session
   * @param {string}  opts.sessionId     - Used for sticky sessions
   * @param {string}  opts.provider      - Override provider name
   * @param {number}  opts.maxRetries    - Failover attempts
   * @returns {object} Proxy config { protocol, host, port, username, password }
   */
  async getProxy(opts = {}) {
    const { sessionId, sticky = false, maxRetries = 5 } = opts;

    // Return existing sticky session proxy
    if (sticky && sessionId && this._sessions.has(sessionId)) {
      return this._sessions.get(sessionId);
    }

    let proxy;
    let attempts = 0;
    while (attempts < maxRetries) {
      proxy = this._fetchFromProvider(opts);
      const key = this._proxyKey(proxy);

      if (this._blacklist.has(key)) {
        attempts++;
        continue;
      }

      if (this.healthCheckEnabled) {
        const healthy = await this._isHealthy(proxy);
        if (!healthy) {
          this.blacklist(proxy);
          attempts++;
          continue;
        }
      }

      break;
    }

    if (!proxy) throw new ProxyError('No healthy proxies available', { opts });

    if (sticky && sessionId) {
      this._sessions.set(sessionId, proxy);
    }

    logger.debug('Proxy assigned', {
      provider: proxy.provider,
      country: proxy.country,
      host: proxy.host,
    });

    return proxy;
  }

  /** Permanently ban a proxy (until process restart or explicit removal). */
  blacklist(proxy) {
    const key = this._proxyKey(proxy);
    this._blacklist.add(key);
    logger.warn('Proxy blacklisted', { host: proxy.host, port: proxy.port });
  }

  /** Remove a proxy from the blacklist. */
  unblacklist(proxy) {
    this._blacklist.delete(this._proxyKey(proxy));
  }

  /** Release a sticky session. */
  releaseSession(sessionId) {
    this._sessions.delete(sessionId);
  }

  /** Validate a proxy by making a test request. */
  async validate(proxy) {
    return this._isHealthy(proxy, true);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _fetchFromProvider(opts) {
    const providerName = opts.provider ?? this.defaultProvider;
    const provider = this._providers.get(providerName);
    if (!provider) throw new ProxyError(`Unknown proxy provider: ${providerName}`);
    return provider.getProxy(opts);
  }

  async _isHealthy(proxy, force = false) {
    const key = this._proxyKey(proxy);
    const cached = this._healthCache.get(key);

    // Cache health status for 5 minutes
    if (!force && cached && Date.now() - cached.checkedAt < 5 * 60_000) {
      return cached.ok;
    }

    try {
      const agent = this._buildAgent(proxy);
      await axios.get(VALIDATION_URL, {
        httpAgent: agent,
        httpsAgent: agent,
        timeout: VALIDATION_TIMEOUT,
      });
      this._healthCache.set(key, { ok: true, checkedAt: Date.now() });
      return true;
    } catch {
      this._healthCache.set(key, { ok: false, checkedAt: Date.now() });
      return false;
    }
  }

  _buildAgent(proxy) {
    const url = `${proxy.protocol}://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
    if (proxy.protocol === 'socks5') {
      const { SocksProxyAgent } = require('socks-proxy-agent');
      return new SocksProxyAgent(url);
    }
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(url);
  }

  _proxyKey(proxy) {
    return `${proxy.host}:${proxy.port}`;
  }
}

export default ProxyManager;
