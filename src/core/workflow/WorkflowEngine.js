/**
 * WorkflowEngine — composable, sequential automation workflow builder.
 *
 * Supports a fluent API for common scraping workflows:
 *
 *   await workflow
 *     .step('login',     async (ctx) => { ... })
 *     .step('search',    async (ctx) => { ... })
 *     .step('paginate',  async (ctx) => { ... })
 *     .step('extract',   async (ctx) => { ... })
 *     .step('save',      async (ctx) => { ... })
 *     .run({ initialData: {} });
 *
 * Context (ctx) is shared across all steps and accumulates results.
 */

import { retry }  from '../../utils/retry.js';
import logger     from '../../logger/index.js';
import Monitor    from '../../monitoring/Monitor.js';

export class WorkflowEngine {
  constructor(options = {}) {
    this._steps  = [];
    this.options = {
      stopOnError: true,
      retries: 1,
      ...options,
    };
  }

  /**
   * Add a named step to the workflow.
   * @param {string}   name - Human-readable step name
   * @param {Function} fn   - async (ctx) => any
   * @param {object}   opts - { retries, skip }
   */
  step(name, fn, opts = {}) {
    this._steps.push({ name, fn, opts });
    return this; // fluent
  }

  /** Convenience: add a conditional step that only runs if predicate returns true. */
  stepIf(condition, name, fn, opts = {}) {
    return this.step(name, async (ctx) => {
      if (typeof condition === 'function' ? condition(ctx) : condition) {
        return fn(ctx);
      }
    }, opts);
  }

  /**
   * Execute all steps sequentially.
   * @param {object} initialCtx - Seed data available to all steps
   * @returns {object} Final context after all steps complete
   */
  async run(initialCtx = {}) {
    const ctx = {
      results: [],
      errors: [],
      meta: {},
      ...initialCtx,
    };

    const workflowStart = Date.now();
    logger.info('Workflow started', { steps: this._steps.map((s) => s.name) });

    for (const step of this._steps) {
      if (step.opts.skip) continue;

      const stepStart = Date.now();
      logger.debug('Workflow step started', { step: step.name });

      try {
        const result = await retry(
          () => step.fn(ctx),
          { attempts: (step.opts.retries ?? this.options.retries) + 1 },
        );

        const duration = Date.now() - stepStart;
        ctx.meta[step.name] = { success: true, durationMs: duration };
        Monitor.timing(`workflow.step.${step.name}`, duration);
        logger.debug('Workflow step completed', { step: step.name, durationMs: duration });

        if (result !== undefined) ctx[step.name] = result;
      } catch (err) {
        const duration = Date.now() - stepStart;
        ctx.errors.push({ step: step.name, error: err.message });
        ctx.meta[step.name] = { success: false, durationMs: duration, error: err.message };

        logger.error('Workflow step failed', { step: step.name, error: err.message });
        Monitor.increment(`workflow.step.${step.name}.failed`);

        if (this.options.stopOnError) throw err;
      }
    }

    const totalDuration = Date.now() - workflowStart;
    logger.info('Workflow completed', { totalDurationMs: totalDuration, errors: ctx.errors.length });
    Monitor.timing('workflow.total', totalDuration);

    return ctx;
  }

  /** Clone the workflow (useful for running the same workflow concurrently). */
  clone() {
    const wf = new WorkflowEngine(this.options);
    wf._steps = [...this._steps];
    return wf;
  }

  // ── Pre-built common steps ─────────────────────────────────────────────────

  /** Convenience factory — returns a workflow pre-wired for a typical scrape flow. */
  static scrapeFlow() {
    return new WorkflowEngine()
      .step('init',    async () => {})
      .step('login',   async () => {})
      .step('search',  async () => {})
      .step('paginate',async () => {})
      .step('extract', async () => {})
      .step('export',  async () => {});
  }
}

export default WorkflowEngine;
