/**
 * Exporter — format-agnostic data export facade.
 *
 * Usage:
 *   const exporter = new Exporter();
 *   await exporter.export(data, { format: 'csv', filename: 'results' });
 *   await exporter.export(data, { format: 'json' });
 *   await exporter.export(data, { format: 'db', jobId: '...', scraper: '...' });
 */

import { CsvExporter }    from './CsvExporter.js';
import { JsonExporter }   from './JsonExporter.js';
import ResultRepository   from '../repositories/ResultRepository.js';
import { ValidationError } from '../errors/index.js';
import logger             from '../logger/index.js';

export class Exporter {
  constructor(options = {}) {
    this._csv    = new CsvExporter(options);
    this._json   = new JsonExporter(options);
    this._db     = new ResultRepository();
    this.defaultFormat = options.defaultFormat ?? 'json';
  }

  /**
   * Export data to the specified format (or all formats if format = 'all').
   * @param {Array}  data
   * @param {object} opts
   * @param {string} opts.format   - 'csv' | 'json' | 'db' | 'all'
   * @param {string} opts.filename - Base filename (no extension)
   * @param {string} opts.jobId    - For DB export
   * @param {string} opts.scraper  - For DB export
   */
  async export(data, opts = {}) {
    const format = opts.format ?? this.defaultFormat;

    if (!Array.isArray(data)) {
      throw new ValidationError('Exporter expects an array of records');
    }
    if (!data.length) {
      logger.warn('Exporter: empty dataset, nothing to export');
      return {};
    }

    const results = {};

    if (format === 'csv' || format === 'all') {
      results.csv = await this._csv.export(data, opts);
    }
    if (format === 'json' || format === 'all') {
      results.json = await this._json.export(data, opts);
    }
    if (format === 'db' || format === 'all') {
      results.db = await this._exportToDb(data, opts);
    }

    return results;
  }

  async _exportToDb(data, opts) {
    const rows = data.map((item) => ({
      jobId:   opts.jobId   ?? null,
      scraper: opts.scraper ?? 'unknown',
      url:     item.url     ?? null,
      data:    item,
    }));
    return this._db.bulkInsert(rows);
  }
}

export default Exporter;
