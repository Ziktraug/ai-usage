import { describe, expect, it } from 'bun:test';
import type { SyncFleet } from '@ai-usage/web-contract/sync';
import { createHydratedWebQueryClient } from '../../query/client';
import { syncFleetKey, syncFleetQueryOptions } from '../../query/options/sync';
import { loadSyncPageData, SYNC_COMPATIBLE_GENERATION } from './sync-load';

const fleet: SyncFleet = {
  currentMachine: { id: 'machine-a', label: 'Machine A' },
  machines: [
    {
      hasLocalObservedRows: true,
      hasPortableRows: false,
      id: 'machine-a',
      label: 'Machine A',
      lastSeenAt: '2026-08-03T00:00:00.000Z',
      newestSessionAt: '2026-08-02T00:00:00.000Z',
      sessionCount: 3,
    },
  ],
  omittedMachines: 0,
  skipped: 0,
};

describe('Sync SSR load identity', () => {
  it('uses one stable compatibility generation for SSR and hydration', () => {
    expect(SYNC_COMPATIBLE_GENERATION).toBe('sync-fleet:v1');
    expect(syncFleetKey(SYNC_COMPATIBLE_GENERATION)).toEqual([
      'web',
      'control-plane',
      'sync',
      'fleet',
      'compatible-generation',
      'sync-fleet:v1',
    ]);
  });

  it('awaits once, dehydrates, and serves a fresh hydrated client without a duplicate fleet acquisition', async () => {
    let fleetCalls = 0;
    const client = {
      fleet: () => {
        fleetCalls += 1;
        return Promise.resolve(fleet);
      },
    };
    const data = await loadSyncPageData(
      {
        fetch: () => Promise.reject(new Error('Injected Sync client owns this acquisition.')),
        url: new URL('http://sync.invalid/sync'),
      },
      { createClient: () => client, now: () => 42 },
    );

    expect(fleetCalls).toBe(1);
    expect(data.renderedAt).toBe(42);
    expect(data.queryState.dehydratedState.queries).toHaveLength(1);
    expect(data.queryState.dehydratedState.queries[0]?.queryKey).toEqual(syncFleetKey(SYNC_COMPATIBLE_GENERATION));

    const hydratedClient = createHydratedWebQueryClient(data.queryState);
    expect(hydratedClient.getQueryData<SyncFleet>(syncFleetKey(SYNC_COMPATIBLE_GENERATION))).toEqual(fleet);
    expect(
      await hydratedClient.fetchQuery(
        syncFleetQueryOptions(client, {
          browser: true,
          compatibleGeneration: SYNC_COMPATIBLE_GENERATION,
          enabled: true,
        }),
      ),
    ).toEqual(fleet);
    expect(fleetCalls).toBe(1);
  });
});
