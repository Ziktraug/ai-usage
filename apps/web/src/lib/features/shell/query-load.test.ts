import { describe, expect, test } from 'bun:test';
import { createWebQueryClient, hydrateWebQueryClient } from '../../query/client';
import { finiteSwrKey } from '../../query/keys';
import { createAwaitedRouteQueryState } from './query-load';

const invalidRpcResponse = (): Response => Response.json({ invalid: true });
const optionsFor = (port: number) => ({
  fetch: () => Promise.resolve(invalidRpcResponse()),
  url: new URL(`http://127.0.0.1:${port}/`),
});

describe('Svelte route Query hydration', () => {
  test('awaits request-owned prefetches and dehydrates isolated clients', async () => {
    const firstKey = finiteSwrKey('route-prefetch', 'first');
    const secondKey = finiteSwrKey('route-prefetch', 'second');
    let releaseFirst: (() => void) | undefined;
    let firstSettled = false;
    const firstStatePromise = createAwaitedRouteQueryState(optionsFor(41_101), async ({ queryClient }) => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      queryClient.setQueryData(firstKey, 'first');
    }).then((state) => {
      firstSettled = true;
      return state;
    });
    const secondState = await createAwaitedRouteQueryState(optionsFor(41_102), ({ queryClient }) => {
      queryClient.setQueryData(secondKey, 'second');
      return Promise.resolve();
    });

    expect(firstSettled).toBe(false);
    releaseFirst?.();
    const firstState = await firstStatePromise;
    const firstClient = hydrateWebQueryClient(createWebQueryClient(), firstState);
    const secondClient = hydrateWebQueryClient(createWebQueryClient(), secondState);

    expect(firstClient.getQueryData<string>(firstKey)).toBe('first');
    expect(firstClient.getQueryData(secondKey)).toBeUndefined();
    expect(secondClient.getQueryData<string>(secondKey)).toBe('second');
    expect(secondClient.getQueryData(firstKey)).toBeUndefined();
    firstClient.clear();
    secondClient.clear();
  });

  test('propagates a critical prefetch error without returning partial state', async () => {
    const failure = new Error('synthetic route prefetch failure');
    await expect(createAwaitedRouteQueryState(optionsFor(41_103), () => Promise.reject(failure))).rejects.toBe(failure);
  });
});
