import { describe, expect, test } from 'bun:test';
import { collectionSwrKey, controlPlaneKey, currentAliasKey, finiteSwrKey, immutableRevisionKey } from './keys';
import {
  COLLECTION_SWR_STALE_TIME_MS,
  DEFAULT_BOUNDED_GC_TIME_MS,
  FINITE_SWR_STALE_TIME_MS,
  queryPolicy,
  SHORT_CONTROL_GC_TIME_MS,
  SHORT_CONTROL_STALE_TIME_MS,
  webQueryPolicies,
} from './policies';

describe('Web query key and policy vocabulary', () => {
  test('defines stable typed identities for every Q0 cache family', () => {
    expect(currentAliasKey('report')).toEqual(['web', 'current-alias', 'report']);
    expect(immutableRevisionKey('session', 'revision-3', 'fingerprint-3', 'page')).toEqual([
      'web',
      'immutable-revision',
      'session',
      'revision-3',
      'fingerprint-3',
      'page',
    ]);
    expect(finiteSwrKey('skills', 'snapshot', 4)).toEqual(['web', 'finite-swr', 'skills', 'snapshot', 4]);
    expect(controlPlaneKey('sync', 'fleet', true)).toEqual(['web', 'control-plane', 'sync', 'fleet', true]);
    expect(collectionSwrKey('skill-observations', 'all')).toEqual([
      'web',
      'collection-swr',
      'skill-observations',
      'all',
    ]);
  });

  test('requires named policies with explicit lifecycle behavior and bounded collection', () => {
    expect(queryPolicy('current-alias-swr')).toBe(webQueryPolicies.currentAliasSwr);
    expect(queryPolicy('immutable-revision')).toBe(webQueryPolicies.immutableRevision);
    expect(queryPolicy('finite-swr')).toBe(webQueryPolicies.finiteSwr);
    expect(queryPolicy('bounded-control-plane')).toBe(webQueryPolicies.boundedControlPlane);
    expect(queryPolicy('collection-swr')).toBe(webQueryPolicies.collectionSwr);

    // Produced only by a background collection cycle, so neither focus nor reconnect revalidates
    // it. Mount does, because mount is the only place an invalidation that landed while nothing was
    // subscribed can still be honoured — and it costs nothing while the entry is fresh.
    expect(webQueryPolicies.collectionSwr).toMatchObject({
      gcTime: DEFAULT_BOUNDED_GC_TIME_MS,
      refetchOnMount: true,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
      retry: false,
      staleTime: COLLECTION_SWR_STALE_TIME_MS,
    });
    expect(COLLECTION_SWR_STALE_TIME_MS).toBeGreaterThan(FINITE_SWR_STALE_TIME_MS);

    expect(webQueryPolicies.currentAliasSwr).toMatchObject({
      gcTime: DEFAULT_BOUNDED_GC_TIME_MS,
      refetchOnMount: true,
      refetchOnReconnect: true,
      refetchOnWindowFocus: true,
      retry: false,
      staleTime: FINITE_SWR_STALE_TIME_MS,
    });
    expect(webQueryPolicies.immutableRevision).toMatchObject({
      gcTime: DEFAULT_BOUNDED_GC_TIME_MS,
      retry: false,
      staleTime: Number.POSITIVE_INFINITY,
    });
    expect(webQueryPolicies.finiteSwr).toMatchObject({
      gcTime: DEFAULT_BOUNDED_GC_TIME_MS,
      retry: false,
      staleTime: FINITE_SWR_STALE_TIME_MS,
    });
    expect(webQueryPolicies.boundedControlPlane).toMatchObject({
      gcTime: SHORT_CONTROL_GC_TIME_MS,
      retry: false,
      staleTime: SHORT_CONTROL_STALE_TIME_MS,
    });

    for (const selectedPolicy of Object.values(webQueryPolicies)) {
      expect(Number.isFinite(selectedPolicy.gcTime)).toBe(true);
      expect(selectedPolicy.retry).toBe(false);
    }
    for (const selectedPolicy of [
      webQueryPolicies.boundedControlPlane,
      webQueryPolicies.finiteSwr,
      webQueryPolicies.immutableRevision,
    ]) {
      expect(selectedPolicy.refetchOnReconnect).toBe(false);
      expect(selectedPolicy.refetchOnWindowFocus).toBe(false);
    }
  });
});
