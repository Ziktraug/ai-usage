import { describe, expect, test } from 'bun:test';
import { controlPlaneKey, currentAliasKey, finiteSwrKey, immutableRevisionKey } from './keys';
import {
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
  });

  test('requires named policies with explicit lifecycle behavior and bounded collection', () => {
    expect(queryPolicy('current-alias')).toBe(webQueryPolicies.currentAlias);
    expect(queryPolicy('immutable-revision')).toBe(webQueryPolicies.immutableRevision);
    expect(queryPolicy('finite-swr')).toBe(webQueryPolicies.finiteSwr);
    expect(queryPolicy('bounded-control-plane')).toBe(webQueryPolicies.boundedControlPlane);

    expect(webQueryPolicies.currentAlias).toMatchObject({
      gcTime: DEFAULT_BOUNDED_GC_TIME_MS,
      retry: false,
      staleTime: Number.POSITIVE_INFINITY,
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
      expect(selectedPolicy.refetchOnReconnect).toBe(false);
      expect(selectedPolicy.refetchOnWindowFocus).toBe(false);
      expect(selectedPolicy.retry).toBe(false);
    }
  });
});
