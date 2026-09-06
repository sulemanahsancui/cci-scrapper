import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import logger from '../logger/index.js';

export class JsonExporter {
  constructor(options = {}) {
    this.outputDir = options.outputDir ?? './exports/output';
    this.pretty    = options.pretty    ?? true;
  }

  async export(data, options = {}) {
    if (!data?.length) return null;

    const filename = `${options.filename ?? 'export'}-${Date.now()}.json`;
    const filepath = path.join(this.outputDir, filename);

    await mkdir(this.outputDir, { recursive: true });
    await writeFile(filepath, JSON.stringify(data, null, this.pretty ? 2 : 0), 'utf8');

    logger.info('JSON export written', { filepath, rows: data.length });
    return filepath;
  }
}
