import { BaseRepository } from './BaseRepository.js';

export class JobRepository extends BaseRepository {
  constructor() {
    super('jobs');
  }

  async findPending(limit = 50) {
    const { rows } = await this.query(
      `SELECT * FROM jobs
       WHERE status = 'pending'
         AND (scheduled_at IS NULL OR scheduled_at <= NOW())
       ORDER BY priority DESC, created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return rows;
  }

  async markRunning(id) {
    return this.update(id, { status: 'running', started_at: new Date() });
  }

  async markCompleted(id) {
    return this.update(id, { status: 'completed', completed_at: new Date() });
  }

  async markFailed(id, error) {
    return this.update(id, { status: 'failed', completed_at: new Date() });
  }

  async recordRun(jobId, attempt, { status, error = null, durationMs = null }) {
    return this.create.call(
      { table: 'job_runs', pool: this.pool },
      { job_id: jobId, attempt, status, error, duration_ms: durationMs, ended_at: new Date() },
    );
  }

  async stats() {
    const { rows } = await this.query(`
      SELECT
        status,
        COUNT(*) AS count,
        AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000) AS avg_duration_ms
      FROM jobs
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY status
    `);
    return rows;
  }
}

export default JobRepository;
