import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine } from '../../src/core/workflow/WorkflowEngine.js';

describe('WorkflowEngine', () => {
  it('runs steps sequentially and accumulates results in context', async () => {
    const wf = new WorkflowEngine();
    wf.step('a', (ctx) => { ctx.a = 1; })
      .step('b', (ctx) => { ctx.b = ctx.a + 1; });

    const ctx = await wf.run();
    assert.equal(ctx.a, 1);
    assert.equal(ctx.b, 2);
  });

  it('records step metadata', async () => {
    const wf = new WorkflowEngine();
    wf.step('x', async () => 'done');
    const ctx = await wf.run();
    assert.equal(ctx.meta.x.success, true);
  });

  it('stops on error when stopOnError = true', async () => {
    const wf = new WorkflowEngine({ stopOnError: true });
    let secondRan = false;
    wf.step('fail', async () => { throw new Error('boom'); })
      .step('never', async () => { secondRan = true; });

    await assert.rejects(() => wf.run(), /boom/);
    assert.equal(secondRan, false);
  });

  it('continues on error when stopOnError = false', async () => {
    const wf = new WorkflowEngine({ stopOnError: false, retries: 0 });
    let secondRan = false;
    wf.step('fail', async () => { throw new Error('oops'); })
      .step('ok',   async () => { secondRan = true; });

    const ctx = await wf.run();
    assert.equal(secondRan, true);
    assert.equal(ctx.errors.length, 1);
  });

  it('skips steps with skip: true', async () => {
    const wf = new WorkflowEngine();
    let ran = false;
    wf.step('skip', async () => { ran = true; }, { skip: true });
    await wf.run();
    assert.equal(ran, false);
  });
});
