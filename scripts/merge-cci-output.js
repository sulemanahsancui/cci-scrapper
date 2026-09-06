/**
 * Merge per-instance CCI agent CSV files into output/cci-agents-merged.csv
 *
 *   node scripts/merge-cci-output.js
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { mergeCsvFiles, listInstanceCsvPaths } from '../src/fleet/mergeCsv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outputRoot = path.join(root, 'output');
const fleetConfigPath = path.join(root, 'src', 'config', 'cci-fleet.json');

async function main() {
  const fleet = JSON.parse(await fs.readFile(fleetConfigPath, 'utf8'));
  const ids = (fleet.instances || []).map((i) => i.id);
  const paths = await listInstanceCsvPaths(outputRoot, ids);
  const merged = await mergeCsvFiles(paths);
  const out = path.join(outputRoot, 'cci-agents-merged.csv');
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(out, merged.body || '', 'utf8');
  console.log(`Wrote ${out} (${merged.recordCount} records)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
