/**
 * Single fleet instance — wraps existing CciFrScraper with per-instance paths.
 *
 * Usage:
 *   node run-cci-instance.js --id s1
 *   CCI_INSTANCE=s1 node run-cci-instance.js
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { CciFrScraper } from './src/scrapers/CciFrScraper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLEET_CONFIG = path.join(__dirname, 'src', 'config', 'cci-fleet.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--id' && argv[i + 1]) {
      out.id = argv[++i];
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const id = args.id || process.env.CCI_INSTANCE;
  if (!id) {
    console.error('Missing instance id. Use --id s1 or CCI_INSTANCE=s1');
    process.exit(1);
  }

  const fleet = JSON.parse(await fs.readFile(FLEET_CONFIG, 'utf8'));
  const instance = (fleet.instances || []).find((i) => i.id === id);
  if (!instance) {
    console.error(`Unknown instance id "${id}". Check src/config/cci-fleet.json`);
    process.exit(1);
  }

  const outputDir = path.resolve(__dirname, 'output', id);
  await fs.mkdir(outputDir, { recursive: true });

  const scraper = new CciFrScraper({
    instanceId:   id,
    onlyRegions:  instance.onlyRegions,
    cityShard:    instance.cityShard ?? null,
    pageRange:    instance.pageRange ?? null,
    progressFile: path.join(outputDir, 'cci-progress.json'),
    // One shared CSV for all instances (same as before)
    outputCsv:    path.resolve(__dirname, 'output', 'cci-agents.csv'),
    userDataDir:  path.resolve(__dirname, 'browser-data', `cci-session-${id}`),
    headless:     process.env.CCI_HEADLESS === 'true',
  });

  const shardInfo = instance.cityShard
    ? ` cityShard ${Number(instance.cityShard.index) + 1}/${instance.cityShard.of}`
    : '';
  const until = instance.cityShard?.untilCity ? ` until=${instance.cityShard.untilCity}` : '';
  const after = instance.cityShard?.afterCity ? ` after=${instance.cityShard.afterCity}` : '';
  const pages = (() => {
    if (!instance.pageRange) return '';
    if (instance.pageRange.start != null || instance.pageRange.end != null) {
      return ` pages ${instance.pageRange.start ?? '?'}-${instance.pageRange.end ?? '?'}`;
    }
    const first = Object.values(instance.pageRange)[0];
    if (first && typeof first === 'object') {
      return ` pages ${first.start ?? '?'}-${first.end ?? '?'}`;
    }
    return '';
  })();
  console.log(`[${id}] starting — regions: ${instance.onlyRegions.join(', ')}${shardInfo}${until}${after}${pages}`);
  try {
    await scraper.run();
    console.log(`[${id}] finished`);
  } catch (err) {
    if (err?.code === 'INCOMPLETE_REGIONS') {
      console.error(`[${id}] incomplete — ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
