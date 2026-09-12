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
import { createReadStream } from 'fs';
import readline from 'readline';
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
  applyCityShard,
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
    // Append-only URL list (keeps progress JSON small — avoids heap OOM)
    this._urlsFile     = path.resolve(
      options.urlsFile ?? this._progressFile.replace(/\.json$/i, '-urls.txt'),
    );
    // If set, only process regions whose label matches one of these strings (case-insensitive partial match)
    this._onlyRegions  = options.onlyRegions ?? null;
    this._cityShard    = options.cityShard ?? null;
    // Optional page window for region-dropdown splits: { start, end } or
    // { "PROVENCE-ALPES-COTE D'AZUR": { start, end } }
    this._pageRange    = options.pageRange ?? null;
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
    this._metaDirty        = false;
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
      // City-search always enters the city loop (shard may have been rebalanced)
      if (isCitySearchRegion(region.label)) {
        if (this._isRegionMarkedComplete(region.label)) {
          // Fast path: still verify inside in case cityShard changed
          logger.info('City-search region already marked complete — verifying shard', {
            label: region.label,
            cityShard: this._cityShard,
          });
        }
        logger.info('Starting city-by-city region (will finish all cities before next region)', {
          label: region.label,
          cityShard: this._cityShard,
        });
        await this._scrapeRegionByCities(region.label);
        continue;
      }

      if (this._isRegionMarkedComplete(region.label)) {
        logger.info('Skipping already-completed region (verified)', { label: region.label });
        continue;
      }

      const pageRange = this._resolvePageRange(region.label);

      // Resume from the exact page: currentRegion has priority (live checkpoint),
      // then pageRange.start / pageCheckpoints, then default to page 1.
      const sameRegion =
        normalizeRegionKey(this._currentRegion) === normalizeRegionKey(region.label);
      const isResumingRegion = sameRegion && this._currentPage > 1 && this._currentPageUrl;

      let startPage = isResumingRegion
        ? this._currentPage
        : (pageRange?.start ?? this._pageCheckpoints[region.label] ?? 1);
      const startPageUrl = isResumingRegion ? this._currentPageUrl : null;

      if (pageRange?.end != null && Number.isFinite(pageRange.end) && startPage > pageRange.end) {
        logger.info('Already past pageRange end — marking region range complete', {
          label: region.label,
          startPage,
          pageRange,
        });
        await this._saveRegionComplete(region.label, {
          exhausted: true,
          listingsSeen: 0,
          expectedTotal: null,
          pageRange,
        });
        continue;
      }

      // Once we consume a pre-set checkpoint, remove it so it doesn't re-apply on the next run
      if (this._pageCheckpoints[region.label]) {
        delete this._pageCheckpoints[region.label];
        await this._flushProgress();
      }

      logger.info('Processing region', {
        value: region.value,
        label: region.label,
        startPage,
        pageRange,
      });

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

        // Jump via ?page= (Drupal 0-based) — never click 500+ times
        if (startPage > 1) {
          await this._gotoResultsPageNumber(startPage);
          await this._waitForPage();
        }
      }

      const { listingsSeen, exhausted, expectedTotal, rangeComplete } = await this._scrapeAllPages(
        region.label,
        startPage,
      );

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

      // Partial page ranges must not be judged against the full-region site total
      const ranged = Boolean(pageRange?.end && Number.isFinite(pageRange.end));
      if (!ranged && !rangeComplete && startPage <= 1 && !this._countsLookComplete(listingsSeen, expectedTotal)) {
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
        startPage > 1 && expectedTotal != null && !ranged
          ? expectedTotal
          : listingsSeen;

      await this._saveRegionComplete(region.label, {
        exhausted: true,
        listingsSeen: provenSeen,
        expectedTotal: ranged ? null : expectedTotal,
        pageRange,
      });
      logger.info(ranged || rangeComplete ? 'Region page-range complete' : 'Region complete', {
        label: region.label,
        listingsSeen: provenSeen,
        expectedTotal,
        pageRange,
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
    const allCities = await citiesForRegion(regionLabel);
    const cities = applyCityShard(allCities, this._cityShard);
    const shardSlugs = new Set(cities.map((c) => cityToQuery(c)).filter(Boolean));

    if (!cities.length) {
      logger.error('No cities configured for city-search region — add rows to data/cities/city-search.csv', {
        region: regionLabel,
        cityShard: this._cityShard,
      });
      return;
    }

    // Only count cities in THIS shard as done (avoids false "region complete"
    // when progress still lists cities from the other half).
    if (!this._completedCities[regionKey]) this._completedCities[regionKey] = [];
    const done = new Set(
      (this._completedCities[regionKey] || []).filter((s) => shardSlugs.has(s)),
    );

    if (this._currentCity && !shardSlugs.has(this._currentCity)) {
      logger.warn('Clearing currentCity outside this instance cityShard', {
        currentCity: this._currentCity,
        cityShard: this._cityShard,
      });
      this._currentCity    = null;
      this._currentPage    = 1;
      this._currentPageUrl = null;
    }

    logger.info('City-search region — scraping city by city', {
      region: regionLabel,
      citiesInShard: cities.length,
      citiesTotal: allCities.length,
      cityShard: this._cityShard,
      alreadyDone: done.size,
      firstCity: cities[0],
      lastCity: cities[cities.length - 1],
    });

    // If previously marked complete but this shard still has cities left, reopen
    if (done.size < cities.length) {
      const before = [...this._completedRegions];
      this._completedRegions = new Set(
        before.filter((r) => {
          const a = normalizeRegionKey(r);
          return !(a === regionKey || a.includes(regionKey) || regionKey.includes(a));
        }),
      );
      if (before.length !== this._completedRegions.size) {
        logger.warn('Reopened city-search region — shard still has unfinished cities', {
          region: regionLabel,
          cityShard: this._cityShard,
          done: done.size,
          citiesInShard: cities.length,
        });
        this._rememberRegionStats(regionLabel, { exhausted: false });
        await this._flushProgress();
      }
    } else if (done.size >= cities.length && cities.length > 0) {
      logger.info('City-search shard already fully done', {
        region: regionLabel,
        cityShard: this._cityShard,
        cities: cities.length,
      });
      if (!this._isRegionMarkedComplete(regionLabel)) {
        await this._saveRegionComplete(regionLabel, {
          exhausted: true,
          listingsSeen: 0,
          expectedTotal: null,
          citiesDone: done.size,
          citiesTotal: cities.length,
          cityShard: this._cityShard,
        });
      }
      return;
    }

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

      const coverageDone = this._coverageLooksComplete(listingsSeen, expectedTotal, startPage);

      // City mode must never soft-lock on one commune (Uzès, Montpellier, …).
      // If pager is unclear but we already saw listings, mark city done and move on.
      // Missing a rare last page is better than Resume looping forever on the same city.
      if (!exhausted && listingsSeen > 0 && !coverageDone) {
        logger.warn('City pagination unclear — marking city complete and continuing to next city', {
          region: regionLabel,
          city: cityName,
          slug,
          listingsSeen,
          expectedTotal,
          startPage,
        });
      } else if (!exhausted && coverageDone) {
        logger.info('City treated complete — listings cover site total despite pager stop', {
          region: regionLabel,
          city: cityName,
          listingsSeen,
          expectedTotal,
          startPage,
        });
      }

      // Persist only shard-local completed city slugs for this region
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
        cityShard: this._cityShard,
      });
    }

    if (done.size >= cities.length) {
      await this._saveRegionComplete(regionLabel, {
        exhausted: true,
        listingsSeen: regionListings,
        expectedTotal: null,
        citiesDone: done.size,
        citiesTotal: cities.length,
        cityShard: this._cityShard,
      });
      logger.info('City-search region complete (this shard)', {
        region: regionLabel,
        cities: cities.length,
        citiesTotal: allCities.length,
        cityShard: this._cityShard,
        listingsSeen: regionListings,
        totalSaved: this._count,
      });
    } else {
      logger.warn('City-search region not fully complete yet', {
        region: regionLabel,
        done: done.size,
        total: cities.length,
        cityShard: this._cityShard,
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
        return { listingsSeen, exhausted: true, expectedTotal, rangeComplete: false };
      }

      // Stop at assigned pageRange.end (multi-instance page splits)
      const pageRange = this._resolvePageRange(regionLabel);
      if (pageRange?.end != null && Number.isFinite(pageRange.end) && pageNum >= pageRange.end) {
        logger.info('Reached pageRange end — stopping this instance range', {
          region: regionLabel,
          page: pageNum,
          end: pageRange.end,
          listingsSeen,
        });
        return { listingsSeen, exhausted: true, expectedTotal, rangeComplete: true };
      }

      // Prefer URL ?page= N+1 (reliable). Fall back to clicking "next".
      const advanced = await this._goToNextPage();
      if (!advanced) {
        if (lastPageCount >= PAGE_SIZE) {
          // Retry once — transient nav failures are common after many detail page hops
          await this.pause(2000, 3500);
          const retried = await this._goToNextPage();
          if (retried) {
            pageNum++;
            await this._waitForPage();
            const hasAfterRetry = await this.page.$('tr.lien-fiche').catch(() => null);
            if (!hasAfterRetry) {
              const decided = await this._decideAfterEmptyNextPage({
                regionLabel,
                pageNum,
                lastPageCount,
                listingsSeen,
                expectedTotal,
              });
              if (decided.continueScraping) continue;
              return decided.result;
            }
            // Has results — loop will scrape this page
            continue;
          }

          const total = expectedTotal ?? await this._readExpectedTotal();
          if (this._coverageLooksComplete(listingsSeen, total, startPage)) {
            logger.info('Could not open next page but coverage matches site total — end of list', {
              region: regionLabel,
              page: pageNum,
              listingsSeen,
              expectedTotal: total,
            });
            return { listingsSeen, exhausted: true, expectedTotal: total };
          }

          // City searches: no next link after a full page usually means exact N*32 end
          // and the URL pager already tried past the end — mark city done so we move on
          if (this._currentCity || isCitySearchRegion(regionLabel)) {
            logger.info('City mode: no next page after full page — treating as end of city', {
              region: regionLabel,
              city: this._currentCity,
              page: pageNum,
              lastPageCount,
              expectedTotal: total,
            });
            return { listingsSeen, exhausted: true, expectedTotal: total };
          }

          logger.warn('Full page of results but could not open next page — NOT exhausted', {
            region: regionLabel,
            page: pageNum,
            lastPageCount,
            expectedTotal: total,
          });
          return { listingsSeen, exhausted: false, expectedTotal: total };
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
        if (lastPageCount >= PAGE_SIZE) {
          const decided = await this._decideAfterEmptyNextPage({
            regionLabel,
            pageNum,
            lastPageCount,
            listingsSeen,
            expectedTotal,
          });
          if (decided.continueScraping) continue;
          return decided.result;
        }
        logger.info('Next page has no results — end of region', {
          region: regionLabel,
          pages: pageNum,
          expectedTotal,
        });
        return { listingsSeen, exhausted: true, expectedTotal };
      }
    }
  }

  /**
   * After navigating to "next" and finding zero rows: either real end (exact
   * multiple of page size) or a transient empty (CF / slow load).
   * Applies to every city-search commune — not a one-off for a single town.
   */
  async _decideAfterEmptyNextPage({
    regionLabel,
    pageNum,
    lastPageCount,
    listingsSeen,
    expectedTotal,
  }) {
    await this._waitForPage();
    let again = await this.page.$('tr.lien-fiche').catch(() => null);
    if (!again) {
      await this.cloudflareHandler.bypass(this.page);
      await this._waitForPage();
      again = await this.page.$('tr.lien-fiche').catch(() => null);
    }
    if (again) {
      logger.info('Next page loaded after wait — continuing', { region: regionLabel, page: pageNum });
      return { continueScraping: true };
    }

    const total = expectedTotal ?? await this._readExpectedTotal();

    // Exact boundary e.g. 96 results = 3 full pages → page 4 is empty = DONE
    if (total != null && listingsSeen >= Math.floor(total * 0.9)) {
      logger.info('Next page empty — listings cover site total, end of list', {
        region: regionLabel,
        page: pageNum,
        listingsSeen,
        expectedTotal: total,
        lastPageCount,
      });
      return {
        continueScraping: false,
        result: { listingsSeen, exhausted: true, expectedTotal: total },
      };
    }

    // All city-search communes (IDF + Occitanie): empty next after a full page
    // is treated as end of that city so the fleet always advances.
    if (this._currentCity || isCitySearchRegion(regionLabel)) {
      logger.info('City mode: empty next after full page — end of city', {
        region: regionLabel,
        city: this._currentCity,
        page: pageNum,
        listingsSeen,
        expectedTotal: total,
        lastPageCount,
      });
      return {
        continueScraping: false,
        result: { listingsSeen, exhausted: true, expectedTotal: total },
      };
    }

    logger.warn('Next page empty after full page — NOT exhausted (will retry later)', {
      region: regionLabel,
      page: pageNum,
      expectedTotal: total,
      listingsSeen,
    });
    return {
      continueScraping: false,
      result: { listingsSeen, exhausted: false, expectedTotal: total },
    };
  }

  /** Whether listingsSeen (this pass, or estimated with startPage) covers site total. */
  _coverageLooksComplete(listingsSeen, expectedTotal, startPage = 1) {
    if (expectedTotal == null || expectedTotal <= 0) return false;
    const estimated =
      startPage > 1 ? (startPage - 1) * 32 + listingsSeen : listingsSeen;
    return estimated >= expectedTotal * 0.9;
  }

  /**
   * Fleet page window for one region. Accepts:
   *   { start, end }
   *   { "PROVENCE-ALPES-COTE D'AZUR": { start, end } }
   */
  _resolvePageRange(regionLabel) {
    const pr = this._pageRange;
    if (!pr || typeof pr !== 'object') return null;

    if (pr.start != null || pr.end != null) {
      return {
        start: pr.start != null ? Number(pr.start) : 1,
        end: pr.end != null ? Number(pr.end) : Infinity,
      };
    }

    const want = normalizeRegionKey(regionLabel);
    for (const [key, val] of Object.entries(pr)) {
      if (!val || typeof val !== 'object') continue;
      const k = normalizeRegionKey(key);
      if (k === want || k.includes(want) || want.includes(k)) {
        return {
          start: val.start != null ? Number(val.start) : 1,
          end: val.end != null ? Number(val.end) : Infinity,
        };
      }
    }
    return null;
  }

  /** Jump results list to 1-based page via Drupal ?page= (0-based). */
  async _gotoResultsPageNumber(page1Based) {
    const target = Math.max(1, Number(page1Based) || 1);
    const url = new URL(this.page.url());
    url.searchParams.set('page', String(target - 1));
    logger.info('Jumping to results page', { page: target, url: url.toString() });
    await this.page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await this.cloudflareHandler.bypass(this.page);
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

    // 1) Load this instance's progress metadata (no giant urls[] in JSON anymore)
    let legacyUrls = [];
    try {
      const raw      = await fs.readFile(this._progressFile, 'utf8');
      const progress = JSON.parse(raw);
      legacyUrls = Array.isArray(progress.urls) ? progress.urls : (Array.isArray(progress) ? progress : []);
      this._completedRegions = new Set(progress.completedRegions ?? []);
      this._completedCities  = progress.completedCities ?? {};
      this._regionStats      = progress.regionStats ?? {};
      this._currentRegion    = progress.currentRegion   ?? null;
      this._currentCity      = progress.currentCity     ?? null;
      this._currentPage      = progress.currentPage     ?? 1;
      this._currentPageUrl   = progress.currentPageUrl  ?? null;
      this._pageCheckpoints  = progress.pageCheckpoints ?? {};
      this._pruneProgressToAssignedRegions();
      this._healFalseCompletes();
      logger.info('Resuming progress metadata', {
        currentRegion:    this._currentRegion,
        currentCity:      this._currentCity,
        currentPage:      this._currentPage,
        completedRegions: [...this._completedRegions],
        legacyUrlsInJson: legacyUrls.length,
      });
    } catch {
      logger.info('No progress file yet — starting fresh progress tracker');
    }

    // 1b) Instance URL list (append-only text file) + one-time migrate from legacy JSON
    await this._loadInstanceUrls(legacyUrls);

    // 2) Shared CSV is append-only. Create header only if missing.
    //    Stream-scan URLs so other instances' rows are not re-inserted.
    const csvExists = await fs.access(this._outputCsv).then(() => true).catch(() => false);
    if (!csvExists) {
      await fs.writeFile(this._outputCsv, CSV_COLUMNS.join(',') + '\n', { flag: 'wx' }).catch(async (err) => {
        if (err.code !== 'EEXIST') throw err;
        logger.warn('CSV appeared concurrently — will append only', { file: this._outputCsv });
      });
      logger.info('Created shared CSV with header (append-only)', { file: this._outputCsv });
    } else {
      const fromCsv = await this._urlsFromExistingCsv();
      logger.info('Shared CSV exists — append only, resume will skip known URLs', {
        file: this._outputCsv,
        urlsInCsv: fromCsv,
        knownUrls: this._knownUrls.size,
        instanceUrls: this._scrapedUrls.size,
        completedCities: Object.fromEntries(
          Object.entries(this._completedCities).map(([k, v]) => [k, v.length]),
        ),
        currentRegion: this._currentRegion,
        currentCity: this._currentCity,
        currentPage: this._currentPage,
      });
    }

    this._count = this._scrapedUrls.size;
    // Rewrite progress JSON without embedded urls[] (frees heap / disk thrash)
    await this._flushProgress();
  }

  /** Load instance URLs from sidecar file; migrate legacy progress.urls once. */
  async _loadInstanceUrls(legacyUrls = []) {
    const fromFile = await this._readUrlLines(this._urlsFile);
    for (const u of fromFile) {
      this._scrapedUrls.add(u);
      this._knownUrls.add(u);
    }

    if (legacyUrls.length) {
      let migrated = 0;
      const lines = [];
      for (const u of legacyUrls) {
        if (!u || this._scrapedUrls.has(u)) continue;
        this._scrapedUrls.add(u);
        this._knownUrls.add(u);
        lines.push(u);
        migrated++;
      }
      if (lines.length) {
        await fs.appendFile(this._urlsFile, `${lines.join('\n')}\n`, 'utf8');
      }
      logger.info('Migrated legacy progress.urls into sidecar urls file', {
        file: this._urlsFile,
        migrated,
        total: this._scrapedUrls.size,
      });
    } else {
      logger.info('Loaded instance URL sidecar', {
        file: this._urlsFile,
        urls: this._scrapedUrls.size,
      });
    }
  }

  async _readUrlLines(filePath) {
    const urls = [];
    try {
      await fs.access(filePath);
    } catch {
      return urls;
    }
    const rl = readline.createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const u = line.trim();
      if (u) urls.push(u);
    }
    return urls;
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

    // Page-range workers only own a slice — don't require full-region totals
    if (this._resolvePageRange(label) || stats.pageRange) {
      return true;
    }

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

  /** Stream-read url column from existing CSV (avoids loading entire file into RAM). */
  async _urlsFromExistingCsv() {
    let count = 0;
    try {
      await fs.access(this._outputCsv);
    } catch {
      return 0;
    }

    try {
      const rl = readline.createInterface({
        input: createReadStream(this._outputCsv, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });

      let urlIdx = -1;
      let isHeader = true;
      for await (const line of rl) {
        if (!line.trim()) continue;
        if (isHeader) {
          const header = line.split(',');
          urlIdx = header.indexOf('url');
          isHeader = false;
          if (urlIdx < 0) return 0;
          continue;
        }
        const cols = this._parseCsvLine(line);
        const u = cols[urlIdx];
        if (u) {
          this._knownUrls.add(u);
          count++;
        }
      }
    } catch (err) {
      logger.warn('Could not scan existing CSV for URLs', { error: err.message });
    }
    return count;
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
    if (this._scrapedUrls.has(href)) {
      this._knownUrls.add(href);
      this._count = this._scrapedUrls.size;
      return;
    }
    this._scrapedUrls.add(href);
    this._knownUrls.add(href);
    // Append-only sidecar — crash-safe without rewriting tens of thousands of URLs as JSON
    await fs.appendFile(this._urlsFile, `${href}\n`, 'utf8');
    this._count = this._scrapedUrls.size;
    // Metadata (page/region) is flushed by the pagination loop; keep JSON lean
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
    // Metadata only — URLs live in the sidecar file (prevents heap OOM)
    const payload = JSON.stringify({
      instanceId:       this._instanceId,
      urlsFile:         path.basename(this._urlsFile),
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
