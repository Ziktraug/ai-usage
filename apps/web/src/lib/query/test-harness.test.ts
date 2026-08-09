import { describe, expect, test } from 'bun:test';
import { isCancelledError } from '@tanstack/svelte-query';
import { controlPlaneKey, finiteSwrKey } from './keys';
import { webQueryPolicies } from './policies';
import { createQueryTestHarness } from './test-harness';

const GC_TEST_TIME_MS = 10;
const GC_POLL_INTERVAL_MS = 5;
const GC_TEST_DEADLINE_MS = 500;

const waitForEmptyCache = async (cacheSize: () => number): Promise<void> => {
  const deadline = Date.now() + GC_TEST_DEADLINE_MS;
  while (cacheSize() !== 0 && Date.now() < deadline) {
    await Bun.sleep(GC_POLL_INTERVAL_MS);
  }
};

describe('framework-neutral QueryClient test harness', () => {
  test('QUERY-CORE-ABORT: forwards one signal and leaves no active work after cancellation', async () => {
    const harness = createQueryTestHarness();
    const key = controlPlaneKey('skills', 'refresh');
    const started = Promise.withResolvers<AbortSignal>();
    const pending = harness.fetch({
      key,
      policy: webQueryPolicies.boundedControlPlane,
      resolve: ({ signal }) => {
        started.resolve(signal);
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });
    const outcome = pending.catch((error: unknown) => error);
    const observedSignal = await started.promise;

    expect(harness.activeCalls()).toHaveLength(1);
    expect(harness.calls()).toHaveLength(1);
    expect(harness.calls()[0]?.signal).toBe(observedSignal);
    expect(harness.calls()[0]?.key).toBe(key);

    await harness.cancel(key);
    const cancellation = await outcome;

    expect(isCancelledError(cancellation)).toBe(true);
    expect(observedSignal.aborted).toBe(true);
    expect(harness.activeCalls()).toEqual([]);
    expect(harness.cacheEntries()).toMatchObject([
      {
        fetchStatus: 'idle',
        key,
        status: 'pending',
      },
    ]);
  });

  test('QUERY-CORE-BOUNDED-GC: records exact calls and automatically collects inactive data', async () => {
    const harness = createQueryTestHarness();
    const key = finiteSwrKey('quota', 'codex', 'week');
    const shortGcPolicy = { ...webQueryPolicies.finiteSwr, gcTime: GC_TEST_TIME_MS };

    expect(
      await harness.fetch({
        key,
        policy: shortGcPolicy,
        resolve: ({ key: observedKey }) => ({ key: observedKey, value: 42 }),
      }),
    ).toEqual({ key, value: 42 });
    expect(harness.calls()).toHaveLength(1);
    expect(harness.calls()[0]?.key).toBe(key);
    expect(harness.cacheEntries()).toMatchObject([{ data: { key, value: 42 }, key, status: 'success' }]);

    await waitForEmptyCache(() => harness.cacheEntries().length);

    expect(harness.cacheEntries()).toEqual([]);
    expect(harness.activeCalls()).toEqual([]);
  });
});
