/**
 * CustomProvider — accepts a static list of proxy strings or objects
 * and rotates through them round-robin or randomly.
 *
 * Format supported:
 *   "http://user:pass@host:port"
 *   { protocol, host, port, username, password }
 */

import { ProxyError } from '../../../errors/index.js';

export class CustomProvider {
  constructor(proxies = [], options = {}) {
    this._proxies = proxies.map(this._normalise);
    this._index   = 0;
    this.strategy = options.strategy ?? 'round-robin'; // 'round-robin' | 'random'
  }

  getProxy() {
    if (this._proxies.length === 0) throw new ProxyError('No custom proxies configured');

    let proxy;
    if (this.strategy === 'random') {
      proxy = this._proxies[Math.floor(Math.random() * this._proxies.length)];
    } else {
      proxy = this._proxies[this._index % this._proxies.length];
      this._index++;
    }
    return { ...proxy, provider: 'custom' };
  }

  addProxy(proxy) {
    this._proxies.push(this._normalise(proxy));
  }

  removeProxy(host) {
    this._proxies = this._proxies.filter((p) => p.host !== host);
  }

  _normalise(proxy) {
    if (typeof proxy === 'string') {
      const url = new URL(proxy);
      return {
        protocol: url.protocol.replace(':', ''),
        host: url.hostname,
        port: parseInt(url.port, 10),
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      };
    }
    return proxy;
  }

  get name() { return 'custom'; }
}
