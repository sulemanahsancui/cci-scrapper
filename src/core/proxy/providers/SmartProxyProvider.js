import config from '../../../config/index.js';

export class SmartProxyProvider {
  constructor(options = {}) {
    this.cfg = { ...config.proxies.smartProxy, ...options };
  }

  getProxy({ country = 'US', sticky = false, sessionId = null } = {}) {
    const session = sticky
      ? `-session-${sessionId ?? Math.random().toString(36).slice(2)}`
      : '';

    return {
      protocol: 'http',
      host: this.cfg.host,
      port: this.cfg.port,
      username: `${this.cfg.username}-country-${country.toLowerCase()}${session}`,
      password: this.cfg.password,
      provider: 'smartproxy',
      country,
    };
  }

  get name() { return 'smartproxy'; }
}
