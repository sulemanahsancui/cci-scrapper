# CCI.fr Scraper — Contabo Fleet

Scrapes professional real estate agent cards, attestations, and receipts from [cci.fr/agent-immobilier](https://www.cci.fr/agent-immobilier) across all French regions.

Runs as a **7-instance fleet** on Contabo Windows Server (24/7), with crash resume and a simple HTML dashboard for monitoring and CSV download.

---

## Quick start (Contabo Windows)

1. Install **Node.js 20+**
2. In the project folder:

```bat
npm install
npx playwright install chromium
copy .env.example .env
```

3. Put your 2captcha key in `.env`:

```env
TWO_CAPTCHA_API_KEY=your_key_here
```

4. Fresh full scrape (clears previous fleet output):

```bat
node scripts/reset-cci-run.js --yes
```

5. Start the fleet (7 scrapers + dashboard):

```bat
node run-cci-fleet.js
```

6. Open the dashboard:

`http://localhost:8787/`  
(or `http://<server-public-ip>:8787/` — allow port **8787** in Windows Firewall)

---

## Contabo recovery (false "done" / upgrade)

If regions show `done` too early, or after pulling a new code version:

```bat
node scripts/reopen-regions.js --all
node run-cci-fleet.js
```

- **CSV is kept** — already scraped URLs are skipped
- Progress “completed” flags are cleared; work resumes from last page/city
- On every start the scraper also **auto-heals** any `completedRegions` that lack proof (`exhausted` + sensible listing counts)
- An instance that still has unfinished assigned regions **exits failed** (not fake `done`) — use dashboard **Resume**

---

## Dashboard

- Live stats per instance (status, region, page, Resume button)
- **One CTA:** Download `cci-agents.csv` (all data in a single shared file)

Optional:

```env
DASHBOARD_TOKEN=some-secret
CCI_HEADLESS=false
```

---

## How it runs

1. Start **one script**: `node run-cci-fleet.js`
2. That starts **7 instances** (2 city-search + 5 region) and the dashboard on port **8787**
3. Each instance saves progress under `output/<instance-id>/`
4. If an instance **fails**, dashboard shows `failed` — client clicks **Resume from checkpoint**
5. Anytime, client clicks **Download cci-agents.csv** — one shared file with all scraped data

**Completion rules (no fake done):**
- A region is complete only when pagination is **exhausted** (short/empty last page) and listing counts are not far below the site “X résultats” total
- Full page (~32) but next page fails → **not** complete → resume later
- Stale regions from an old fleet split are pruned automatically

**Data safety (crash / resume):**
- **One file:** all 7 instances append to `output/cci-agents.csv` (cross-process lock)
- **Never overwrite** existing rows — only `appendFile`
- **Per-instance progress** in `output/<id>/cci-progress.json` (URLs, region, city, page, completed cities, regionStats)
- On restart / Resume: reload progress + scan CSV URLs → skip already scraped → continue from last city/page

### 24/7 on Windows reboot

- Task Scheduler → At startup → `node C:\path\to\ccifr-scrraper\run-cci-fleet.js`
- Start in: project folder
- Fleet comes back up; each instance resumes from its progress file

---

## Region split (7 instances)

Configured in [`src/config/cci-fleet.json`](src/config/cci-fleet.json):

| Instance | Mode | Regions |
|---|---|---|
| **city-occ** | city URL search | OCCITANIE **shard 1/2** (first ~2120 communes) |
| **city-idf** | city URL search | OCCITANIE **shard 2/2** (second ~2121 communes) |
| **s2** | city URL search | ILE-DE-FRANCE **shard 2/2** (second ~631 communes) |
| **s1** | region dropdown | AUVERGNE-RHONE-ALPES, COLLECTIVITES D'OUTRE-MER |
| **s3** | region dropdown | BRETAGNE, CENTRE-VAL DE LOIRE, HAUTS-DE-FRANCE, PAYS DE LA LOIRE |
| **s4** | region dropdown | GRAND EST, NORMANDIE |
| **s5** | region dropdown | NOUVELLE-AQUITAINE, PROVENCE-ALPES-COTE D'AZUR |

*(Rebalanced: free `city-idf` now shares Occitanie with `city-occ`. IDF shard 1/2 already done; `s2` keeps IDF shard 2/2.)*

RAM tip: 7 Chromium windows need about **16–32 GB**.

### City search (ILE-DE-FRANCE + OCCITANIE)

Dedicated instances use `?city=` search. Occitanie is split: `city-occ` = shard 1/2, `city-idf` = shard 2/2.

`https://www.cci.fr/agent-immobilier?city=montpellier`

Cities come from Excel **Commune** column → [`data/cities/city-search.csv`](data/cities/city-search.csv).  
Each city is scraped fully; after all cities that instance is done. `s1`–`s5` run normal region-by-region dropdown scraping in parallel.

---

## Output columns

Same schema as before (`region`, `url`, `document_type`, company / holder / guarantee / insurance fields, etc.). See previous docs or the CSV header row.

Offline merge (same as dashboard merged download):

```bat
node scripts/merge-cci-output.js
```

→ `output/cci-agents-merged.csv`

---

## Useful commands

```bat
npm run fleet
npm run fleet:reset
npm run fleet:merge
node scripts/reopen-regions.js --all
node run-cci-instance.js --id s1
```

Legacy single runners (`run-cci.js`, `run-cci-session1.js`, …) still work but the **fleet** is the supported path for Contabo.

---

## Document types

- **Carte professionnelle** — company card
- **Attestation** — individual under a card
- **Récépissé** — establishment receipt
