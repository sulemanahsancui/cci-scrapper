import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { retry } from '../../src/utils/retry.js';

describe('retry()', () => {
  it('resolves immediately on first success', async () => {
    const result = await retry(() => Promise.resolve(42), { attempts: 3 });
    assert.equal(result, 42);
  });

  it('retries on failure and eventually resolves', async () => {
    let calls = 0;
    const result = await retry(
      () => {
        calls++;
        if (calls < 3) { const e = new Error('fail'); e.retryable = true; throw e; }
        return 'ok';
      },
      { attempts: 3, baseDelay: 10 },
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
  });

  it('throws after exhausting all attempts', async () => {
    await assert.rejects(
      () => retry(() => { throw Object.assign(new Error('always fails'), { retryable: true }); }, { attempts: 2, baseDelay: 10 }),
      /always fails/,
    );
  });

  it('aborts early when shouldRetry returns false', async () => {
    let calls = 0;
    await assert.rejects(
      () => retry(
        () => { calls++; throw new Error('non-retryable'); },
        { attempts: 5, baseDelay: 10, shouldRetry: () => false },
      ),
      /non-retryable/,
    );
    assert.equal(calls, 1);
  });
});
