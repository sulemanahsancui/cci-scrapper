import { stringify } from 'csv-stringify/sync';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import logger from '../logger/index.js';

export class CsvExporter {
  constructor(options = {}) {
    this.outputDir = options.outputDir ?? './exports/output';
  }

  async export(data, options = {}) {
    if (!data?.length) return null;

    const filename = `${options.filename ?? 'export'}-${Date.now()}.csv`;
    const filepath = path.join(this.outputDir, filename);

    await mkdir(this.outputDir, { recursive: true });

    const csv = stringify(data, {
      header: true,
      columns: options.columns ?? Object.keys(data[0]),
    });

    await writeFile(filepath, csv, 'utf8');
    logger.info('CSV export written', { filepath, rows: data.length });
    return filepath;
  }
}
