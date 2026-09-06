import { BaseRepository } from './BaseRepository.js';

export class ResultRepository extends BaseRepository {
  constructor() {
    super('scraping_results');
  }

  async bulkInsert(rows) {
    if (!rows.length) return [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = [];
      for (const row of rows) {
        const { rows: r } = await client.query(
          `INSERT INTO scraping_results (job_id, scraper, url, data)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [row.jobId, row.scraper, row.url, JSON.stringify(row.data)],
        );
        inserted.push(r[0]);
      }
      await client.query('COMMIT');
      return inserted;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async findByScraper(scraper, { limit = 100, offset = 0 } = {}) {
    return this.findAll({ where: { scraper }, limit, offset });
  }

  async searchData(jsonPath, value) {
    const { rows } = await this.query(
      `SELECT * FROM scraping_results WHERE data @> $1::jsonb`,
      [JSON.stringify({ [jsonPath]: value })],
    );
    return rows;
  }
}

export default ResultRepository;
