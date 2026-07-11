import { expect, test } from 'bun:test';
import { createRetryableWarmup } from './vite-warmup';

test('retries warmup after a rejected attempt and caches the successful attempt', async () => {
  let attempts = 0;
  const ensureWarmup = createRetryableWarmup(() => {
    attempts += 1;
    if (attempts === 1) {
      return Promise.reject(new Error('transient transform failure'));
    }
    return Promise.resolve();
  });

  await expect(ensureWarmup()).rejects.toThrow('transient transform failure');
  await ensureWarmup();
  await ensureWarmup();

  expect(attempts).toBe(2);
});
