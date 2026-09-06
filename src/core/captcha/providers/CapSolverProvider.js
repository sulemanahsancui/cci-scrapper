/**
 * CapSolverProvider — solves CAPTCHAs via the capsolver.com API (v2 task format).
 */

import axios from 'axios';
import { CaptchaError } from '../../../errors/index.js';
import { sleep } from '../../../utils/sleep.js';
import config from '../../../config/index.js';
import logger from '../../../logger/index.js';

const BASE_URL = 'https://api.capsolver.com';
const POLL_INTERVAL = 3_000;
const MAX_POLL_ATTEMPTS = 100;

export class CapSolverProvider {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? config.captcha.capSolver.apiKey;
    if (!this.apiKey) throw new CaptchaError('CapSolver API key not configured');
  }

  async solve({ type, ...params }) {
    const task = this._buildTask(type, params);
    const { data: createData } = await axios.post(`${BASE_URL}/createTask`, {
      clientKey: this.apiKey,
      task,
    });

    if (createData.errorId !== 0) {
      throw new CaptchaError(`CapSolver createTask error: ${createData.errorDescription}`, { type });
    }

    const taskId = createData.taskId;
    logger.debug('CapSolver task created', { taskId, type });
    return this._pollResult(taskId);
  }

  async _pollResult(taskId) {
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      await sleep(POLL_INTERVAL);
      const { data } = await axios.post(`${BASE_URL}/getTaskResult`, {
        clientKey: this.apiKey,
        taskId,
      });

      if (data.status === 'processing') continue;
      if (data.status === 'ready') return data.solution.gRecaptchaResponse ?? data.solution.token;
      throw new CaptchaError(`CapSolver error: ${data.errorDescription}`, { taskId });
    }
    throw new CaptchaError('CapSolver polling timeout', { taskId });
  }

  _buildTask(type, params) {
    switch (type) {
      case 'recaptcha_v2':
        return { type: 'ReCaptchaV2Task', websiteURL: params.pageUrl, websiteKey: params.siteKey };
      case 'recaptcha_v3':
        return { type: 'ReCaptchaV3Task', websiteURL: params.pageUrl, websiteKey: params.siteKey, pageAction: params.action ?? 'verify' };
      case 'hcaptcha':
        return { type: 'HCaptchaTask', websiteURL: params.pageUrl, websiteKey: params.siteKey };
      case 'turnstile':
        return { type: 'AntiTurnstileTaskProxyLess', websiteURL: params.pageUrl, websiteKey: params.siteKey };
      default:
        throw new CaptchaError(`Unsupported captcha type: ${type}`);
    }
  }

  get name() { return 'capsolver'; }
}
