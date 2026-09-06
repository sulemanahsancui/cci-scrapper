/**
 * Cross-process lock for the shared cci-agents.csv (Windows-safe via exclusive create).
 */

import fs from 'fs/promises';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<T>}
 * @template T
 */
export async function withFileLock(lockPath, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = Date.now();

  while (true) {
    let handle;
    try {
      handle = await fs.open(lockPath, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      await sleep(40 + Math.random() * 80);
      continue;
    }

    try {
      return await fn();
    } finally {
      await handle.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
    }
  }
}

export default { withFileLock };
