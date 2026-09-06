/**
 * PostgreSQL connection pool — shared across all repositories.
 *
 * Usage:
 *   import pool from './connection.js';
 *   const { rows } = await pool.query('SELECT 1');
 */

import pg from 'pg';
import config from '../config/index.js';
import logger from '../logger/index.js';

const { Pool } = pg;

const pool = new Pool({
  host:     config.db.host,
  port:     config.db.port,
  database: config.db.database,
  user:     config.db.user,
  password: config.db.password,
  min:      config.db.pool.min,
  max:      config.db.pool.max,
  idleTimeoutMillis:    30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('connect',  ()    => logger.debug('DB pool: new connection'));
pool.on('error',    (err) => logger.error('DB pool error', { error: err.message }));

/** Healthcheck — returns true if the DB is reachable. */
export async function ping() {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    return true;
  } finally {
    client.release();
  }
}

export default pool;
