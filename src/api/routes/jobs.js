/**
 * Jobs API — CRUD + queue operations for scraping jobs.
 *
 * POST   /jobs          Create + enqueue a new job
 * GET    /jobs          List jobs (filterable by status)
 * GET    /jobs/:id      Get job by ID
 * DELETE /jobs/:id      Cancel / delete a job
 * GET    /jobs/stats    Aggregated status stats
 * GET    /metrics       Prometheus metrics
 */

import { Router } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import JobRepository from '../../repositories/JobRepository.js';
import QueueManager  from '../../queues/QueueManager.js';
import Monitor       from '../../monitoring/Monitor.js';

const router     = Router();
const jobRepo    = new JobRepository();
const queueMgr   = new QueueManager();

// ── Validation helpers ────────────────────────────────────────────────────────
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
}

// ── POST /jobs ─────────────────────────────────────────────────────────────────
router.post(
  '/',
  [
    body('scraper').isString().notEmpty().withMessage('scraper is required'),
    body('input').optional().isObject(),
    body('priority').optional().isInt({ min: 0, max: 100 }),
    body('scheduledAt').optional().isISO8601(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { scraper, input = {}, priority = 0, scheduledAt = null } = req.body;

      // Persist job record
      const job = await jobRepo.create({
        name: `${scraper}-${Date.now()}`,
        scraper,
        status: 'queued',
        input: JSON.stringify(input),
        priority,
        scheduled_at: scheduledAt,
      });

      // Enqueue in BullMQ
      const delay = scheduledAt
        ? Math.max(0, new Date(scheduledAt) - Date.now())
        : 0;

      await queueMgr.enqueue('scraping', { scraper, input, jobId: job.id }, { delay, priority });

      Monitor.increment('api.jobs.created');
      res.status(201).json(job);
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /jobs ──────────────────────────────────────────────────────────────────
router.get(
  '/',
  [
    query('status').optional().isIn(['pending','queued','running','completed','failed','cancelled']),
    query('scraper').optional().isString(),
    query('limit').optional().isInt({ min: 1, max: 500 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { status, scraper, limit = 50, offset = 0 } = req.query;
      const where = {};
      if (status)  where.status  = status;
      if (scraper) where.scraper = scraper;

      const [jobs, total] = await Promise.all([
        jobRepo.findAll({ where, limit: +limit, offset: +offset }),
        jobRepo.count(where),
      ]);

      res.json({ data: jobs, total, limit: +limit, offset: +offset });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /jobs/stats ────────────────────────────────────────────────────────────
router.get('/stats', async (req, res, next) => {
  try {
    const [dbStats, queueStats] = await Promise.all([
      jobRepo.stats(),
      queueMgr.stats('scraping'),
    ]);
    res.json({ db: dbStats, queue: queueStats, metrics: Monitor.snapshot() });
  } catch (err) {
    next(err);
  }
});

// ── GET /jobs/:id ──────────────────────────────────────────────────────────────
router.get(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const job = await jobRepo.findById(req.params.id);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      res.json(job);
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /jobs/:id ───────────────────────────────────────────────────────────
router.delete(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const job = await jobRepo.findById(req.params.id);
      if (!job) return res.status(404).json({ error: 'Job not found' });

      if (job.status === 'running') {
        return res.status(409).json({ error: 'Cannot delete a running job' });
      }

      await jobRepo.update(req.params.id, { status: 'cancelled' });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
