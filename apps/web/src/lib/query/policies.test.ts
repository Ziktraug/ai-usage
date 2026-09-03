import { describe, expect, test } from 'bun:test';
import {
  SKILL_OBSERVATION_PRODUCER_MAX_AGE_MS,
  SKILL_OBSERVATION_PRODUCER_READ_MAX_AGE_MS,
} from '@ai-usage/report-core/skill-observation-evidence';
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

    // The answer contains a time-bounded producer-completeness proof. It must therefore revalidate
    // when that proof can expire, even if no collection event arrives, and on focus after a tab was
    // suspended. Reconnect remains event-driven.
    expect(webQueryPolicies.collectionSwr).toMatchObject({
      gcTime: DEFAULT_BOUNDED_GC_TIME_MS,
      refetchInterval: COLLECTION_SWR_STALE_TIME_MS,
      refetchOnMount: 'always',
      refetchOnReconnect: false,
      refetchOnWindowFocus: true,
      retry: false,
      staleTime: COLLECTION_SWR_STALE_TIME_MS,
    });
    expect(COLLECTION_SWR_STALE_TIME_MS).toBeGreaterThan(FINITE_SWR_STALE_TIME_MS);
    expect(SKILL_OBSERVATION_PRODUCER_READ_MAX_AGE_MS + COLLECTION_SWR_STALE_TIME_MS).toBe(
      SKILL_OBSERVATION_PRODUCER_MAX_AGE_MS,
    );

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
