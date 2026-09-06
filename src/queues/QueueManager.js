/**
 * QueueManager — BullMQ-based job queue with named queues and worker management.
 *
 * Architecture:
 *   QueueManager creates/manages BullMQ Queue instances.
 *   Workers consume jobs from these queues (in ScrapingWorker.js).
 *
 * Usage:
 *   await queueManager.enqueue('scraping', { scraper: 'ExampleScraper', input: {} });
 *   await queueManager.enqueue('scraping', job, { delay: 5000, priority: 10 });
 */

import { Queue, QueueEvents } from 'bullmq';
import config from '../config/index.js';
import logger from '../logger/index.js';
import Monitor from '../monitoring/Monitor.js';

const QUEUES = ['scraping', 'automation', 'retry'];

export class QueueManager {
  constructor(options = {}) {
    this._connection = {
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
    };

    this._queues = new Map();
    this._events = new Map();

    const queueNames = options.queues ?? QUEUES;
    for (const name of queueNames) {
      this._registerQueue(name);
    }
  }

  /**
   * Add a job to a named queue.
   * @param {string} queueName - 'scraping' | 'automation' | 'retry'
   * @param {object} payload   - Job data
   * @param {object} opts      - BullMQ job options (delay, priority, attempts, …)
   */
  async enqueue(queueName, payload, opts = {}) {
    const queue = this._getQueue(queueName);
    const job = await queue.add(payload.scraper ?? queueName, payload, {
      attempts: opts.attempts ?? 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: config.queue?.removeOnComplete ?? 1000,
      removeOnFail:     config.queue?.removeOnFail     ?? 5000,
      ...opts,
    });

    logger.info('Job enqueued', { queue: queueName, jobId: job.id, scraper: payload.scraper });
    Monitor.increment('queue.enqueued', { queue: queueName });
    return job;
  }

  /** Get job counts for a queue. */
  async stats(queueName) {
    const queue = this._getQueue(queueName);
    return queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
  }

  /** Pause a queue (no new jobs will start). */
  async pause(queueName) {
    await this._getQueue(queueName).pause();
    logger.info('Queue paused', { queue: queueName });
  }

  /** Resume a paused queue. */
  async resume(queueName) {
    await this._getQueue(queueName).resume();
    logger.info('Queue resumed', { queue: queueName });
  }

  /** Drain all waiting jobs from a queue. */
  async drain(queueName) {
    await this._getQueue(queueName).drain();
    logger.warn('Queue drained', { queue: queueName });
  }

  async close() {
    for (const queue of this._queues.values()) await queue.close();
    for (const events of this._events.values()) await events.close();
  }

  _registerQueue(name) {
    const queue  = new Queue(name, { connection: this._connection });
    const events = new QueueEvents(name, { connection: this._connection });

    events.on('completed', ({ jobId }) => {
      Monitor.increment('queue.completed', { queue: name });
      logger.debug('Job completed', { queue: name, jobId });
    });
    events.on('failed', ({ jobId, failedReason }) => {
      Monitor.increment('queue.failed', { queue: name });
      logger.error('Job failed', { queue: name, jobId, reason: failedReason });
    });

    this._queues.set(name, queue);
    this._events.set(name, events);
  }

  _getQueue(name) {
    const queue = this._queues.get(name);
    if (!queue) throw new Error(`Unknown queue: ${name}`);
    return queue;
  }
}

export default QueueManager;
