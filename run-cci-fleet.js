/**
 * CCI fleet launcher — runs all instances, auto-restarts on crash,
 * serves HTML dashboard + CSV download on :8787 (or CCI_STATUS_PORT).
 *
 * Usage:
 *   node run-cci-fleet.js
 */

import 'dotenv/config';
import http from 'http';
import fs from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLEET_CONFIG = path.join(__dirname, 'src', 'config', 'cci-fleet.json');
const DASHBOARD_DIR = path.join(__dirname, 'dashboard');
const STATUS_FILE = path.join(__dirname, 'output', 'fleet-status.json');
const OUTPUT_ROOT = path.join(__dirname, 'output');
const SHARED_CSV = path.join(OUTPUT_ROOT, 'cci-agents.csv');

const startedAt = Date.now();
const children = new Map(); // id → { proc, status, restarts, lastExit, lastError, startedAt }

let fleetConfig = { statusPort: 8787, instances: [] };
let shuttingDown = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadConfig() {
  fleetConfig = JSON.parse(await fs.readFile(FLEET_CONFIG, 'utf8'));
}

async function readProgress(id) {
  const file = path.join(OUTPUT_ROOT, id, 'cci-progress.json');
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function countSharedCsvRows() {
  try {
    const text = await fs.readFile(SHARED_CSV, 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    return Math.max(0, lines.length - 1);
  } catch {
    return 0;
  }
}

function normRegion(s) {
  return String(s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function regionMatches(label, wantedList) {
  const n = normRegion(label);
  return (wantedList || []).some((w) => {
    const a = normRegion(w);
    return n.includes(a) || a.includes(n);
  });
}

async function buildStatus() {
  const instances = [];
  const totalRecords = await countSharedCsvRows();

  for (const cfg of fleetConfig.instances || []) {
    const runtime = children.get(cfg.id) || {
      status: 'stopped',
      restarts: 0,
      lastExit: null,
      lastError: null,
      startedAt: null,
    };
    const progress = await readProgress(cfg.id);
    const recordCount = progress?.recordCount ?? progress?.urls?.length ?? 0;
    const assigned = cfg.onlyRegions || [];
    const completedAll = progress?.completedRegions ?? [];
    const completedAssigned = completedAll.filter((r) => regionMatches(r, assigned));
    const currentRegion = progress?.currentRegion ?? null;
    const currentBelongs = currentRegion && regionMatches(currentRegion, assigned);

    instances.push({
      id: cfg.id,
      regions: assigned,
      processStatus: runtime.status,
      restarts: runtime.restarts,
      lastExit: runtime.lastExit,
      lastError: runtime.lastError,
      processStartedAt: runtime.startedAt,
      recordCount,
      completedRegions: completedAssigned,
      completedRegionsRaw: completedAll,
      currentRegion: currentBelongs ? currentRegion : null,
      currentCity: currentBelongs ? (progress?.currentCity ?? null) : null,
      currentPage: currentBelongs ? (progress?.currentPage ?? null) : null,
      currentPageUrl: currentBelongs ? (progress?.currentPageUrl ?? null) : null,
      progressUpdatedAt: progress?.updatedAt ?? null,
      completedCities: progress?.completedCities ?? {},
    });
  }

  const payload = {
    ok: true,
    uptimeMs: Date.now() - startedAt,
    startedAt: new Date(startedAt).toISOString(),
    totalRecords,
    csvFile: 'output/cci-agents.csv',
    instanceCount: instances.length,
    instances,
    updatedAt: new Date().toISOString(),
  };

  await fs.mkdir(OUTPUT_ROOT, { recursive: true });
  await fs.writeFile(STATUS_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function isRunning(id) {
  const state = children.get(id);
  return Boolean(state?.proc && state.status === 'running');
}

/**
 * Start (or resume) an instance. Progress files on disk are kept —
 * scraper continues from the last saved URL / page.
 * Returns { ok, error? }
 */
function resumeInstance(id) {
  if (shuttingDown) return { ok: false, error: 'Fleet is shutting down' };
  const valid = (fleetConfig.instances || []).some((i) => i.id === id);
  if (!valid) return { ok: false, error: 'Unknown instance' };
  if (isRunning(id)) return { ok: false, error: 'Instance already running' };

  spawnInstance(id, { manualResume: true });
  return { ok: true };
}

function spawnInstance(id, { manualResume = false } = {}) {
  if (shuttingDown) return;

  const prev = children.get(id) || { restarts: 0 };
  const proc = spawn(process.execPath, [path.join(__dirname, 'run-cci-instance.js'), '--id', id], {
    cwd: __dirname,
    env: { ...process.env, CCI_INSTANCE: id },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const state = {
    proc,
    status: 'running',
    restarts: manualResume ? (prev.restarts || 0) + 1 : (prev.restarts || 0),
    lastExit: null,
    lastError: null,
    startedAt: new Date().toISOString(),
  };
  children.set(id, state);

  const prefix = `[${id}]`;
  console.log(`${prefix} ${manualResume ? 'resumed from dashboard' : 'started'}`);
  proc.stdout.on('data', (buf) => process.stdout.write(`${prefix} ${buf}`));
  proc.stderr.on('data', (buf) => process.stderr.write(`${prefix} ${buf}`));

  proc.on('exit', (code, signal) => {
    const current = children.get(id);
    if (!current || current.proc !== proc) return;

    current.lastExit = { code, signal, at: new Date().toISOString() };
    current.proc = null;

    if (shuttingDown) {
      current.status = 'stopped';
      return;
    }

    if (code === 0) {
      current.status = 'done';
      current.lastError = null;
      console.log(`${prefix} completed successfully`);
      return;
    }

    // Wait for client to click Resume on the dashboard (keeps progress on disk)
    current.status = 'failed';
    current.lastError = `exited code=${code} signal=${signal || 'none'} — click Resume on dashboard`;
    console.warn(`${prefix} failed — waiting for dashboard Resume`);
  });
}

function checkToken(req) {
  const expected = process.env.DASHBOARD_TOKEN;
  if (!expected) return true;
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams.get('token');
  const h = req.headers['x-dashboard-token'];
  return q === expected || h === expected;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  return 'application/octet-stream';
}

async function handleDownloadCsv(res) {
  if (!existsSync(SHARED_CSV)) {
    sendJson(res, 404, { error: 'cci-agents.csv not found yet — scrapers have not written data' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="cci-agents.csv"',
    'Cache-Control': 'no-store',
  });
  createReadStream(SHARED_CSV).pipe(res);
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;

      if (pathname === '/health') {
        sendJson(res, 200, { ok: true, uptimeMs: Date.now() - startedAt });
        return;
      }

      if (pathname === '/api/status' || pathname === '/status') {
        sendJson(res, 200, await buildStatus());
        return;
      }

      // Resume a failed/stopped/done instance from last checkpoint
      const resumeMatch = pathname.match(/^\/api\/instances\/([^/]+)\/resume$/);
      if (resumeMatch && (req.method === 'POST' || req.method === 'GET')) {
        if (!checkToken(req)) {
          sendJson(res, 401, { error: 'Unauthorized — set ?token= or X-Dashboard-Token' });
          return;
        }
        const result = resumeInstance(resumeMatch[1]);
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (pathname === '/api/download' || pathname === '/api/download/csv' || pathname === '/api/download/merged') {
        if (!checkToken(req)) {
          sendJson(res, 401, { error: 'Unauthorized — set ?token= or X-Dashboard-Token' });
          return;
        }
        await handleDownloadCsv(res);
        return;
      }

      // Static dashboard
      let filePath = pathname === '/' ? path.join(DASHBOARD_DIR, 'index.html') : path.join(DASHBOARD_DIR, pathname);
      filePath = path.normalize(filePath);
      if (!filePath.startsWith(DASHBOARD_DIR)) {
        sendJson(res, 403, { error: 'Forbidden' });
        return;
      }
      if (!existsSync(filePath)) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      const data = await fs.readFile(filePath);
      res.writeHead(200, { 'Content-Type': contentType(filePath), 'Cache-Control': 'no-store' });
      res.end(data);
    } catch (err) {
      console.error('HTTP error', err);
      sendJson(res, 500, { error: err.message });
    }
  });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down fleet…');
  for (const [id, state] of children) {
    if (state.proc) {
      console.log(`Stopping ${id} (pid ${state.proc.pid})`);
      state.proc.kill();
    }
  }
  await sleep(1500);
  process.exit(0);
}

async function main() {
  await loadConfig();
  await fs.mkdir(OUTPUT_ROOT, { recursive: true });

  const port = parseInt(process.env.CCI_STATUS_PORT || String(fleetConfig.statusPort || 8787), 10);
  const server = createServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`Dashboard: http://localhost:${port}/`);
    console.log(`Status API: http://localhost:${port}/api/status`);
  });

  for (const inst of fleetConfig.instances || []) {
    spawnInstance(inst.id);
  }

  setInterval(() => {
    buildStatus().catch((err) => console.error('status flush failed', err.message));
  }, 15_000);

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
