/**
 * RecaptchaV2Service — reCAPTCHA v2 (checkbox + grid challenge) solver.
 *
 * Uses the @2captcha/captcha-solver SDK for the grid method.
 * Directly interacts with Playwright frames — this is a browser-level service,
 * not a simple token provider.
 *
 * Usage:
 *   const svc = RecaptchaV2Service.getInstance();
 *   const result = await svc.detectAndSolveGmailCaptcha(page);
 *   // result: { success: boolean, solution?: string, error?: string }
 *
 * Adapted from the project reference implementation.
 */

import { Solver } from '@2captcha/captcha-solver';
import config from '../../config/index.js';
import logger from '../../logger/index.js';

/** @typedef {{ success: boolean; solution?: string; error?: string }} CaptchaResult */

export class RecaptchaV2Service {
  static instance = null;

  constructor(apiKey) {
    this.apiKey =
      apiKey ||
      config.captcha.twoCaptcha.apiKey ||
      process.env.CAPTCHA_API_KEY ||
      process.env.TWOCAPTCHA_API_KEY ||
      '';

    if (!this.apiKey) {
      logger.warn('TWO_CAPTCHA_API_KEY / CAPTCHA_API_KEY is not set.');
      throw new Error('2Captcha API key is required');
    }

    try {
      this.solver = new Solver(this.apiKey, 300);
      logger.info('2captcha RecaptchaV2Service initialized');
    } catch (error) {
      logger.error('Failed to initialize 2captcha solver', { error: error.message });
      throw error;
    }
  }

  static getInstance() {
    if (!RecaptchaV2Service.instance) {
      RecaptchaV2Service.instance = new RecaptchaV2Service();
    }
    return RecaptchaV2Service.instance;
  }

  /** @param {number} ms */
  async wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * reCAPTCHA v2: click checkbox, then solve grid challenge if it appears.
   * @param {import('playwright').Page} page
   * @returns {Promise<CaptchaResult>}
   */
  async detectAndSolveGmailCaptcha(page) {
    try {
      logger.info('Starting reCAPTCHA v2 solver (checkbox + grid)');

      const checkboxClicked = await this.clickCheckbox(page);
      if (!checkboxClicked) {
        return { success: false, error: 'Checkbox not found' };
      }

      await this.wait(2000);
      const hasGridChallenge = await this.waitForGridOrPass(page, 12000);
      if (!hasGridChallenge) {
        logger.info('Checkbox solved captcha without grid challenge');
        return { success: true, solution: 'checkbox-only' };
      }

      logger.info('Grid challenge detected, solving');
      const gridSolved = await this.solveGridChallenge(page);

      return gridSolved
        ? { success: true, solution: 'grid-solved' }
        : { success: false, error: 'Grid solving failed' };
    } catch (error) {
      logger.error('Captcha solving failed', { error: error.message });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * @param {import('playwright').Page} page
   * @returns {Promise<boolean>}
   */
  async clickCheckbox(page) {
    try {
      logger.debug('Clicking reCAPTCHA checkbox');

      const frameHandle = await page.waitForSelector('iframe[title="reCAPTCHA"]', { timeout: 10000 });
      if (!frameHandle) return false;

      const frame = await frameHandle.contentFrame();
      if (!frame) return false;

      const clicked = await frame.evaluate(() => {
        const checkbox = document.querySelector('span.recaptcha-checkbox-unchecked');
        if (checkbox) {
          /** @type {HTMLElement} */ (checkbox).click();
          return true;
        }
        return false;
      });

      if (clicked) {
        logger.debug('reCAPTCHA checkbox clicked');
        return true;
      }
      return false;
    } catch (error) {
      logger.warn('Checkbox click failed', { error: error.message });
      return false;
    }
  }

  /**
   * @param {import('playwright').Page} page
   * @returns {Promise<boolean>}
   */
  async hasGridChallenge(page) {
    try {
      const challengeFrame = await page.$('iframe[src*="https://www.google.com/recaptcha/api2/bframe"]');
      return challengeFrame !== null;
    } catch {
      return false;
    }
  }

  /**
   * Poll for grid challenge to appear or captcha to pass.
   * @param {import('playwright').Page} page
   * @param {number} timeoutMs
   * @returns {Promise<boolean>} true if grid is visible, false if challenge already passed
   */
  async waitForGridOrPass(page, timeoutMs = 12000) {
    const step = 500;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isRecaptchaPassed(page)) return false;
      if (await this.hasGridChallenge(page)) return true;
      await this.wait(step);
    }
    return await this.hasGridChallenge(page);
  }

  /**
   * Detect "Verification challenge expired" so we can re-click instead of looping on stale challenge.
   * @param {import('playwright').Page} page
   * @returns {Promise<boolean>}
   */
  async isChallengeExpired(page) {
    try {
      const anchorFrame = await page.$('iframe[title="reCAPTCHA"]');
      if (anchorFrame) {
        const frame = await anchorFrame.contentFrame();
        if (frame) {
          const expired = await frame.evaluate(() => {
            const text = document.body?.innerText ?? '';
            return /expired|check the checkbox again/i.test(text);
          });
          if (expired) return true;
        }
      }
      const bframe = await page.$('iframe[src*="https://www.google.com/recaptcha/api2/bframe"]');
      if (bframe) {
        const frame = await bframe.contentFrame();
        if (frame) {
          const expired = await frame.evaluate(() => {
            const text = document.body?.innerText ?? '';
            return /expired|check the checkbox again/i.test(text);
          });
          if (expired) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * @param {import('playwright').Page} page
   * @returns {Promise<boolean>}
   */
  async solveGridChallenge(page) {
    try {
      const frameHandle = await page.waitForSelector(
        'iframe[src*="https://www.google.com/recaptcha/api2/bframe"]',
        { timeout: 10000 },
      );
      if (!frameHandle) return false;

      const frame = await frameHandle.contentFrame();
      if (!frame) return false;

      await this.wait(2000);
      await this.initCaptchaParamsExtractor(frame);

      const maxRounds = 8;

      for (let round = 1; round <= maxRounds; round++) {
        logger.debug(`Grid round ${round}/${maxRounds}`);

        if (await this.isChallengeExpired(page)) {
          logger.warn('Challenge expired – re-clicking checkbox');
          await this.clickCheckbox(page);
          if (await this.waitForRecaptchaPassed(page, 15000)) return true;
          continue;
        }

        const captchaParams = await this.getCaptchaParams(frame);
        if (!captchaParams) {
          logger.debug('No grid / no new images – clicking verify');
          await this.wait(500);
          await this.clickVerifyButton(page);
          if (await this.waitForRecaptchaPassed(page, 15000)) {
            logger.info('Grid captcha solved');
            return true;
          }
          continue;
        }

        logger.debug('Grid params', {
          grid: `${captchaParams.columns}x${captchaParams.rows}`,
          comment: captchaParams.comment,
          imageBytes: captchaParams.body?.length ?? 0,
        });

        if (!captchaParams.body || captchaParams.body.length < 1000) {
          logger.warn('Image too small – clicking verify');
          await this.clickVerifyButton(page);
          if (await this.waitForRecaptchaPassed(page, 15000)) return true;
          continue;
        }
        if (!captchaParams.comment || captchaParams.comment.length < 5) {
          logger.warn('No instructions – clicking verify');
          await this.clickVerifyButton(page);
          if (await this.waitForRecaptchaPassed(page, 15000)) return true;
          continue;
        }

        if (await this.isChallengeExpired(page)) {
          logger.warn('Challenge expired before send – re-clicking checkbox');
          await this.clickCheckbox(page);
          if (await this.waitForRecaptchaPassed(page, 15000)) return true;
          continue;
        }

        logger.debug('Sending grid image to 2captcha');
        const answer = await this.solver.grid({
          recaptcha: 1,
          body: captchaParams.body,
          textinstructions: captchaParams.comment,
          cols: captchaParams.columns,
          rows: captchaParams.rows,
          canSkip: 1,
          lang: 'en',
        });

        const answerData   = answer?.data ?? answer?.solution?.click;
        const answerStatus = answer?.status;
        const isReady      = answerStatus === 1 || answerStatus === 'ready' || answer?.errorId === 0;

        logger.debug('2captcha grid response', { answer: answerData });

        if (!isReady) {
          logger.error('2captcha solving failed');
          continue;
        }

        const dataStr = Array.isArray(answerData)
          ? `click:${answerData.join('/')}`
          : String(answerData || '');

        if (dataStr === 'No_matching_images' || answerData === 'No_matching_images') {
          logger.debug('No matching images – clicking Skip');
          await this.wait(800);
          await this.clickSkipButton(page);
          if (await this.waitForRecaptchaPassed(page, 15000)) {
            logger.info('Grid captcha solved via Skip');
            return true;
          }
          continue;
        }

        if (dataStr.includes('ERROR_CAPTCHA_UNSOLVABLE') || answerData === 'ERROR_CAPTCHA_UNSOLVABLE') {
          logger.warn('2captcha says unsolvable, clicking verify');
          await this.clickVerifyButton(page);
          if (await this.waitForRecaptchaPassed(page, 15000)) return true;
          continue;
        }

        const clicks = Array.isArray(answerData)
          ? answerData.map((n) => Number(n))
          : this.parseClicks(dataStr);

        if (!dataStr.startsWith('click:') && !Array.isArray(answerData)) {
          logger.error('Invalid 2captcha response format', { dataStr });
          continue;
        }

        const maxPosition = captchaParams.columns * captchaParams.rows;
        const validClicks = clicks.filter((c) => c >= 1 && c <= maxPosition);
        if (validClicks.length !== clicks.length) {
          logger.error('Invalid click positions', { clicks, maxPosition });
          continue;
        }

        logger.debug('Performing grid clicks', { positions: validClicks });
        await this.performClicks(page, validClicks, captchaParams.columns, captchaParams.rows);
        await this.wait(2000);
        await this.clickNextOrVerifyButton(page);
        if (await this.waitForRecaptchaPassed(page, 15000)) {
          logger.info('Grid captcha solved');
          return true;
        }
      }

      logger.debug('Max rounds reached – clicking verify');
      await this.clickVerifyButton(page);
      return await this.waitForRecaptchaPassed(page, 15000);
    } catch (error) {
      logger.error('Grid challenge solving failed', { error: error.message });
      return false;
    }
  }

  /** @param {import('playwright').Frame} frame */
  async initCaptchaParamsExtractor(frame) {
    await frame.evaluate(() => {
      window.getCaptchaParams = () => {
        const imageSelectors = [
          '.rc-image-tile-wrapper img',
          '.rc-imageselect-payload img',
          '.rc-imageselect-target img',
          "img[src*='payload']",
          "img[src*='image']",
        ];

        let imageElement = null;
        for (const selector of imageSelectors) {
          const el = document.querySelector(selector);
          if (el && el.complete && el.naturalWidth > 0) {
            imageElement = el;
            break;
          }
        }

        const instructionSelectors = [
          '.rc-imageselect-instructions-hidden',
          '.rc-imageselect-instructions',
          '.rc-imageselect-desc-wrapper',
          '.rc-imageselect-desc',
          '.rc-imageselect-desc-no-canonical',
        ];

        let instructionText = '';
        for (const selector of instructionSelectors) {
          const el = document.querySelector(selector);
          if (el) {
            const text = el.innerText?.trim() || '';
            if (text.length > 5) {
              instructionText = text;
              break;
            }
          }
        }

        if (!imageElement || !instructionText) return null;

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width  = imageElement.naturalWidth  || imageElement.width;
        canvas.height = imageElement.naturalHeight || imageElement.height;
        if (ctx) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(imageElement, 0, 0);
        }

        let columns = 3, rows = 3;
        const cellSelectors = [
          '.rc-imageselect-table-33 td',
          '.rc-imageselect-table-44 td',
          '.rc-imageselect-table td',
          '.rc-imageselect-tile',
        ];
        for (const selector of cellSelectors) {
          const cells = document.querySelectorAll(selector);
          if (cells.length === 9)  { columns = rows = 3; break; }
          if (cells.length === 16) { columns = rows = 4; break; }
        }

        return {
          body: canvas.toDataURL('image/png').split(',')[1],
          comment: instructionText,
          columns,
          rows,
        };
      };
    });
  }

  /**
   * @param {import('playwright').Frame} frame
   * @returns {Promise<{ body: string; comment: string; columns: number; rows: number } | null>}
   */
  async getCaptchaParams(frame) {
    try {
      return await frame.evaluate(() => window.getCaptchaParams?.() ?? null);
    } catch (error) {
      logger.error('Error getting captcha params', { error: error.message });
      return null;
    }
  }

  /** @param {string} data */
  parseClicks(data) {
    return data.replace('click:', '').split('/').map((el) => Number(el));
  }

  /**
   * @param {import('playwright').Page} page
   * @param {number[]} clicks  1-based positions (row-major: 1=top-left)
   * @param {number}   cols
   * @param {number}   rows
   */
  async performClicks(page, clicks, cols, rows) {
    logger.debug(`Performing ${clicks.length} clicks on ${cols}x${rows} grid`);
    for (let i = 0; i < clicks.length; i++) {
      await this.wait(100 * i);
      await this.clickAtCoordinates(page, clicks[i], cols, rows);
    }
  }

  /**
   * Click a grid cell by 1-based row-major position.
   * @param {import('playwright').Page} page
   * @param {number} position
   * @param {number} cols
   * @param {number} rows
   */
  async clickAtCoordinates(page, position, cols, rows) {
    const row = Math.floor((position - 1) / cols);
    const col = (position - 1) % cols;
    if (row < 0 || row >= rows || col < 0 || col >= cols) {
      logger.warn('Grid position out of range', { position, cols, rows });
      return;
    }
    try {
      const frame = page.frameLocator('iframe[src*="https://www.google.com/recaptcha/api2/bframe"]');
      const tableSelectors = [
        '.rc-imageselect-table-33',
        '.rc-imageselect-table-44',
        '.rc-imageselect-table',
      ];
      let clicked = false;
      for (const tableSel of tableSelectors) {
        const table = frame.locator(tableSel);
        if ((await table.count()) === 0) continue;
        const rowsLoc = table.first().locator('tr');
        if ((await rowsLoc.count()) <= row) continue;
        const cell = rowsLoc.nth(row).locator('td').nth(col);
        if ((await cell.count()) > 0) {
          await this.wait(80);
          await cell.click({ delay: 60 });
          clicked = true;
          logger.debug(`Clicked grid position ${position} (row ${row + 1}, col ${col + 1})`);
          break;
        }
      }
      if (!clicked) logger.warn('Could not find grid cell', { position, row, col });
      await this.wait(200);
    } catch (error) {
      logger.error(`Error clicking grid position ${position}`, { error: error.message });
    }
  }

  /**
   * Click "Skip" when 2captcha returns No_matching_images. Falls back to Verify.
   * @param {import('playwright').Page} page
   */
  async clickSkipButton(page) {
    try {
      const frame = page.frameLocator('iframe[src*="https://www.google.com/recaptcha/api2/bframe"]');
      const skipById = frame.locator('#recaptcha-skip-button');
      if ((await skipById.count()) > 0) {
        await skipById.click({ delay: 80 });
        logger.debug('Clicked Skip button');
        return;
      }
      const skipByText = frame.getByText('Skip', { exact: true });
      if ((await skipByText.count()) > 0) {
        await skipByText.first().click({ delay: 80 });
        logger.debug('Clicked Skip (by text)');
        return;
      }
      logger.debug('Skip not found, falling back to Verify');
      await this.clickNextOrVerifyButton(page);
    } catch (error) {
      logger.warn('Skip button click failed, trying Verify', { error: error.message });
      await this.clickNextOrVerifyButton(page);
    }
  }

  /**
   * Click "NEXT" or "Verify" in the challenge frame.
   * @param {import('playwright').Page} page
   */
  async clickNextOrVerifyButton(page) {
    try {
      const frame = page.frameLocator('iframe[src*="https://www.google.com/recaptcha/api2/bframe"]');
      const btn = frame.locator('#recaptcha-verify-button');
      if ((await btn.count()) > 0) {
        await btn.click({ delay: 80 });
        logger.debug('Clicked NEXT/Verify button');
      }
    } catch (error) {
      logger.warn('NEXT/Verify button click failed', { error: error.message });
    }
  }

  /** @param {import('playwright').Page} page */
  async clickVerifyButton(page) {
    await this.clickNextOrVerifyButton(page);
  }

  /**
   * Detect if reCAPTCHA is solved: bframe gone OR checkbox is checked.
   * @param {import('playwright').Page} page
   * @returns {Promise<boolean>}
   */
  async isRecaptchaPassed(page) {
    try {
      const bframe = await page.$('iframe[src*="https://www.google.com/recaptcha/api2/bframe"]');
      if (!bframe) return true;

      const anchorFrame = await page.$('iframe[title="reCAPTCHA"]');
      if (anchorFrame) {
        const frame = await anchorFrame.contentFrame();
        if (frame) {
          const checked = await frame.evaluate(() => {
            const el = document.querySelector('.recaptcha-checkbox-checked, [aria-checked="true"]');
            return !!el;
          });
          if (checked) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Poll until reCAPTCHA passes or timeout.
   * @param {import('playwright').Page} page
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  async waitForRecaptchaPassed(page, timeoutMs = 15000) {
    const step = 500;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isRecaptchaPassed(page)) return true;
      await this.wait(step);
    }
    return false;
  }
}

/**
 * Get or create singleton. Reads TWO_CAPTCHA_API_KEY from config/env.
 * @returns {RecaptchaV2Service}
 */
export function getRecaptchaV2Service() {
  return RecaptchaV2Service.getInstance();
}

export default RecaptchaV2Service;
