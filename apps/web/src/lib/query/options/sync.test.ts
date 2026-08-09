import { describe, expect, test } from 'bun:test';
import type { SyncFleet } from '@ai-usage/web-contract/sync';
import { QueryObserver } from '@tanstack/svelte-query';
import type { SyncBrowserAdapter } from '../../rpc/sync-client';
import { createWebQueryClient } from '../client';
import { currentAliasKey } from '../keys';
import { webQueryPolicies } from '../policies';
import { skillsSnapshotKey } from './skills';
import { invalidateSyncFleet, syncFleetKey, syncFleetQueryOptions } from './sync';

const fleet: SyncFleet = {
  currentMachine: { id: 'machine-a', label: 'Machine A' },
  machines: [],
  omittedMachines: 0,
  skipped: 0,
};

describe('Sync fleet query options', () => {
  test('QUERY-SYNC-FLEET: uses generation-scoped finite SWR, exact signals, and excludes manual bytes', async () => {
    const signals: AbortSignal[] = [];
    let downloads = 0;
    let fleetCalls = 0;
    const adapter: SyncBrowserAdapter = {
      downloadManualMerge: () => {
        downloads += 1;
        return Promise.reject(new Error('Manual downloads are outside Query.'));
      },
      fleet: (signal) => {
        fleetCalls += 1;
        if (signal) {
          signals.push(signal);
        }
        return Promise.resolve(fleet);
      },
    };
    const serverDisabled = syncFleetQueryOptions(adapter, {
      browser: false,
      compatibleGeneration: 'store-v1',
      enabled: true,
    });
    const businessDisabled = syncFleetQueryOptions(adapter, {
      browser: true,
      compatibleGeneration: 'store-v1',
      enabled: false,
    });

    expect(serverDisabled).toMatchObject({
      enabled: false,
      gcTime: webQueryPolicies.boundedControlPlane.gcTime,
      queryKey: syncFleetKey('store-v1'),
      retry: false,
      staleTime: webQueryPolicies.boundedControlPlane.staleTime,
    });
    expect(syncFleetKey('store-v1')).not.toEqual(syncFleetKey('store-v2'));
    expect(JSON.stringify(serverDisabled.queryKey)).not.toContain('download');

    const queryClient = createWebQueryClient();
    const serverObserver = new QueryObserver(queryClient, serverDisabled);
    const businessObserver = new QueryObserver(queryClient, businessDisabled);
    const unsubscribeServer = serverObserver.subscribe(() => undefined);
    const unsubscribeBusiness = businessObserver.subscribe(() => undefined);
    await Promise.resolve();
    expect(fleetCalls).toBe(0);
    unsubscribeServer();
    unsubscribeBusiness();

    await expect(
      queryClient.fetchQuery(
        syncFleetQueryOptions(adapter, { browser: true, compatibleGeneration: 'store-v1', enabled: true }),
      ),
    ).resolves.toEqual(fleet);
    expect(fleetCalls).toBe(1);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(downloads).toBe(0);
  });

  test('invalidates and refetches only the completed generation fleet key', async () => {
    const queryClient = createWebQueryClient();
    const counts = { first: 0, second: 0 };
    const firstKey = syncFleetKey('store-v1');
    const secondKey = syncFleetKey('store-v2');
    queryClient.setQueryData(firstKey, fleet, { updatedAt: Date.now() });
    queryClient.setQueryData(secondKey, fleet, { updatedAt: Date.now() });
    const firstObserver = new QueryObserver(queryClient, {
      ...webQueryPolicies.boundedControlPlane,
      queryFn: () => {
        counts.first += 1;
        return fleet;
      },
      queryKey: firstKey,
    });
    const secondObserver = new QueryObserver(queryClient, {
      ...webQueryPolicies.boundedControlPlane,
      queryFn: () => {
        counts.second += 1;
        return fleet;
      },
      queryKey: secondKey,
    });
    const unsubscribeFirst = firstObserver.subscribe(() => undefined);
    const unsubscribeSecond = secondObserver.subscribe(() => undefined);

    await invalidateSyncFleet(queryClient, 'store-v1');
    expect(counts).toEqual({ first: 1, second: 0 });
    expect(queryClient.getQueryState(secondKey)?.isInvalidated).toBe(false);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  test('publication invalidation maps to zero Skills and Sync keys', async () => {
    const queryClient = createWebQueryClient();
    const counts = { skills: 0, sync: 0 };
    const skillsKey = skillsSnapshotKey();
    const syncKey = syncFleetKey('store-v1');
    queryClient.setQueryData(skillsKey, { value: 'skills' }, { updatedAt: Date.now() });
    queryClient.setQueryData(syncKey, fleet, { updatedAt: Date.now() });
    const skillsObserver = new QueryObserver(queryClient, {
      ...webQueryPolicies.finiteSwr,
      queryFn: () => {
        counts.skills += 1;
        return { value: 'skills' };
      },
      queryKey: skillsKey,
    });
    const syncObserver = new QueryObserver(queryClient, {
      ...webQueryPolicies.boundedControlPlane,
      queryFn: () => {
        counts.sync += 1;
        return fleet;
      },
      queryKey: syncKey,
    });
    const unsubscribeSkills = skillsObserver.subscribe(() => undefined);
    const unsubscribeSync = syncObserver.subscribe(() => undefined);

    await queryClient.invalidateQueries({ exact: true, queryKey: currentAliasKey('report') });
    expect(counts).toEqual({ skills: 0, sync: 0 });
    expect(queryClient.getQueryState(skillsKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(syncKey)?.isInvalidated).toBe(false);
    unsubscribeSkills();
    unsubscribeSync();
  });
});
