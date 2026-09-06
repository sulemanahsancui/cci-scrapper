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
CCI_STATUS_PORT=8787
CCI_HEADLESS=true
```

---

## How it runs

1. Start **one script**: `node run-cci-fleet.js`
2. That starts **all 5 instances** and the dashboard on port **8787**
3. Each instance saves progress under `output/s1` … `output/s5`
4. If an instance **fails**, dashboard shows `failed` — client clicks **Resume from checkpoint** (continues from last saved URL/page)
5. Anytime, client clicks **Download cci-agents.csv** — one shared file with all scraped data (append-only; download works while scrapers run)

**Data safety:** All 5 instances append into **`output/cci-agents.csv`** (file lock). Restart / Resume never deletes rows. Only `node scripts/reset-cci-run.js` clears output.

### 24/7 on Windows reboot

- Task Scheduler → At startup → `node C:\path\to\ccifr-scrraper\run-cci-fleet.js`
- Start in: project folder
- Fleet comes back up; each instance resumes from its progress file

---

## Region split (5 instances)

Configured in [`src/config/cci-fleet.json`](src/config/cci-fleet.json):

| Instance | Regions |
|---|---|
| s1 | AUVERGNE-RHONE-ALPES, CORSE, COLLECTIVITES D'OUTRE-MER, MAYOTTE |
| s2 | ILE-DE-FRANCE, GUADELOUPE, GUYANE, MARTINIQUE, LA REUNION |
| s3 | OCCITANIE, BRETAGNE, CENTRE-VAL DE LOIRE |
| s4 | GRAND EST, HAUTS-DE-FRANCE, BOURGOGNE-FRANCHE-COMTE |
| s5 | NOUVELLE-AQUITAINE, NORMANDIE, PAYS DE LA LOIRE, PROVENCE-ALPES-COTE D'AZUR |

Edit that file to change partitions. RAM tip: 5 Chromium instances need about **16 GB+**.

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
