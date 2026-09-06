/**
 * StorageManager — unified interface for persisting data across backends.
 *
 * Delegates to the appropriate backend:
 *   db  → ResultRepository (PostgreSQL)
 *   csv → CsvExporter
 *   json→ JsonExporter
 *
 * This class is designed to be injected into scrapers that need fine-grained
 * storage control outside of the standard Exporter facade.
 */

import Exporter from '../../exports/Exporter.js';

export class StorageManager {
  constructor(options = {}) {
    this._exporter = new Exporter(options);
  }

  async save(data, opts = {}) {
    return this._exporter.export(data, opts);
  }

  async saveCsv(data, filename) {
    return this._exporter.export(data, { format: 'csv', filename });
  }

  async saveJson(data, filename) {
    return this._exporter.export(data, { format: 'json', filename });
  }

  async saveToDb(data, { jobId, scraper }) {
    return this._exporter.export(data, { format: 'db', jobId, scraper });
  }
}

export default StorageManager;
