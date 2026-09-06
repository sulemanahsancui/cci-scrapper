import config from '../../../config/index.js';

export class OxylabsProvider {
  constructor(options = {}) {
    this.cfg = { ...config.proxies.oxylabs, ...options };
  }

  getProxy({ country = 'US', sticky = false, sessionId = null } = {}) {
    const session = sticky
      ? `-sessid-${sessionId ?? Math.random().toString(36).slice(2)}`
      : '';

    return {
      protocol: 'http',
      host: this.cfg.host,
      port: this.cfg.port,
      username: `${this.cfg.username}-cc-${country.toLowerCase()}${session}`,
      password: this.cfg.password,
      provider: 'oxylabs',
      country,
    };
  }

  get name() { return 'oxylabs'; }
}
