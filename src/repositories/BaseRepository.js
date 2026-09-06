/**
 * BaseRepository — generic CRUD operations over a PostgreSQL table.
 *
 * Extend this class and set `this.table` and `this.columns` to get
 * find / create / update / delete for free.
 */

import pool from '../database/connection.js';

export class BaseRepository {
  /** @param {string} table - Table name */
  constructor(table) {
    this.table = table;
    this.pool  = pool;
  }

  async findById(id) {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.table} WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findAll({ where = {}, limit = 100, offset = 0, orderBy = 'created_at DESC' } = {}) {
    const conditions = Object.keys(where);
    const values     = Object.values(where);
    const clause     = conditions.length
      ? 'WHERE ' + conditions.map((c, i) => `${c} = $${i + 1}`).join(' AND ')
      : '';

    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.table} ${clause} ORDER BY ${orderBy} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );
    return rows;
  }

  async count(where = {}) {
    const conditions = Object.keys(where);
    const values     = Object.values(where);
    const clause     = conditions.length
      ? 'WHERE ' + conditions.map((c, i) => `${c} = $${i + 1}`).join(' AND ')
      : '';
    const { rows } = await this.pool.query(
      `SELECT COUNT(*) AS total FROM ${this.table} ${clause}`,
      values,
    );
    return parseInt(rows[0].total, 10);
  }

  async create(data) {
    const keys   = Object.keys(data);
    const values = Object.values(data);
    const cols   = keys.join(', ');
    const params = keys.map((_, i) => `$${i + 1}`).join(', ');

    const { rows } = await this.pool.query(
      `INSERT INTO ${this.table} (${cols}) VALUES (${params}) RETURNING *`,
      values,
    );
    return rows[0];
  }

  async update(id, data) {
    const keys   = Object.keys(data);
    const values = Object.values(data);
    const set    = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');

    const { rows } = await this.pool.query(
      `UPDATE ${this.table} SET ${set} WHERE id = $${keys.length + 1} RETURNING *`,
      [...values, id],
    );
    return rows[0] ?? null;
  }

  async delete(id) {
    const { rowCount } = await this.pool.query(
      `DELETE FROM ${this.table} WHERE id = $1`,
      [id],
    );
    return rowCount > 0;
  }

  /** Run a raw query using the shared pool. */
  async query(sql, params = []) {
    return this.pool.query(sql, params);
  }

  /** Run multiple operations in a single transaction. */
  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export default BaseRepository;
