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
import {
  isCitySearchRegion,
  citiesForRegion,
  citySearchUrl,
  cityToQuery,
  normalizeRegionKey,
} from '../fleet/cityLists.js';
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
        headless:    options.headless ?? (process.env.CCI_HEADLESS === 'true'),
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
    // City-by-city mode (IDF / Occitanie): { 'ILE-DE-FRANCE': ['paris', ...], ... }
    this._completedCities  = {};
    this._currentCity      = null;
    // Proof of completion per region — used to auto-heal false "done" flags
    this._regionStats      = {};
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

    const unfinished = this._unfinishedAssignedRegions();
    if (unfinished.length) {
      const msg = `Instance incomplete — regions still open: ${unfinished.join(', ')}`;
      logger.error(msg, { unfinished });
      // Non-zero so fleet shows "failed" (not false "done") and client can Resume
      const err = new Error(msg);
      err.code = 'INCOMPLETE_REGIONS';
      throw err;
    }

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

    logger.info(`Found ${regionValues.length} regions on site`);

    // Process in fleet onlyRegions order (not dropdown order), so city-search
    // regions finish completely before anything else on that instance.
    const ordered = this._orderRegions(regionValues);

    for (const region of ordered) {
      if (this._isRegionMarkedComplete(region.label)) {
        logger.info('Skipping already-completed region (verified)', { label: region.label });
        continue;
      }

      // OCCITANIE + ILE-DE-FRANCE: dropdown fails — scrape every city, then region done
      if (isCitySearchRegion(region.label)) {
        logger.info('Starting city-by-city region (will finish all cities before next region)', {
          label: region.label,
        });
        await this._scrapeRegionByCities(region.label);
        continue;
      }

      // Resume from the exact page: currentRegion has priority (live checkpoint),
      // then pageCheckpoints (manually pre-set), then default to page 1.
      const sameRegion =
        normalizeRegionKey(this._currentRegion) === normalizeRegionKey(region.label);
      const isResumingRegion = sameRegion && this._currentPage > 1 && this._currentPageUrl;
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

      const { listingsSeen, exhausted, expectedTotal } = await this._scrapeAllPages(region.label, startPage);

      // Never mark complete when this pass saw zero listing links (avoids false-complete)
      if (listingsSeen === 0) {
        this._rememberRegionStats(region.label, { exhausted: false, listingsSeen, expectedTotal });
        await this._flushProgress();
        logger.warn('Region NOT marked complete — zero listings seen this pass', {
          label: region.label,
          totalSaved: this._count,
        });
        continue;
      }

      // Full last page but pager failed → region is NOT done (do not mark complete)
      if (!exhausted) {
        this._rememberRegionStats(region.label, { exhausted: false, listingsSeen, expectedTotal });
        await this._flushProgress();
        logger.warn('Region NOT marked complete — pagination stopped early (will resume later)', {
          label: region.label,
          listingsSeen,
          expectedTotal,
          totalSaved: this._count,
        });
        // Stop instance loop so we resume THIS region next time (don't skip ahead)
        return;
      }

      // Only compare to site total on a fresh pass from page 1 (resume passes see a partial count)
      if (startPage <= 1 && !this._countsLookComplete(listingsSeen, expectedTotal)) {
        this._rememberRegionStats(region.label, { exhausted: false, listingsSeen, expectedTotal });
        await this._flushProgress();
        logger.warn('Region NOT marked complete — listings far below site total', {
          label: region.label,
          listingsSeen,
          expectedTotal,
        });
        return;
      }

      const provenSeen =
        startPage > 1 && expectedTotal != null
          ? expectedTotal
          : listingsSeen;

      await this._saveRegionComplete(region.label, {
        exhausted: true,
        listingsSeen: provenSeen,
        expectedTotal,
      });
      logger.info('Region complete', {
        label: region.label,
        listingsSeen: provenSeen,
        expectedTotal,
        totalSaved: this._count,
      });
    }
  }

  /** Match site dropdown options to onlyRegions, preserving fleet config order. */
  _orderRegions(regionValues) {
    const norm = (s) =>
      String(s || '')
        .toUpperCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!this._onlyRegions?.length) return regionValues;

    const ordered = [];
    const used = new Set();

    for (const wanted of this._onlyRegions) {
      const w = norm(wanted);
      const match = regionValues.find((r) => {
        if (used.has(r.label)) return false;
        const label = norm(r.label);
        return label.includes(w) || w.includes(label);
      });
      if (match) {
        used.add(match.label);
        ordered.push(match);
      } else if (isCitySearchRegion(wanted)) {
        // City-search region may still run even if label matching is awkward
        ordered.push({ value: '', label: wanted });
      } else {
        logger.warn('Region in onlyRegions not found on site dropdown', { wanted });
      }
    }

    logger.info('Region order for this instance', {
      order: ordered.map((r) => r.label),
    });
    return ordered;
  }

  /**
   * City-by-city scrape for regions where the dropdown returns nothing
   * (ILE-DE-FRANCE, OCCITANIE). Same pagination + detail flow; only the
   * entry URL changes: https://www.cci.fr/agent-immobilier?city=montpellier
   *
   * All cities are scraped one-by-one; region is marked complete only after
   * the full city list is done — then the instance moves to the next region.
   */
  async _scrapeRegionByCities(regionLabel) {
    const regionKey = normalizeRegionKey(regionLabel);
    const cities = await citiesForRegion(regionLabel);

    if (!cities.length) {
      logger.error('No cities configured for city-search region — add rows to data/cities/city-search.csv', {
        region: regionLabel,
      });
      return;
    }

    if (!this._completedCities[regionKey]) this._completedCities[regionKey] = [];
    const done = new Set(this._completedCities[regionKey]);

    logger.info('City-search region — scraping city by city', {
      region: regionLabel,
      cities: cities.length,
      alreadyDone: done.size,
    });

    let regionListings = 0;

    for (const cityName of cities) {
      const slug = cityToQuery(cityName);
      if (!slug) continue;

      if (done.has(slug)) {
        logger.info('Skipping completed city', { region: regionLabel, city: cityName, slug });
        continue;
      }

      const cityUrl = citySearchUrl(cityName, BASE_URL);
      const sameRegion =
        normalizeRegionKey(this._currentRegion) === normalizeRegionKey(regionLabel);
      const isResumingCity =
        sameRegion &&
        this._currentCity === slug &&
        Boolean(this._currentPageUrl);

      const startPage = isResumingCity ? (this._currentPage || 1) : 1;
      const startPageUrl = isResumingCity ? this._currentPageUrl : null;

      logger.info('Processing city', {
        region: regionLabel,
        city: cityName,
        slug,
        url: cityUrl,
        startPage,
        resume: Boolean(startPageUrl),
      });

      // Persist city checkpoint before any navigation (crash-safe resume)
      this._currentRegion = regionLabel;
      this._currentCity   = slug;
      if (!startPageUrl) {
        this._currentPage    = 1;
        this._currentPageUrl = cityUrl;
      }
      await this._flushProgress();

      if (startPageUrl) {
        logger.info('Resuming city from saved page URL', { city: cityName, url: startPageUrl });
        await this.page.goto(startPageUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await this.cloudflareHandler.bypass(this.page);
        await this._waitForPage();
      } else {
        await this.page.goto(cityUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await this.cloudflareHandler.bypass(this.page);
        await this._waitForPage();

        for (let p = 1; p < startPage; p++) {
          const advanced = await this._goToNextPage();
          if (!advanced) break;
          await this._waitForPage();
        }
      }

      // Reuse normal pagination + detail scrape; CSV region column stays regionLabel
      const { listingsSeen, exhausted, expectedTotal } = await this._scrapeAllPages(regionLabel, startPage);
      regionListings += listingsSeen;

      if (!exhausted && listingsSeen > 0) {
        // Keep city as current checkpoint — do NOT mark city done
        this._rememberRegionStats(regionLabel, {
          exhausted: false,
          listingsSeen: regionListings,
          expectedTotal,
        });
        logger.warn('City NOT marked complete — pagination stopped early (will resume)', {
          region: regionLabel,
          city: cityName,
          listingsSeen,
          expectedTotal,
        });
        await this._flushProgress();
        return; // stop region loop; resume this city next run
      }

      // Empty city is OK (small towns) — still mark city done so we move on
      done.add(slug);
      this._completedCities[regionKey] = [...done];
      this._currentCity    = null;
      this._currentPage    = 1;
      this._currentPageUrl = null;
      await this._flushProgress();

      logger.info('City complete', {
        region: regionLabel,
        city: cityName,
        listingsSeen,
        citiesDone: done.size,
        citiesTotal: cities.length,
      });
    }

    if (done.size >= cities.length) {
      await this._saveRegionComplete(regionLabel, {
        exhausted: true,
        listingsSeen: regionListings,
        expectedTotal: null,
        citiesDone: done.size,
        citiesTotal: cities.length,
      });
      logger.info('City-search region complete', {
        region: regionLabel,
        cities: cities.length,
        listingsSeen: regionListings,
        totalSaved: this._count,
      });
    } else {
      logger.warn('City-search region not fully complete yet', {
        region: regionLabel,
        done: done.size,
        total: cities.length,
      });
    }
  }

  // ── Pagination loop ───────────────────────────────────────────────────────────

  /**
   * Scrape every results page.
   * Returns exhausted=true only when we truly reached the end (empty page or
   * short last page). If the last page was full (~32) but next failed, exhausted=false
   * so the region/city is NOT marked complete.
   * Also reads site "X résultats" when present (expectedTotal).
   */
  async _scrapeAllPages(regionLabel, startPage = 1) {
    let pageNum = startPage;
    let listingsSeen = 0;
    let lastPageCount = 0;
    let expectedTotal = null;
    const PAGE_SIZE = 32;

    while (true) {
      logger.info(`Scraping page ${pageNum}`, { region: regionLabel });

      // Persist exact position before scraping so a crash mid-page resumes here
      this._currentRegion  = regionLabel;
      this._currentPageUrl = this.page.url();
      this._currentPage    = this._pageFromUrl(this._currentPageUrl) ?? pageNum;
      pageNum = this._currentPage;
      // Keep currentCity if set (city-search mode) — do not clear on page advance
      await this._flushProgress();

      const fromSite = await this._readExpectedTotal();
      if (fromSite != null) {
        expectedTotal = fromSite;
        this._rememberRegionStats(regionLabel, {
          exhausted: false,
          listingsSeen,
          expectedTotal,
        });
      }

      lastPageCount = await this._scrapeResultsPage(regionLabel, pageNum);
      listingsSeen += lastPageCount;

      if (lastPageCount === 0) {
        logger.info('Empty results page — end of list', {
          region: regionLabel,
          pages: pageNum,
          expectedTotal,
        });
        return { listingsSeen, exhausted: true, expectedTotal };
      }

      // Prefer URL ?page= N+1 (reliable). Fall back to clicking "next".
      const advanced = await this._goToNextPage();
      if (!advanced) {
        if (lastPageCount >= PAGE_SIZE) {
          logger.warn('Full page of results but could not open next page — NOT exhausted', {
            region: regionLabel,
            page: pageNum,
            lastPageCount,
            expectedTotal,
          });
          return { listingsSeen, exhausted: false, expectedTotal };
        }
        logger.info('Last short page — end of list', {
          region: regionLabel,
          pages: pageNum,
          lastPageCount,
          expectedTotal,
        });
        return { listingsSeen, exhausted: true, expectedTotal };
      }

      pageNum++;
      await this._waitForPage();

      const hasResults = await this.page.$('tr.lien-fiche').catch(() => null);
      if (!hasResults) {
        // Navigated "next" but no rows — real end (or CF). If previous was full, verify once.
        if (lastPageCount >= PAGE_SIZE) {
          // Might be CF / slow load — wait and recheck
          await this._waitForPage();
          const again = await this.page.$('tr.lien-fiche').catch(() => null);
          if (!again) {
            logger.warn('Next page empty after full page — treating as NOT exhausted (retry later)', {
              region: regionLabel,
              page: pageNum,
              expectedTotal,
            });
            return { listingsSeen, exhausted: false, expectedTotal };
          }
        } else {
          logger.info('Next page has no results — end of region', {
            region: regionLabel,
            pages: pageNum,
            expectedTotal,
          });
          return { listingsSeen, exhausted: true, expectedTotal };
        }
      }
    }
  }

  /** Parse "20 946 résultats" (or similar) from the results page. */
  async _readExpectedTotal() {
    try {
      const text = await this.page.evaluate(() => document.body?.innerText || '');
      const m = text.match(/([\d\s\u00a0\.]+)\s*r[ée]sultats?/i);
      if (!m) return null;
      const n = parseInt(String(m[1]).replace(/[\s\u00a0\.]/g, ''), 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
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

  /** Drupal 0-based page index from current URL (default 0). */
  _drupalPageIndex(url = this.page?.url?.() || '') {
    try {
      const page = new URL(url).searchParams.get('page');
      if (page == null || page === '') return 0;
      const n = parseInt(page, 10);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
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

  /**
   * Advance results pager. Prefer rewriting ?page= (Drupal 0-based) — more reliable
   * than clicking after many detail navigations. Falls back to the next link.
   */
  async _goToNextPage() {
    try {
      const currentUrl = this.page.url();
      const nextIdx = this._drupalPageIndex(currentUrl) + 1;
      const nextUrl = new URL(currentUrl);
      // Only use URL strategy when we are clearly on a search-results URL
      if (nextUrl.pathname.includes('agent-immobilier') && (nextUrl.searchParams.has('state_recherche') || nextUrl.searchParams.has('city') || nextUrl.searchParams.has('code_region') || nextUrl.searchParams.has('page'))) {
        nextUrl.searchParams.set('page', String(nextIdx));
        const before = currentUrl;
        await this.page.goto(nextUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await this.cloudflareHandler.bypass(this.page);
        // If goto somehow bounced to same listing-less page, try click fallback
        if (this.page.url() === before) return false;
        return true;
      }
    } catch (err) {
      logger.warn('URL next-page failed, trying click', { error: err.message });
    }

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
    this._completedCities  = {};
    this._regionStats      = {};
    this._currentRegion    = null;
    this._currentCity      = null;
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
      this._completedCities  = progress.completedCities ?? {};
      this._regionStats      = progress.regionStats ?? {};
      this._currentRegion    = progress.currentRegion   ?? null;
      this._currentCity      = progress.currentCity     ?? null;
      this._currentPage      = progress.currentPage     ?? 1;
      this._currentPageUrl   = progress.currentPageUrl  ?? null;
      this._pageCheckpoints  = progress.pageCheckpoints ?? {};
      for (const u of this._scrapedUrls) this._knownUrls.add(u);
      this._pruneProgressToAssignedRegions();
      this._healFalseCompletes();
      logger.info(`Resuming — ${this._scrapedUrls.size} URLs in progress file`, {
        currentRegion:    this._currentRegion,
        currentCity:      this._currentCity,
        currentPage:      this._currentPage,
        completedRegions: [...this._completedRegions],
        regionStats:      this._regionStats,
      });
    } catch {
      logger.info('No progress file yet — starting fresh progress tracker');
    }

    // 2) Shared CSV is append-only. Create header only if missing.
    //    Scan existing URLs so other instances' rows are not re-inserted.
    //    Crash/resume never truncates this file — only appendFile is used.
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
      logger.info('Shared CSV exists — append only, resume will skip known URLs', {
        file: this._outputCsv,
        urlsInCsv: fromCsv.size,
        knownUrls: this._knownUrls.size,
        completedCities: Object.fromEntries(
          Object.entries(this._completedCities).map(([k, v]) => [k, v.length]),
        ),
        currentRegion: this._currentRegion,
        currentCity: this._currentCity,
        currentPage: this._currentPage,
      });
    }

    this._count = this._scrapedUrls.size;
  }

  /**
   * Drop stale completedRegions / currentRegion left over from an older fleet
   * split (e.g. s5 used to include PAYS DE LA LOIRE). Keeps URLs + CSV intact.
   */
  _pruneProgressToAssignedRegions() {
    if (!this._onlyRegions?.length) return;

    const assigned = this._onlyRegions.map((r) => normalizeRegionKey(r));
    const matchesAssigned = (label) => {
      const n = normalizeRegionKey(label);
      return assigned.some((a) => n.includes(a) || a.includes(n));
    };

    const before = [...this._completedRegions];
    this._completedRegions = new Set(before.filter(matchesAssigned));
    const dropped = before.filter((r) => !this._completedRegions.has(r));

    if (this._currentRegion && !matchesAssigned(this._currentRegion)) {
      logger.warn('Clearing stale currentRegion not in this instance assignment', {
        currentRegion: this._currentRegion,
        onlyRegions: this._onlyRegions,
      });
      this._currentRegion  = null;
      this._currentCity    = null;
      this._currentPage    = 1;
      this._currentPageUrl = null;
    }

    // Keep only completedCities keys that belong to assigned city-search regions
    const nextCities = {};
    for (const [key, list] of Object.entries(this._completedCities || {})) {
      if (assigned.some((a) => key.includes(a) || a.includes(key))) {
        nextCities[key] = list;
      }
    }
    this._completedCities = nextCities;

    // Drop regionStats for regions we no longer own
    const nextStats = {};
    for (const [key, stats] of Object.entries(this._regionStats || {})) {
      if (assigned.some((a) => key.includes(a) || a.includes(key))) {
        nextStats[key] = stats;
      }
    }
    this._regionStats = nextStats;

    if (dropped.length) {
      logger.warn('Pruned stale completedRegions from old fleet config', { dropped });
      this._flushProgress().catch(() => {});
    }
  }

  /**
   * Auto-reopen false "done" flags. Old progress files often marked regions
   * complete without proof (exhausted). Client must not see fake done again.
   */
  _healFalseCompletes() {
    const kept = [];
    const reopened = [];

    for (const label of this._completedRegions) {
      if (this._isRegionTrulyComplete(label)) {
        kept.push(label);
      } else {
        reopened.push(label);
      }
    }

    if (!reopened.length) return;

    this._completedRegions = new Set(kept);
    for (const label of reopened) {
      const key = normalizeRegionKey(label);
      if (this._regionStats[key]) {
        this._regionStats[key] = {
          ...this._regionStats[key],
          exhausted: false,
          healedAt: new Date().toISOString(),
        };
      }
      // City-search: clear city checklist so we re-walk (URLs still skipped via CSV)
      if (isCitySearchRegion(label)) {
        this._completedCities[key] = [];
      }
    }

    logger.warn('Auto-reopened false completedRegions (no exhausted proof / count mismatch)', {
      reopened,
      kept,
    });
    this._flushProgress().catch(() => {});
  }

  _rememberRegionStats(label, stats) {
    const key = normalizeRegionKey(label);
    this._regionStats[key] = {
      ...(this._regionStats[key] || {}),
      ...stats,
      updatedAt: new Date().toISOString(),
    };
  }

  _isTinyRegion(label) {
    const k = normalizeRegionKey(label);
    return [
      'MAYOTTE',
      'CORSE',
      'GUADELOUPE',
      'GUYANE',
      'MARTINIQUE',
      'REUNION',
      'COLLECTIVITES',
    ].some((t) => k.includes(t));
  }

  /** Site total vs listings seen this pass (or stored). Allow 15% slack. */
  _countsLookComplete(listingsSeen, expectedTotal) {
    if (expectedTotal == null || expectedTotal <= 0) return true;
    // City mode: expectedTotal is per-city; don't block region complete on one city count
    return listingsSeen >= expectedTotal * 0.85;
  }

  _isRegionTrulyComplete(label) {
    const key = normalizeRegionKey(label);
    const stats = this._regionStats[key];

    // City-search: need exhausted + all cities done (or legacy complete without cities → heal)
    if (isCitySearchRegion(label)) {
      if (!stats?.exhausted) return false;
      const citiesDone = (this._completedCities[key] || []).length;
      // If we have city checklist, require it non-empty as proof of work
      if (citiesDone === 0 && (stats.listingsSeen || 0) === 0) return false;
      return true;
    }

    // Region dropdown: must have explicit exhausted=true proof
    if (!stats?.exhausted) return false;

    if (stats.expectedTotal != null && stats.expectedTotal > 0) {
      if ((stats.listingsSeen || 0) < stats.expectedTotal * 0.85) return false;
    } else if (!this._isTinyRegion(label) && (stats.listingsSeen || 0) < 200) {
      // Large mainland region with almost no listings + no site total → untrustworthy
      return false;
    }

    return true;
  }

  _isRegionMarkedComplete(label) {
    const n = normalizeRegionKey(label);
    const inSet = [...this._completedRegions].some((r) => {
      const a = normalizeRegionKey(r);
      return a === n || a.includes(n) || n.includes(a);
    });
    if (!inSet) return false;
    return this._isRegionTrulyComplete(label);
  }

  _unfinishedAssignedRegions() {
    if (!this._onlyRegions?.length) return [];
    return this._onlyRegions.filter((wanted) => !this._isRegionMarkedComplete(wanted));
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

  async _saveRegionComplete(regionLabel, stats = {}) {
    this._rememberRegionStats(regionLabel, {
      exhausted: true,
      listingsSeen: stats.listingsSeen ?? this._regionStats[normalizeRegionKey(regionLabel)]?.listingsSeen ?? 0,
      expectedTotal: stats.expectedTotal ?? null,
      ...stats,
    });
    this._completedRegions.add(regionLabel);
    // Clear page / city checkpoint — this region is done
    this._currentRegion  = null;
    this._currentCity    = null;
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
      completedCities:  this._completedCities,
      regionStats:      this._regionStats,
      currentRegion:    this._currentRegion,
      currentCity:      this._currentCity,
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
