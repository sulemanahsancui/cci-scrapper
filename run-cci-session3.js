/**
 * Session 3 — processes: MAYOTTE, NORMANDIE, PROVENCE-ALPES-COTE D'AZUR
 * GUADELOUPE and GUYANE are already complete (in progress file).
 *
 * Separate browser profile and progress file.
 * Appends records directly to the shared ./output/cci-agents.csv — no merge needed.
 */
import { CciFrScraper } from './src/scrapers/CciFrScraper.js';

const scraper = new CciFrScraper({
  onlyRegions: [
    'MAYOTTE',
    'NORMANDIE',
    "PROVENCE-ALPES-COTE D'AZUR",
  ],
  progressFile: './output/cci-progress-s3.json',
  // outputCsv intentionally omitted → uses default ./output/cci-agents.csv (appends to existing data)
  userDataDir:  './browser-data/cci-session-3',
});

await scraper.run();
