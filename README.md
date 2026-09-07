# CCI.fr Scraper — Contabo Fleet

Scrapes professional real estate agent cards, attestations, and receipts from [cci.fr/agent-immobilier](https://www.cci.fr/agent-immobilier) across all French regions.

Runs as a **5-instance fleet** on Contabo Windows Server (24/7), with crash resume and a simple HTML dashboard for monitoring and CSV download.

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

5. Start the fleet (5 scrapers + dashboard):

```bat
node run-cci-fleet.js
```

6. Open the dashboard:

`http://localhost:8787/`  
(or `http://<server-public-ip>:8787/` — allow port **8787** in Windows Firewall)

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

**Data safety (crash / resume):**
- **One file:** all 7 instances append to `output/cci-agents.csv` (cross-process lock)
- **Never overwrite** existing rows — only `appendFile`
- **Per-instance progress** in `output/<id>/cci-progress.json` (URLs, region, city, page, completed cities)
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
| **city-idf** | city URL search | ILE-DE-FRANCE (all communes, one by one) |
| **city-occ** | city URL search | OCCITANIE (all communes, one by one) |
| **s1** | region dropdown | AUVERGNE-RHONE-ALPES, CORSE, COLLECTIVITES D'OUTRE-MER, MAYOTTE |
| **s2** | region dropdown | GUADELOUPE, GUYANE, MARTINIQUE, LA REUNION, BOURGOGNE-FRANCHE-COMTE |
| **s3** | region dropdown | BRETAGNE, CENTRE-VAL DE LOIRE, HAUTS-DE-FRANCE |
| **s4** | region dropdown | GRAND EST, NORMANDIE, PAYS DE LA LOIRE |
| **s5** | region dropdown | NOUVELLE-AQUITAINE, PROVENCE-ALPES-COTE D'AZUR |

RAM tip: 7 Chromium windows need about **16–32 GB**.

### City search (ILE-DE-FRANCE + OCCITANIE)

Dedicated instances `city-idf` / `city-occ` use:

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
node run-cci-instance.js --id s1
```

Legacy single runners (`run-cci.js`, `run-cci-session1.js`, …) still work but the **fleet** is the supported path for Contabo.

---

## Document types

- **Carte professionnelle** — company card
- **Attestation** — individual under a card
- **Récépissé** — establishment receipt
