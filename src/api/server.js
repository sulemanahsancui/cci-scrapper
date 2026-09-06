/**
 * Express API Server
 *
 * Endpoints:
 *   POST   /api/v1/jobs
 *   GET    /api/v1/jobs
 *   GET    /api/v1/jobs/stats
 *   GET    /api/v1/jobs/:id
 *   DELETE /api/v1/jobs/:id
 *   GET    /metrics          (Prometheus format)
 *   GET    /health
 */

import express from 'express';
import helmet  from 'helmet';
import cors    from 'cors';
import rateLimit from 'express-rate-limit';
import { ping }         from '../database/connection.js';
import { authenticate } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import jobsRouter       from './routes/jobs.js';
import Monitor          from '../monitoring/Monitor.js';
import config           from '../config/index.js';
import logger           from '../logger/index.js';

const app = express();

// ── Security ─────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ── Rate Limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});
app.use('/api/', limiter);

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const dbOk = await ping().catch(() => false);
  const status = dbOk ? 200 : 503;
  res.status(status).json({ status: dbOk ? 'ok' : 'degraded', db: dbOk });
});

// ── Prometheus metrics ────────────────────────────────────────────────────────
app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send(Monitor.toPrometheus());
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/v1/jobs', authenticate, jobsRouter);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ── Error handler (must be last) ──────────────────────────────────────────────
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = config.port;
app.listen(PORT, () => {
  logger.info(`API server listening on port ${PORT}`, { env: config.env });
});

export default app;
