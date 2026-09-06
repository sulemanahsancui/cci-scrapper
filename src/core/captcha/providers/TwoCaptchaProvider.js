/**
 * TwoCaptchaProvider — solves CAPTCHAs via the 2captcha.com API.
 *
 * Supported types: recaptcha_v2, recaptcha_v3, hcaptcha, turnstile, image
 */

import axios from 'axios';
import { CaptchaError } from '../../../errors/index.js';
import { sleep } from '../../../utils/sleep.js';
import config from '../../../config/index.js';
import logger from '../../../logger/index.js';

const BASE_URL = 'https://2captcha.com';
const POLL_INTERVAL = 5_000;
const MAX_POLL_ATTEMPTS = 60; // 5 min max

export class TwoCaptchaProvider {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? config.captcha.twoCaptcha.apiKey;
    if (!this.apiKey) throw new CaptchaError('2Captcha API key not configured');
  }

  /** Solve any supported CAPTCHA type. */
  async solve({ type, ...params }) {
    const taskId = await this._createTask(type, params);
    logger.debug('2Captcha task created', { taskId, type });
    return this._pollResult(taskId);
  }

  async _createTask(type, params) {
    const payload = this._buildPayload(type, params);
    const { data } = await axios.post(`${BASE_URL}/in.php`, null, { params: payload });

    if (!data.startsWith('OK|')) {
      throw new CaptchaError(`2Captcha submission error: ${data}`, { type });
    }
    return data.split('|')[1];
  }

  async _pollResult(taskId) {
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      await sleep(POLL_INTERVAL);
      const { data } = await axios.get(`${BASE_URL}/res.php`, {
        params: { key: this.apiKey, action: 'get', id: taskId },
      });

      if (data === 'CAPCHA_NOT_READY') continue;
      if (data.startsWith('OK|')) return data.split('|')[1];
      throw new CaptchaError(`2Captcha error: ${data}`, { taskId });
    }
    throw new CaptchaError('2Captcha polling timeout', { taskId });
  }

  _buildPayload(type, params) {
    const base = { key: this.apiKey, json: 0 };

    switch (type) {
      case 'recaptcha_v2':
        return { ...base, method: 'userrecaptcha', googlekey: params.siteKey, pageurl: params.pageUrl };
      case 'recaptcha_v3':
        return { ...base, method: 'userrecaptcha', googlekey: params.siteKey, pageurl: params.pageUrl, version: 'v3', action: params.action ?? 'verify', min_score: params.minScore ?? 0.7 };
      case 'hcaptcha':
        return { ...base, method: 'hcaptcha', sitekey: params.siteKey, pageurl: params.pageUrl };
      case 'turnstile':
        return { ...base, method: 'turnstile', sitekey: params.siteKey, pageurl: params.pageUrl };
      case 'image':
        return { ...base, method: 'base64', body: params.image };
      default:
        throw new CaptchaError(`Unsupported captcha type: ${type}`);
    }
  }

  get name() { return '2captcha'; }
}
