/**
 * Re-open falsely completed regions so the fleet scrapes them again.
 * Keeps scraped URLs + CSV rows (append-only). Only clears completedRegions
 * (and optionally completedCities) in each instance progress file.
 *
 * Contabo recovery (recommended once after upgrade):
 *   node scripts/reopen-regions.js --all
 *   node run-cci-fleet.js
 *
 * Other:
 *   node scripts/reopen-regions.js --instance s1
 *   node scripts/reopen-regions.js --regions "AUVERGNE-RHONE-ALPES,CORSE"
 *
 * Note: the scraper also auto-heals completedRegions that lack exhausted proof
 * on every start — this script is for a full manual reopen.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outputRoot = path.join(root, 'output');
const fleetPath = path.join(root, 'src', 'config', 'cci-fleet.json');

function parseArgs(argv) {
  const out = { all: false, instance: null, regions: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') out.all = true;
    if (argv[i] === '--instance' && argv[i + 1]) out.instance = argv[++i];
    if (argv[i] === '--regions' && argv[i + 1]) {
      out.regions = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return out;
}

function norm(s) {
  return String(s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fleet = JSON.parse(await fs.readFile(fleetPath, 'utf8'));
  const instances = (fleet.instances || [])
    .map((i) => i.id)
    .filter((id) => !args.instance || id === args.instance);

  for (const id of instances) {
    const file = path.join(outputRoot, id, 'cci-progress.json');
    let progress;
    try {
      progress = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      console.log(`[${id}] no progress file — skip`);
      continue;
    }

    const before = [...(progress.completedRegions || [])];
    if (args.all || !args.regions) {
      progress.completedRegions = [];
      // Also clear city completion for city-search instances so they re-walk cities
      if (id.startsWith('city-')) {
        progress.completedCities = {};
      }
      // Clear exhausted flags so auto-heal won't keep them "done"
      if (progress.regionStats && typeof progress.regionStats === 'object') {
        for (const key of Object.keys(progress.regionStats)) {
          progress.regionStats[key] = {
            ...progress.regionStats[key],
            exhausted: false,
          };
        }
      }
    } else {
      const remove = new Set(args.regions.map(norm));
      progress.completedRegions = before.filter((r) => !remove.has(norm(r)));
      if (progress.regionStats) {
        for (const key of Object.keys(progress.regionStats)) {
          if ([...remove].some((r) => key.includes(r) || r.includes(key))) {
            progress.regionStats[key] = {
              ...progress.regionStats[key],
              exhausted: false,
            };
          }
        }
      }
    }

    // Keep resume pointer so it can continue; clear "done" flags only
    progress.updatedAt = new Date().toISOString();
    await fs.writeFile(file, JSON.stringify(progress, null, 2), 'utf8');
    console.log(`[${id}] reopened regions: ${before.join(', ') || '(none)'} → ${progress.completedRegions.join(', ') || '(none)'}`);
  }

  console.log('Done. Restart fleet: node run-cci-fleet.js');
  console.log('CSV is untouched — already scraped URLs will be skipped.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
