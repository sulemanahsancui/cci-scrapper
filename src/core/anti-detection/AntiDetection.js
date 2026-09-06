/**
 * AntiDetection — stealth layer applied to every browser page.
 *
 * Responsibilities:
 *   - Inject fingerprint overrides (WebGL, canvas, timezone, language)
 *   - Simulate human-like mouse movement, scrolling, and typing
 *   - Rotate user-agents per session
 *   - Intercept navigator properties that leak automation
 */

import { generateFingerprint } from '../../utils/fingerprint.js';
import { sleep } from '../../utils/sleep.js';
import logger from '../../logger/index.js';

export class AntiDetection {
  constructor(options = {}) {
    this.options = {
      humanMouse: true,
      humanScroll: true,
      humanTyping: true,
      fingerprintOverride: true,
      ...options,
    };
  }

  /**
   * Apply all stealth patches to a Playwright or Puppeteer page.
   * @param {object} page - Playwright Page or Puppeteer Page
   * @param {string} engine - 'playwright' | 'puppeteer'
   */
  async applyTo(page, engine = 'playwright') {
    const fingerprint = generateFingerprint(this.options.fingerprint);
    logger.debug('Applying anti-detection fingerprint', { timezone: fingerprint.timezone });

    if (engine === 'playwright') {
      await this._patchPlaywright(page, fingerprint);
    } else {
      await this._patchPuppeteer(page, fingerprint);
    }
  }

  async _patchPlaywright(page, fp) {
    // Override user-agent via extra HTTP headers
    await page.setExtraHTTPHeaders({ 'Accept-Language': fp.language });

    // Inject JS overrides before any page script runs
    await page.addInitScript((fingerprint) => {
      // ── Navigator ──────────────────────────────────────────────────────────
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => [fingerprint.language, 'en'] });
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

      // ── Chrome object (expected by detection scripts) ──────────────────────
      window.chrome = { runtime: {} };

      // ── WebGL fingerprint ─────────────────────────────────────────────────
      const getParam = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (param) {
        if (param === 37445) return fingerprint.webgl.vendor;
        if (param === 37446) return fingerprint.webgl.renderer;
        return getParam.call(this, param);
      };

      // ── Canvas fingerprint (add imperceptible noise) ───────────────────────
      const toDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (...args) {
        const ctx = this.getContext('2d');
        if (ctx) {
          const imageData = ctx.getImageData(0, 0, this.width, this.height);
          for (let i = 0; i < imageData.data.length; i += 4) {
            imageData.data[i]     += Math.floor(Math.random() * 2);
            imageData.data[i + 1] += Math.floor(Math.random() * 2);
          }
          ctx.putImageData(imageData, 0, 0);
        }
        return toDataURL.apply(this, args);
      };

      // ── Permissions ───────────────────────────────────────────────────────
      const origQuery = window.navigator.permissions?.query;
      if (origQuery) {
        window.navigator.permissions.query = (params) =>
          params.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : origQuery(params);
      }
    }, fp);

    // Set viewport to match fingerprint screen
    await page.setViewportSize({ width: fp.screen.width, height: fp.screen.height });
  }

  async _patchPuppeteer(page, fp) {
    await page.setUserAgent(fp.userAgent);
    await page.setExtraHTTPHeaders({ 'Accept-Language': fp.language });
    await page.setViewport({ width: fp.screen.width, height: fp.screen.height });

    await page.evaluateOnNewDocument((fingerprint) => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => [fingerprint.language, 'en'] });
      window.chrome = { runtime: {} };
    }, fp);
  }

  // ── Human-like interactions ─────────────────────────────────────────────────

  /**
   * Move the mouse to a target element using a bezier-curve path.
   */
  async humanClick(page, selector, engine = 'playwright') {
    if (!this.options.humanMouse) {
      return engine === 'playwright' ? page.click(selector) : page.click(selector);
    }

    const element = engine === 'playwright'
      ? await page.locator(selector).first()
      : await page.$(selector);

    const box = engine === 'playwright'
      ? await element.boundingBox()
      : await element.boundingBox();

    if (!box) throw new Error(`Element not found or not visible: ${selector}`);

    const targetX = box.x + box.width  / 2 + (Math.random() * 10 - 5);
    const targetY = box.y + box.height / 2 + (Math.random() * 10 - 5);

    await this._bezierMouseMove(page, targetX, targetY, engine);
    await sleep(Math.random() * 150 + 50);

    if (engine === 'playwright') {
      await page.mouse.click(targetX, targetY);
    } else {
      await page.mouse.click(targetX, targetY);
    }
  }

  /**
   * Type text with randomised per-character delays.
   */
  async humanType(page, selector, text, engine = 'playwright') {
    await this.humanClick(page, selector, engine);
    await sleep(200);

    for (const char of text) {
      const delay = Math.floor(Math.random() * 120) + 40;
      if (engine === 'playwright') {
        await page.keyboard.type(char, { delay });
      } else {
        await page.keyboard.type(char, { delay });
      }
      // Occasional longer pause to simulate thinking
      if (Math.random() < 0.05) await sleep(Math.random() * 500 + 200);
    }
  }

  /**
   * Scroll a page gradually, simulating real user scroll behaviour.
   */
  async humanScroll(page, { direction = 'down', distance = 800, steps = 10 } = {}) {
    if (!this.options.humanScroll) return;

    const delta = direction === 'down' ? distance / steps : -(distance / steps);
    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(0, delta);
      await sleep(Math.random() * 100 + 30);
    }
  }

  async _bezierMouseMove(page, endX, endY, engine) {
    const steps = 20 + Math.floor(Math.random() * 15);
    // Simple quadratic bezier: start → control → end
    const startX = Math.random() * 400;
    const startY = Math.random() * 400;
    const cpX = (startX + endX) / 2 + (Math.random() - 0.5) * 200;
    const cpY = (startY + endY) / 2 + (Math.random() - 0.5) * 200;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = (1 - t) ** 2 * startX + 2 * (1 - t) * t * cpX + t ** 2 * endX;
      const y = (1 - t) ** 2 * startY + 2 * (1 - t) * t * cpY + t ** 2 * endY;
      await page.mouse.move(x, y);
      await sleep(Math.random() * 20 + 5);
    }
  }
}

export default AntiDetection;
