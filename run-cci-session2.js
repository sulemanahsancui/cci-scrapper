/**
 * Session 2 — re-scrapes ILE-DE-FRANCE (was falsely marked complete, 0 records saved),
 * then processes OCCITANIE and PAYS DE LA LOIRE (never assigned to any session).
 *
 * Separate browser profile and progress file.
 * Appends records directly to the shared ./output/cci-agents.csv — no merge needed.
 */
import { CciFrScraper } from './src/scrapers/CciFrScraper.js';

const scraper = new CciFrScraper({
  onlyRegions: [
    'ILE-DE-FRANCE',
    'OCCITANIE',
    'PAYS DE LA LOIRE',
  ],
  progressFile: './output/cci-progress-s2.json',
  // outputCsv intentionally omitted → uses default ./output/cci-agents.csv (appends to existing data)
  userDataDir:  './browser-data/cci-session-2',
});

await scraper.run();
