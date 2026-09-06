/**
 * Monitor — in-process metrics collection.
 *
 * Provides a lightweight, zero-dependency metrics store that can be
 * flushed to Prometheus / Grafana via the /metrics API endpoint.
 *
 * Usage:
 *   Monitor.increment('scraper.started', { scraper: 'ZillowScraper' });
 *   Monitor.timing('scraper.duration', 3400);
 *   Monitor.gauge('proxy.pool.size', 42);
 *   const snapshot = Monitor.snapshot();
 */

class MetricsStore {
  constructor() {
    this._counters = new Map(); // name → { total, byLabel: Map }
    this._gauges   = new Map(); // name → value
    this._timings  = new Map(); // name → { count, sum, min, max }
    this._startedAt = Date.now();
  }

  /** Increment a counter metric. */
  increment(name, labels = {}, amount = 1) {
    if (!this._counters.has(name)) {
      this._counters.set(name, { total: 0, byLabel: new Map() });
    }
    const counter = this._counters.get(name);
    counter.total += amount;

    const labelKey = JSON.stringify(labels);
    counter.byLabel.set(labelKey, (counter.byLabel.get(labelKey) ?? 0) + amount);
  }

  /** Set a gauge value (e.g. queue depth, active sessions). */
  gauge(name, value) {
    this._gauges.set(name, value);
  }

  /** Record a timing observation in milliseconds. */
  timing(name, ms) {
    if (!this._timings.has(name)) {
      this._timings.set(name, { count: 0, sum: 0, min: Infinity, max: -Infinity });
    }
    const t = this._timings.get(name);
    t.count++;
    t.sum += ms;
    t.min = Math.min(t.min, ms);
    t.max = Math.max(t.max, ms);
  }

  /** Return a plain-object snapshot of all metrics. */
  snapshot() {
    const counters = {};
    for (const [name, data] of this._counters) {
      counters[name] = {
        total: data.total,
        byLabel: Object.fromEntries(
          [...data.byLabel.entries()].map(([k, v]) => [k, v]),
        ),
      };
    }

    const gauges = Object.fromEntries(this._gauges);

    const timings = {};
    for (const [name, t] of this._timings) {
      timings[name] = {
        count: t.count,
        sum:   t.sum,
        avg:   t.count ? Math.round(t.sum / t.count) : 0,
        min:   t.min === Infinity ? 0 : t.min,
        max:   t.max === -Infinity ? 0 : t.max,
      };
    }

    return {
      uptimeMs: Date.now() - this._startedAt,
      counters,
      gauges,
      timings,
    };
  }

  /** Emit metrics in Prometheus exposition format. */
  toPrometheus() {
    const lines = [];
    const snap = this.snapshot();

    for (const [name, data] of Object.entries(snap.counters)) {
      const metricName = name.replace(/\./g, '_');
      lines.push(`# TYPE ${metricName} counter`);
      lines.push(`${metricName}_total ${data.total}`);
    }

    for (const [name, value] of Object.entries(snap.gauges)) {
      const metricName = name.replace(/\./g, '_');
      lines.push(`# TYPE ${metricName} gauge`);
      lines.push(`${metricName} ${value}`);
    }

    for (const [name, t] of Object.entries(snap.timings)) {
      const metricName = name.replace(/\./g, '_');
      lines.push(`# TYPE ${metricName}_milliseconds summary`);
      lines.push(`${metricName}_milliseconds_count ${t.count}`);
      lines.push(`${metricName}_milliseconds_sum ${t.sum}`);
    }

    return lines.join('\n');
  }

  reset() {
    this._counters.clear();
    this._gauges.clear();
    this._timings.clear();
  }
}

// Singleton
const Monitor = new MetricsStore();
export default Monitor;
