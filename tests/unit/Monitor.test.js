import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Monitor from '../../src/monitoring/Monitor.js';

describe('Monitor', () => {
  beforeEach(() => Monitor.reset());

  it('increments counters', () => {
    Monitor.increment('test.counter');
    Monitor.increment('test.counter', {}, 4);
    const snap = Monitor.snapshot();
    assert.equal(snap.counters['test.counter'].total, 5);
  });

  it('sets gauge values', () => {
    Monitor.gauge('pool.size', 42);
    assert.equal(Monitor.snapshot().gauges['pool.size'], 42);
  });

  it('records timings with min/max/avg', () => {
    Monitor.timing('op', 100);
    Monitor.timing('op', 200);
    Monitor.timing('op', 300);
    const t = Monitor.snapshot().timings['op'];
    assert.equal(t.count, 3);
    assert.equal(t.sum, 600);
    assert.equal(t.avg, 200);
    assert.equal(t.min, 100);
    assert.equal(t.max, 300);
  });

  it('emits valid Prometheus text', () => {
    Monitor.increment('requests', {}, 10);
    Monitor.gauge('active', 3);
    const prom = Monitor.toPrometheus();
    assert.ok(prom.includes('requests_total 10'));
    assert.ok(prom.includes('active 3'));
  });
});
