/**
 * Session 1 — resumes GRAND EST (in progress), then: HAUTS-DE-FRANCE.
 * GUADELOUPE and GUYANE moved to Session 3.
 *
 * Uses the existing progress file and CSV so the resume is seamless.
 */
import { CciFrScraper } from './src/scrapers/CciFrScraper.js';

const scraper = new CciFrScraper({
  onlyRegions: [
    'CORSE',
    'GRAND EST',
    'HAUTS-DE-FRANCE',
  ],
  // uses default paths: ./output/cci-progress.json + ./output/cci-agents.csv
  // uses default browser dir: ./browser-data/cci-session
});

await scraper.run();
