import { describe, expect, test } from 'bun:test';
import type { UsageReportPayload } from '@ai-usage/report-core/report-data';
import { createReportPayloadCache, parseRunnerPayload } from './report-payload.server';

const deferred = <A>() => {
  let reject: ((reason?: unknown) => void) | undefined;
  let resolve: ((value: A) => void) | undefined;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return {
    promise,
    reject: (reason?: unknown) => reject?.(reason),
    resolve: (value: A) => resolve?.(value),
  };
};

const payloadForRun = (generatedAt: string): UsageReportPayload => ({
  analytics: {} as UsageReportPayload['analytics'],
  filters: { since: null, project: null, limit: null, minTokens: 1, sort: 'date' },
  generatedAt,
  omittedRows: 0,
  rows: [],
  tableRows: [],
});

describe('report payload cache', () => {
  test('does not republish or detach stale work after a config change', async () => {
    const firstLoad = deferred<UsageReportPayload>();
    const secondLoad = deferred<UsageReportPayload>();
    const loads = [firstLoad, secondLoad];
    let loadCount = 0;
    const cache = createReportPayloadCache({
      load: () => {
        const load = loads[loadCount];
        loadCount++;
        if (!load) {
          throw new Error('Unexpected report payload load');
        }
        return load.promise;
      },
    });

    const staleRequest = cache.collect();
    cache.invalidate();
    const currentRequest = cache.collect();

    firstLoad.resolve(payloadForRun('stale'));
    await staleRequest;

    expect(cache.collect()).toBe(currentRequest);
    expect(loadCount).toBe(2);

    const currentPayload = payloadForRun('current');
    secondLoad.resolve(currentPayload);
    await expect(currentRequest).resolves.toBe(currentPayload);
    await expect(cache.collect()).resolves.toBe(currentPayload);
    expect(loadCount).toBe(2);
  });

  test('serves the last good payload while a forced refresh runs or fails', async () => {
    const refreshLoad = deferred<UsageReportPayload>();
    const currentPayload = payloadForRun('current');
    let loadCount = 0;
    let now = 1000;
    const cache = createReportPayloadCache({
      load: () => {
        loadCount++;
        return loadCount === 1 ? Promise.resolve(currentPayload) : refreshLoad.promise;
      },
      now: () => now,
      ttlMs: 10,
    });

    await expect(cache.collect()).resolves.toBe(currentPayload);
    now += 11;
    const refreshRequest = cache.collect({ force: true });

    await expect(cache.collect()).resolves.toBe(currentPayload);
    refreshLoad.reject(new Error('Fixture refresh failure'));
    await expect(refreshRequest).rejects.toThrow('Fixture refresh failure');
    await expect(cache.collect()).resolves.toBe(currentPayload);
    expect(loadCount).toBe(2);
  });

  test('releases a synchronously failed loader before the next request', async () => {
    const recoveredPayload = payloadForRun('recovered');
    let loadCount = 0;
    const cache = createReportPayloadCache({
      load: () => {
        loadCount++;
        if (loadCount === 1) {
          throw new Error('Synchronous fixture failure');
        }
        return Promise.resolve(recoveredPayload);
      },
    });

    await expect(cache.collect()).rejects.toThrow('Synchronous fixture failure');
    await expect(cache.collect()).resolves.toBe(recoveredPayload);
    expect(loadCount).toBe(2);
  });
});

describe('parseRunnerPayload', () => {
  test('ignores runtime warning lines before the JSON payload', () => {
    const payload = parseRunnerPayload('timestamp=2026-06-22T11:30:48.703Z level=WARN message=noise\n{"rows":[]}');

    expect(payload.rows).toEqual([]);
  });
});
