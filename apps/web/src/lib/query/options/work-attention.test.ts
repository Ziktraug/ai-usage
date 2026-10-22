import { describe, expect, test } from 'bun:test';
import { QueryObserver } from '@tanstack/svelte-query';
import { syntheticWorkAttentionDataset } from '../../features/work/work-attention-synthetic';
import type { WorkAttentionClient } from '../../rpc/work-attention-client';
import { createHydratedWebQueryClient } from '../client';
import { COLLECTION_FACTS_STALE_TIME_MS, webQueryPolicies } from '../policies';
import {
  WORK_ATTENTION_LIMIT,
  WorkAttentionQueryError,
  workAttentionKey,
  workAttentionQueryOptions,
  workAttentionRequest,
  workAttentionRequestFromSearch,
} from './work-attention';

const dataset = syntheticWorkAttentionDataset();

describe('Work attention Query identity and policy', () => {
  test('reads an exact project and explicit older window from the address with no default budget increase', () => {
    expect(workAttentionRequestFromSearch(new URLSearchParams('context-project=ai-usage&context-days=180'))).toEqual({
      limit: 100,
      machineId: null,
      scope: { kind: 'project-label', projectLabel: 'ai-usage' },
      sinceDays: 180,
    });
    expect(workAttentionRequestFromSearch(new URLSearchParams('context-days=Infinity'))).toEqual(
      workAttentionRequest(),
    );
    expect(workAttentionRequestFromSearch(new URLSearchParams())).toEqual(workAttentionRequest());
  });
  test('keeps scoped historical context distinct from the global page', async () => {
    const identity = {
      limit: 20,
      machineId: null,
      scope: { kind: 'checkouts' as const, checkoutPaths: ['/src/a', '/src/b'] },
      sinceDays: 180,
    };
    const seen: unknown[] = [];
    const client: WorkAttentionClient = {
      attention: (input) => {
        seen.push(input);
        return Promise.resolve({ data: dataset, ok: true });
      },
    };
    const queryClient = createHydratedWebQueryClient({ dehydratedState: { mutations: [], queries: [] } });
    try {
      await queryClient.fetchQuery(workAttentionQueryOptions(client, identity, { browser: true, enabled: true }));
      expect(seen).toEqual([identity]);
      expect(workAttentionKey(identity)).not.toEqual(workAttentionKey({ limit: 20, machineId: null }));
      expect(workAttentionKey(identity)).toEqual(
        workAttentionKey({ ...identity, scope: { kind: 'checkouts', checkoutPaths: ['/src/b', '/src/a'] } }),
      );
    } finally {
      queryClient.clear();
    }
  });
  test('lives on the collection cadence prefix with scalar identity parts', () => {
    expect(workAttentionKey(workAttentionRequest())).toEqual([
      'web',
      'collection-swr',
      'work-attention',
      'limit',
      WORK_ATTENTION_LIMIT,
      'machine',
      'all',
    ]);
    expect(workAttentionKey({ limit: 20, machineId: 'laptop' })).toEqual([
      'web',
      'collection-swr',
      'work-attention',
      'limit',
      20,
      'machine',
      'laptop',
    ]);
  });
  test('follows the named collection-facts-swr policy and only runs in the browser when enabled', () => {
    const client: WorkAttentionClient = { attention: () => Promise.resolve({ data: dataset, ok: true }) };
    const options = workAttentionQueryOptions(client, workAttentionRequest(), { browser: true, enabled: true });
    expect(options.staleTime).toBe(COLLECTION_FACTS_STALE_TIME_MS);
    expect(options.refetchOnMount).toBe(true);
    expect(options.refetchInterval).toBe(webQueryPolicies.collectionFactsSwr.refetchInterval);
    expect(options.refetchOnWindowFocus).toBe(true);
    expect(options.retry).toBe(false);
    expect(options.enabled).toBe(true);
    expect(workAttentionQueryOptions(client, workAttentionRequest(), { browser: false, enabled: true }).enabled).toBe(
      false,
    );
  });
  test('unwraps the envelope and surfaces a typed failure that keeps its tag', async () => {
    const queryClient = createHydratedWebQueryClient({ dehydratedState: { mutations: [], queries: [] } });
    const failing: WorkAttentionClient = {
      attention: () =>
        Promise.resolve({ error: { message: 'Schema 3 is older than 4.', tag: 'IncompatibleStore' }, ok: false }),
    };
    try {
      await expect(
        queryClient.fetchQuery(
          workAttentionQueryOptions(failing, workAttentionRequest(), { browser: true, enabled: true }),
        ),
      ).rejects.toMatchObject({ name: 'WorkAttentionQueryError', tag: 'IncompatibleStore' });
      const requests: unknown[] = [];
      const succeeding: WorkAttentionClient = {
        attention: (input) => {
          requests.push(input);
          return Promise.resolve({ data: dataset, ok: true });
        },
      };
      const data = await queryClient.fetchQuery(
        workAttentionQueryOptions(succeeding, { limit: 42, machineId: 'laptop' }, { browser: true, enabled: true }),
      );
      expect(data.roots.length).toBe(dataset.roots.length);
      expect(requests).toEqual([{ limit: 42, machineId: 'laptop' }]);
    } finally {
      queryClient.clear();
    }
  });
  test('a hydrated answer is served fresh without touching the client again', async () => {
    const source = createHydratedWebQueryClient({ dehydratedState: { mutations: [], queries: [] } });
    const client: WorkAttentionClient = { attention: () => Promise.resolve({ data: dataset, ok: true }) };
    await source.fetchQuery(
      workAttentionQueryOptions(client, workAttentionRequest(), { browser: true, enabled: true }),
    );
    const { dehydrate } = await import('@tanstack/svelte-query');
    const hydrated = createHydratedWebQueryClient({ dehydratedState: dehydrate(source) });
    source.clear();
    let reads = 0;
    const forbidden: WorkAttentionClient = {
      attention: () => {
        reads += 1;
        return Promise.reject(new Error('Hydrated Work must not re-read'));
      },
    };
    const options = workAttentionQueryOptions(forbidden, workAttentionRequest(), { browser: false, enabled: true });
    const observer = new QueryObserver(hydrated, options);
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      const result = await hydrated.fetchQuery(options);
      expect(result.roots.length).toBe(dataset.roots.length);
      expect(reads).toBe(0);
      expect(observer.getCurrentResult().isFetching).toBe(false);
      expect(new WorkAttentionQueryError({ message: 'x', tag: 'Unavailable' }).tag).toBe('Unavailable');
    } finally {
      unsubscribe();
      hydrated.clear();
    }
  });
  test('a browser mount of the server-rendered answer reads once per page load; a stale one is read again', async () => {
    const source = createHydratedWebQueryClient({ dehydratedState: { mutations: [], queries: [] } });
    const server: WorkAttentionClient = { attention: () => Promise.resolve({ data: dataset, ok: true }) };
    await source.fetchQuery(
      workAttentionQueryOptions(server, workAttentionRequest(), { browser: true, enabled: true }),
    );
    const { dehydrate } = await import('@tanstack/svelte-query');
    const hydrated = createHydratedWebQueryClient({ dehydratedState: dehydrate(source) });
    source.clear();
    let reads = 0;
    const browser: WorkAttentionClient = {
      attention: () => {
        reads += 1;
        return Promise.resolve({ data: dataset, ok: true });
      },
    };
    const options = workAttentionQueryOptions(browser, workAttentionRequest(), { browser: true, enabled: true });
    const mount = () => {
      const observer = new QueryObserver(hydrated, options);
      return { observer, unsubscribe: observer.subscribe(() => undefined) };
    };
    try {
      // The SSR read is the page load's read: hydration and mount do not repeat it.
      const first = mount();
      expect(first.observer.getCurrentResult().isFetching).toBe(false);
      first.unsubscribe();
      expect(reads).toBe(0);

      // Once the answer is older than the policy's stale time, the next mount reads it again.
      hydrated.setQueryData(options.queryKey, dataset, {
        updatedAt: Date.now() - COLLECTION_FACTS_STALE_TIME_MS - 1,
      });
      const second = mount();
      await hydrated.fetchQuery({ ...options, staleTime: Number.POSITIVE_INFINITY });
      await Bun.sleep(0);
      second.unsubscribe();
      expect(reads).toBe(1);
    } finally {
      hydrated.clear();
    }
  });
});
