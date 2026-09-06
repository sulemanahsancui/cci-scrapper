/**
 * Reset CCI fleet output for a fresh full scrape.
 * Does NOT delete browser-data unless --browser is passed.
 *
 *   node scripts/reset-cci-run.js
 *   node scripts/reset-cci-run.js --browser
 *   node scripts/reset-cci-run.js --yes   (skip confirm on CI)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outputRoot = path.join(root, 'output');
const browserRoot = path.join(root, 'browser-data');

const args = new Set(process.argv.slice(2));
const wipeBrowser = args.has('--browser');
const autoYes = args.has('--yes');

async function rmrf(target) {
  await fs.rm(target, { recursive: true, force: true });
}

async function confirm() {
  if (autoYes) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question('Delete fleet output (and start from 0)? [y/N] ', resolve);
  });
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  const ok = await confirm();
  if (!ok) {
    console.log('Aborted.');
    process.exit(0);
  }

  // New fleet dirs
  for (const id of ['s1', 's2', 's3', 's4', 's5']) {
    await rmrf(path.join(outputRoot, id));
  }

  // Legacy / shared files
  for (const name of [
    'cci-agents.csv',
    'cci-agents.csv.lock',
    'cci-progress.json',
    'cci-progress-s2.json',
    'cci-progress-s3.json',
    'fleet-status.json',
    'cci-agents-merged.csv',
  ]) {
    await fs.rm(path.join(outputRoot, name), { force: true });
  }

  if (wipeBrowser) {
    for (const id of ['s1', 's2', 's3', 's4', 's5']) {
      await rmrf(path.join(browserRoot, `cci-session-${id}`));
    }
    await rmrf(path.join(browserRoot, 'cci-session'));
    console.log('Browser profiles deleted.');
  }

  await fs.mkdir(outputRoot, { recursive: true });
  console.log('Fleet output cleared. Ready for a fresh run: node run-cci-fleet.js');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
