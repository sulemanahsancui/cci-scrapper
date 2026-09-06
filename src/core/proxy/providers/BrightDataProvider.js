import config from '../../../config/index.js';

export class BrightDataProvider {
  constructor(options = {}) {
    this.cfg = { ...config.proxies.brightData, ...options };
  }

  /** Return a proxy config object for the given selection criteria. */
  getProxy({ country = 'US', sticky = false, sessionId = null } = {}) {
    const session = sticky
      ? `session-${sessionId ?? Math.random().toString(36).slice(2)}`
      : null;

    const username = [
      this.cfg.username,
      country  ? `country-${country.toLowerCase()}`  : null,
      session  ? session : null,
    ].filter(Boolean).join('-');

    return {
      protocol: 'http',
      host: this.cfg.host,
      port: this.cfg.port,
      username,
      password: this.cfg.password,
      provider: 'brightdata',
      country,
    };
  }

  get name() { return 'brightdata'; }
}
