/**
 * CciFrScraper — scraper for https://www.cci.fr/agent-immobilier
 *
 * Features:
 *   - Playwright stealth + persistent browser context
 *   - Cloudflare Turnstile bypass via 2captcha (initial + mid-scrape)
 *   - CSV output with proper columns, written record-by-record
 *   - Progress tracker → resume after crash / CF re-challenge, zero duplicates
 */

import path from 'path';
import fs   from 'fs/promises';
import { stringify } from 'csv-stringify/sync';
import { BaseScraper }       from './base/BaseScraper.js';
import BrowserManager        from '../core/browser/BrowserManager.js';
import { parseAgentRecord }  from './parsers/CciParser.js';
import { retry }             from '../utils/retry.js';
import { withFileLock }      from '../fleet/csvLock.js';
import logger                from '../logger/index.js';

const BASE_URL              = 'https://www.cci.fr/agent-immobilier';
const DEFAULT_USER_DATA_DIR = path.resolve('./browser-data/cci-session');
const DEFAULT_OUTPUT_CSV    = path.resolve('./output/cci-agents.csv');
const DEFAULT_PROGRESS_FILE = path.resolve('./output/cci-progress.json');

const CSV_COLUMNS = [
  'region',
  'url',
  'document_type',
  'document_number',
  'card_number',
  'valid_until',
  'issued_by',
  'president',
  'activities',
  'establishment_name',
  'establishment_brand',
  'establishment_street_address',
  'establishment_postal_code',
  'establishment_city',
  'company_name',
  'legal_form',
  'trade_name',
  'street_address',
  'postal_code',
  'city',
  'siren',
  'legal_representative',
  'holder_lastname',
  'holder_firstname',
  'holder_usage_name',
  'holder_quality',
  'holder_powers',
  'financial_guarantee_status',
  'financial_guarantee_amount',
  'financial_guarantee_provider',
  'financial_guarantee_street_address',
  'financial_guarantee_postal_code',
  'financial_guarantee_city',
  'insurance_provider',
  'insurance_street_address',
  'insurance_postal_code',
  'insurance_city',
];

// French label → field name mapping

export class CciFrScraper extends BaseScraper {
  constructor(options = {}) {
    super({
      name: 'CciFrScraper',
      engine: 'playwright',
      ...options,

      browserManager: new BrowserManager({
        engine:      'playwright',
        type:        'chromium',
        headless:    options.headless ?? (process.env.CCI_HEADLESS !== 'false'),
        stealth:     true,
        userDataDir: options.userDataDir ?? DEFAULT_USER_DATA_DIR,
        slowMo:      options.slowMo ?? 50,
      }),
    });

    this._outputCsv    = path.resolve(options.outputCsv    ?? DEFAULT_OUTPUT_CSV);
    this._progressFile = path.resolve(options.progressFile ?? DEFAULT_PROGRESS_FILE);
    // If set, only process regions whose label matches one of these strings (case-insensitive partial match)
    this._onlyRegions  = options.onlyRegions ?? null;
    this._instanceId   = options.instanceId ?? null;

    this._scrapedUrls      = new Set();
    this._completedRegions = new Set();
    this._currentRegion    = null;
    this._currentPage      = 1;
    this._currentPageUrl   = null;
    this._pageCheckpoints  = {};   // { regionLabel: pageNumber } — pre-set start pages
    this._count            = 0;
    // All URLs already in the shared CSV (this instance + others) — skip only, not flushed
    this._knownUrls        = new Set();
  }

  // ── Browser init ─────────────────────────────────────────────────────────────

  async _initBrowser() {
    const { page, context, sessionId } = await this.browserManager.launch();
    this.page       = page;
    this.context    = context;
    this._sessionId = sessionId;
    logger.info('Browser initialised', { stealth: true, persistent: true });
  }

  // ── Main entry ───────────────────────────────────────────────────────────────

  async scrape() {
    await this._initOutput();

    logger.info('Navigating to cci.fr', { url: BASE_URL });

    await this.cloudflareHandler.prepareForTurnstile(this.page);
    await this.page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const wasChallenged = await this.cloudflareHandler.bypass(this.page);
    logger.info(wasChallenged ? 'Cloudflare bypassed' : 'No Cloudflare challenge');

    await this._waitForPage();
    await this._scrapeAllRegions();

    logger.info(`Done — ${this._count} records saved`, { file: this._outputCsv });
  }

  // ── Region loop ──────────────────────────────────────────────────────────────

  async _scrapeAllRegions() {
    const regionValues = await this.page.$$eval(
      'select[name="code_region"] option',
      (opts) => opts
        .map((o) => ({ value: o.value, label: o.textContent.trim() }))
        .filter((o) => o.value !== ''),
    );

    logger.info(`Found ${regionValues.length} regions`);

    for (const region of regionValues) {
      if (this._completedRegions.has(region.label)) {
        logger.info('Skipping already-completed region', { label: region.label });
        continue;
      }

      if (this._onlyRegions) {
        const label = region.label.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const match = this._onlyRegions.some(
          (r) => label.includes(r.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')),
        );
        if (!match) {
          logger.info('Skipping region (not in onlyRegions list)', { label: region.label });
          continue;
        }
      }

      // Resume from the exact page: currentRegion has priority (live checkpoint),
      // then pageCheckpoints (manually pre-set), then default to page 1.
      const isResumingRegion = this._currentRegion === region.label && this._currentPage > 1;
      const startPage = isResumingRegion
        ? this._currentPage
        : (this._pageCheckpoints[region.label] ?? 1);
      const startPageUrl = isResumingRegion ? this._currentPageUrl : null;

      // Once we consume a pre-set checkpoint, remove it so it doesn't re-apply on the next run
      if (this._pageCheckpoints[region.label]) {
        delete this._pageCheckpoints[region.label];
        await this._flushProgress();
      }

      logger.info('Processing region', { value: region.value, label: region.label, startPage });

      if (startPageUrl) {
        // Jump directly to the saved results page — avoids re-navigating from page 1
        logger.info(`Resuming from saved page URL`, { region: region.label, page: startPage, url: startPageUrl });
        await this.page.goto(startPageUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await this.cloudflareHandler.bypass(this.page);
        await this._waitForPage();
      } else {
        // Fresh start for this region (or no saved URL — click through from page 1)
        await this.page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await this.cloudflareHandler.bypass(this.page);
        await this._waitForPage();

        await this.page.selectOption('select[name="code_region"]', region.value);
        await this.pause(1500, 2500);

        await this.page.click('#edit-submit');
        await this._waitForPage();

        // If we need to skip ahead (startPageUrl was not saved), click through pages
        for (let p = 1; p < startPage; p++) {
          const advanced = await this._goToNextPage();
          if (!advanced) {
            logger.warn(`Could not reach page ${startPage} — starting from page ${p + 1}`, { region: region.label });
            break;
          }
          await this._waitForPage();
        }
      }

      const { listingsSeen } = await this._scrapeAllPages(region.label, startPage);

      // Never mark complete when this pass saw zero listing links (avoids false-complete)
      if (listingsSeen === 0) {
        logger.warn('Region NOT marked complete — zero listings seen this pass', {
          label: region.label,
          totalSaved: this._count,
        });
        continue;
      }

      await this._saveRegionComplete(region.label);
      logger.info('Region complete', { label: region.label, listingsSeen, totalSaved: this._count });
    }
  }

  // ── Pagination loop ───────────────────────────────────────────────────────────

  async _scrapeAllPages(regionLabel, startPage = 1) {
    let pageNum = startPage;
    let listingsSeen = 0;

    while (true) {
      logger.info(`Scraping page ${pageNum}`, { region: regionLabel });

      // Persist exact position before scraping so a crash mid-page resumes here
      this._currentRegion  = regionLabel;
      this._currentPageUrl = this.page.url();
      this._currentPage    = this._pageFromUrl(this._currentPageUrl) ?? pageNum;
      pageNum = this._currentPage;
      await this._flushProgress();

      const pageListings = await this._scrapeResultsPage(regionLabel, pageNum);
      listingsSeen += pageListings;

      const advanced = await this._goToNextPage();
      if (!advanced) {
        logger.info('No more pages', { region: regionLabel, pages: pageNum });
        break;
      }

      pageNum++;
      await this._waitForPage();

      const hasResults = await this.page.$('tr.lien-fiche').catch(() => null);
      if (!hasResults) {
        logger.info('Next page has no results — end of region', { region: regionLabel, pages: pageNum });
        break;
      }
    }

    return { listingsSeen };
  }

  _pageFromUrl(url) {
    try {
      const page = new URL(url).searchParams.get('page');
      if (page == null || page === '') return null;
      const n = parseInt(page, 10);
      // Drupal pager is 0-based; store 1-based for logs/resume display
      return Number.isFinite(n) ? n + 1 : null;
    } catch {
      return null;
    }
  }

  // ── Results page ─────────────────────────────────────────────────────────────

  async _scrapeResultsPage(regionLabel, pageNum) {
    const resultsUrl = this.page.url();

    const hrefs = await this.page.$$eval(
      'tr.lien-fiche td a[href]',
      (anchors) => anchors.map((a) => a.href),
    ).catch(() => []);

    logger.info(`Found ${hrefs.length} listings on page ${pageNum}`, { region: regionLabel });

    for (let i = 0; i < hrefs.length; i++) {
      const href = hrefs[i];

      if (this._scrapedUrls.has(href) || this._knownUrls.has(href)) {
        logger.debug(`Skipping already-scraped listing`, { href });
        continue;
      }

      logger.debug(`Opening listing ${i + 1}/${hrefs.length}`, { href });

      try {
        await retry(async () => {
          await this.page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await this._waitForPage();

          // Handle Cloudflare re-challenge on detail pages
          const cfHit = await this.cloudflareHandler.bypass(this.page);
          if (cfHit) {
            logger.info('Cloudflare re-challenge bypassed — re-navigating', { href });
            await this.page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
            await this._waitForPage();
          }
        }, {
          attempts:     3,
          baseDelay:    5_000,
          shouldRetry:  (err) =>
            err.code === 'CLOUDFLARE_ERROR' ||
            /timeout|net::|Navigation|Target closed/i.test(err.message || ''),
          onRetry:      (err, attempt) => logger.warn(`Listing retry ${attempt}/2`, { href, error: err.message }),
        });
      } catch (err) {
        if (
          err.code === 'CLOUDFLARE_ERROR' ||
          /timeout|net::|Navigation|Target closed/i.test(err.message || '')
        ) {
          logger.warn('Listing failed after retries — skipping, will retry on next run', { href });
          continue; // progress not saved → URL will be retried on next run
        }
        throw err;
      }

      const data   = await this._extractDetailPage();
      const record = { region: regionLabel, url: href, ...data };

      if (!this._isValidRecord(data)) {
        logger.warn('Hollow record — not saving progress (will retry)', {
          href,
          document_type: data.document_type,
        });
        // Return to results list without marking URL done
        await this.page.goto(resultsUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await this._waitForPage();
        await this.page.waitForSelector('tr.lien-fiche', { timeout: 20_000 }).catch(() => {});
        continue;
      }

      // Skip if already scraped (own progress or shared CSV) — never duplicate insert
      if (this._scrapedUrls.has(href) || this._knownUrls.has(href)) {
        logger.debug('Already scraped — skip write', { href });
      } else {
        await this._writeRecord(record);
        await this._saveProgress(href);
        logger.info(`Saved record ${this._count}`, { company: data.company_name, index: i + 1 });
      }

      // Prefer goto results URL over back-button (more reliable on resume)
      await this.page.goto(resultsUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await this._waitForPage();
      await this.page.waitForSelector('tr.lien-fiche', { timeout: 20_000 }).catch(() => {});
      await this.pause(1000, 2000);
    }

    return hrefs.length;
  }

  _isValidRecord(data) {
    return Boolean(
      data?.document_type &&
      (data.document_number || data.card_number || data.company_name || data.holder_lastname),
    );
  }

  // ── Next page navigation ──────────────────────────────────────────────────────

  async _goToNextPage() {
    try {
      const next = await this.page.$(
        'li.pager__item--next a, .pager-next a, a[rel="next"], a[title*="suivant" i], a[title*="next" i]',
      );
      if (!next) return false;
      await next.click();
      return true;
    } catch {
      return false;
    }
  }

  // ── Detail page extraction + parsing ─────────────────────────────────────────

  async _extractDetailPage() {
    try {
      await this.page.waitForSelector('.agent-immobilier__document--body.mt-5', { timeout: 10_000 });
    } catch {
      logger.warn('Detail body not found', { url: this.page.url() });
      return parseAgentRecord(null);
    }

    const raw = await this.page.$eval(
      '.agent-immobilier__document--body.mt-5',
      (el) => el.innerText.trim(),
    );

    return parseAgentRecord(raw);
  }

  // ── CSV + progress I/O ────────────────────────────────────────────────────────

  async _initOutput() {
    await fs.mkdir(path.dirname(this._outputCsv), { recursive: true });

    this._scrapedUrls      = new Set();
    this._knownUrls        = new Set();
    this._completedRegions = new Set();
    this._currentRegion    = null;
    this._currentPage      = 1;
    this._currentPageUrl   = null;
    this._pageCheckpoints  = {};
    this._count            = 0;

    // 1) Load this instance's progress (resume position + own URL set)
    try {
      const raw      = await fs.readFile(this._progressFile, 'utf8');
      const progress = JSON.parse(raw);
      this._scrapedUrls      = new Set(progress.urls ?? (Array.isArray(progress) ? progress : []));
      this._completedRegions = new Set(progress.completedRegions ?? []);
      this._currentRegion    = progress.currentRegion   ?? null;
      this._currentPage      = progress.currentPage     ?? 1;
      this._currentPageUrl   = progress.currentPageUrl  ?? null;
      this._pageCheckpoints  = progress.pageCheckpoints ?? {};
      for (const u of this._scrapedUrls) this._knownUrls.add(u);
      logger.info(`Resuming — ${this._scrapedUrls.size} URLs in progress file`, {
        currentRegion:    this._currentRegion,
        currentPage:      this._currentPage,
        completedRegions: this._completedRegions.size,
      });
    } catch {
      logger.info('No progress file yet — starting fresh progress tracker');
    }

    // 2) Shared CSV is append-only. Create header only if missing.
    //    Scan existing URLs so other instances' rows are not re-inserted.
    const csvExists = await fs.access(this._outputCsv).then(() => true).catch(() => false);
    if (!csvExists) {
      await fs.writeFile(this._outputCsv, CSV_COLUMNS.join(',') + '\n', { flag: 'wx' }).catch(async (err) => {
        if (err.code !== 'EEXIST') throw err;
        logger.warn('CSV appeared concurrently — will append only', { file: this._outputCsv });
      });
      logger.info('Created shared CSV with header (append-only)', { file: this._outputCsv });
    } else {
      const fromCsv = await this._urlsFromExistingCsv();
      for (const u of fromCsv) this._knownUrls.add(u);
      logger.info('Shared CSV exists — append only (never overwrite)', {
        file: this._outputCsv,
        urlsInCsv: fromCsv.size,
        knownUrls: this._knownUrls.size,
      });
    }

    this._count = this._scrapedUrls.size;
  }

  /** Read url column from existing CSV so restarts never re-insert known rows. */
  async _urlsFromExistingCsv() {
    const urls = new Set();
    try {
      const text = await fs.readFile(this._outputCsv, 'utf8');
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) return urls;

      const header = lines[0].split(',');
      const urlIdx = header.indexOf('url');
      if (urlIdx < 0) return urls;

      // Lightweight parse: handle quoted fields for the url column
      for (let i = 1; i < lines.length; i++) {
        const cols = this._parseCsvLine(lines[i]);
        const u = cols[urlIdx];
        if (u) urls.add(u);
      }
    } catch (err) {
      logger.warn('Could not scan existing CSV for URLs', { error: err.message });
    }
    return urls;
  }

  _parseCsvLine(line) {
    const out = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"') {
          if (line[i + 1] === '"') { field += '"'; i++; }
          else quoted = false;
        } else field += c;
      } else if (c === '"') {
        quoted = true;
      } else if (c === ',') {
        out.push(field);
        field = '';
      } else {
        field += c;
      }
    }
    out.push(field);
    return out;
  }

  async _writeRecord(record) {
    // Append only into the shared CSV, with a cross-process lock (5 fleet instances)
    const line = stringify([record], { header: false, columns: CSV_COLUMNS });
    const lockPath = `${this._outputCsv}.lock`;
    await withFileLock(lockPath, async () => {
      await fs.appendFile(this._outputCsv, line, 'utf8');
    });
  }

  async _saveProgress(href) {
    this._scrapedUrls.add(href);
    this._knownUrls.add(href);
    await this._flushProgress();
    this._count = this._scrapedUrls.size;
  }

  async _saveRegionComplete(regionLabel) {
    this._completedRegions.add(regionLabel);
    // Clear page checkpoint — this region is done
    this._currentRegion  = null;
    this._currentPage    = 1;
    this._currentPageUrl = null;
    await this._flushProgress();
  }

  async _flushProgress() {
    // Atomic-ish replace: write temp then rename (Windows: copy+unlink if rename fails)
    const payload = JSON.stringify({
      instanceId:       this._instanceId,
      urls:             [...this._scrapedUrls],
      completedRegions: [...this._completedRegions],
      currentRegion:    this._currentRegion,
      currentPage:      this._currentPage,
      currentPageUrl:   this._currentPageUrl,
      pageCheckpoints:  this._pageCheckpoints,
      updatedAt:        new Date().toISOString(),
      recordCount:      this._scrapedUrls.size,
    }, null, 2);

    const tmp = `${this._progressFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, payload, 'utf8');
    try {
      await fs.rename(tmp, this._progressFile);
    } catch {
      await fs.copyFile(tmp, this._progressFile);
      await fs.unlink(tmp).catch(() => {});
    }
  }

  // ── Wait helper ───────────────────────────────────────────────────────────────

  async _waitForPage() {
    await this.page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});
    await this.pause(1500, 3000);
  }
}

export default CciFrScraper;
