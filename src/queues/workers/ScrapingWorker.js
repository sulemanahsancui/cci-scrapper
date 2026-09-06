/**
 * ScrapingWorker — BullMQ worker that processes jobs from the 'scraping' queue.
 *
 * Each job payload must contain:
 *   { scraper: 'ScraperClassName', input: { ... } }
 *
 * The worker dynamically imports the named scraper from src/scrapers/.
 *
 * Run with: node src/queues/workers/ScrapingWorker.js
 * Scale by running multiple instances (docker deploy replicas: N).
 */

import { Worker } from 'bullmq';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import config    from '../../config/index.js';
import logger    from '../../logger/index.js';
import Monitor   from '../../monitoring/Monitor.js';
import JobRepository from '../../repositories/JobRepository.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRAPERS_DIR = path.join(__dirname, '../../scrapers');

const jobRepo = new JobRepository();

const worker = new Worker(
  'scraping',
  async (job) => {
    const { scraper: scraperName, input = {}, jobId } = job.data;

    logger.info('Worker processing job', { jobId: job.id, scraper: scraperName });
    Monitor.increment('worker.processing', { scraper: scraperName });

    if (jobId) await jobRepo.markRunning(jobId).catch(() => {});

    // Dynamically resolve scraper class
    const scraperPath = pathToFileURL(
      path.join(SCRAPERS_DIR, 'examples', `${scraperName}.js`),
    ).href;

    let ScraperClass;
    try {
      const mod = await import(scraperPath);
      ScraperClass = mod[scraperName] ?? mod.default;
    } catch {
      throw new Error(`Scraper not found: ${scraperName}`);
    }

    const scraperInstance = new ScraperClass();
    const result = await scraperInstance.run(input);

    if (jobId) await jobRepo.markCompleted(jobId).catch(() => {});
    Monitor.increment('worker.completed', { scraper: scraperName });

    return result;
  },
  {
    connection: {
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
    },
    concurrency: config.queue?.concurrency ?? 5,
  },
);

worker.on('failed', async (job, err) => {
  logger.error('Worker job failed', { jobId: job?.id, error: err.message });
  Monitor.increment('worker.failed');
  if (job?.data?.jobId) {
    await jobRepo.markFailed(job.data.jobId, err.message).catch(() => {});
  }
});

worker.on('error', (err) => {
  logger.error('Worker error', { error: err.message });
});

logger.info('Scraping worker started', { concurrency: config.queue?.concurrency ?? 5 });

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Worker shutting down…');
  await worker.close();
  process.exit(0);
});
