/**
 * Seed script — populates initial data for local development.
 * Run with: node src/database/seeds/initial.js
 */

import pool from '../connection.js';
import logger from '../../logger/index.js';

async function seed() {
  const client = await pool.connect();
  try {
    // Sample proxy entries
    await client.query(`
      INSERT INTO proxies (provider, protocol, host, port, country)
      VALUES
        ('custom', 'http', '127.0.0.1', 8080, 'US'),
        ('custom', 'http', '127.0.0.1', 8081, 'GB')
      ON CONFLICT (host, port) DO NOTHING
    `);

    // Sample job
    await client.query(`
      INSERT INTO jobs (name, scraper, status, input)
      VALUES ('seed-job', 'ExampleScraper', 'pending', '{"pages": 1}')
    `);

    logger.info('Seed complete');
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
