/**
 * Scheduler — cron-based job scheduler backed by node-cron.
 *
 * Schedules repeating scraping jobs by enqueuing them into BullMQ
 * on a cron schedule.
 *
 * Usage:
 *   scheduler.schedule('0 * * * *', 'ExampleScraper', { pages: 5 });
 *   scheduler.start();
 */

import cron        from 'node-cron';
import QueueManager from '../queues/QueueManager.js';
import logger      from '../logger/index.js';

export class Scheduler {
  constructor(options = {}) {
    this._tasks       = new Map();
    this.queueManager = options.queueManager ?? new QueueManager();
  }

  /**
   * Schedule a scraper to run on a cron expression.
   * @param {string} name       - Unique schedule name
   * @param {string} expression - Cron expression (e.g. '0 * * * *')
   * @param {string} scraper    - Scraper class name
   * @param {object} input      - Input data for the scraper
   * @param {object} opts       - Queue job options
   */
  schedule(name, expression, scraper, input = {}, opts = {}) {
    if (!cron.validate(expression)) {
      throw new Error(`Invalid cron expression: ${expression}`);
    }

    if (this._tasks.has(name)) {
      logger.warn('Replacing existing schedule', { name });
      this._tasks.get(name).stop();
    }

    const task = cron.schedule(expression, async () => {
      logger.info('Scheduled job triggered', { name, scraper });
      await this.queueManager.enqueue('scraping', { scraper, input }, opts).catch((err) => {
        logger.error('Scheduler enqueue failed', { name, error: err.message });
      });
    }, { scheduled: false });

    this._tasks.set(name, task);
    logger.info('Schedule registered', { name, expression, scraper });
    return this;
  }

  /** Start all registered schedules. */
  start() {
    for (const [name, task] of this._tasks) {
      task.start();
      logger.info('Schedule started', { name });
    }
  }

  /** Stop a specific schedule by name. */
  stop(name) {
    const task = this._tasks.get(name);
    if (task) { task.stop(); logger.info('Schedule stopped', { name }); }
  }

  /** Stop all schedules. */
  stopAll() {
    for (const [name] of this._tasks) this.stop(name);
  }

  listSchedules() {
    return [...this._tasks.keys()];
  }
}

export default Scheduler;
