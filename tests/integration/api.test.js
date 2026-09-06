/**
 * Integration tests for the Jobs API.
 *
 * Requires a running PostgreSQL and Redis instance.
 * Set up with: docker-compose up -d postgres redis
 *
 * Run with: node --test tests/integration/api.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app  from '../../src/api/server.js';
import { ping } from '../../src/database/connection.js';

let server;
let baseUrl;

before(async () => {
  // Skip if DB is not available
  const dbOk = await ping().catch(() => false);
  if (!dbOk) {
    console.warn('Skipping integration tests — DB not available');
    process.exit(0);
  }

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(() => server?.close());

async function req(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.API_KEY ?? 'test',
        ...headers,
      },
    };
    const r = http.request(url, opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || 'null') }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

describe('GET /health', () => {
  it('returns 200 when healthy', async () => {
    const res = await req('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });
});

describe('Jobs API', () => {
  let createdJobId;

  it('POST /api/v1/jobs creates a job', async () => {
    const res = await req('POST', '/api/v1/jobs', {
      scraper: 'ExampleScraper',
      input: { pages: 1 },
      priority: 5,
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    createdJobId = res.body.id;
  });

  it('GET /api/v1/jobs lists jobs', async () => {
    const res = await req('GET', '/api/v1/jobs');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
  });

  it('GET /api/v1/jobs/:id returns a specific job', async () => {
    const res = await req('GET', `/api/v1/jobs/${createdJobId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, createdJobId);
  });

  it('DELETE /api/v1/jobs/:id cancels a job', async () => {
    const res = await req('DELETE', `/api/v1/jobs/${createdJobId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });

  it('GET /api/v1/jobs/stats returns aggregated stats', async () => {
    const res = await req('GET', '/api/v1/jobs/stats');
    assert.equal(res.status, 200);
    assert.ok(res.body.metrics);
  });
});
