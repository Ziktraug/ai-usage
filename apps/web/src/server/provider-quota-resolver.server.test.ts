import { expect, test } from 'bun:test';
import type { ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';
import { E2E_PROVIDER_QUOTA_FIXTURE_POINT_COUNT } from '../provider-quota-e2e-fixture';
import { resolveProviderQuotaHistoryForServer } from './provider-quota-resolver.server';

const request = {
  from: '2026-07-15T08:00:00.000Z',
  to: '2026-07-15T11:00:00.000Z',
} as const;

test('serves fresh in-memory quota fixtures in E2E without loading the live SQLite reader', async () => {
  let liveLoads = 0;
  const loadLive = () => {
    liveLoads += 1;
    return Promise.reject(new Error('The live quota reader must stay isolated.'));
  };

  const first = await resolveProviderQuotaHistoryForServer(request, 'e2e', loadLive);
  const second = await resolveProviderQuotaHistoryForServer(request, 'e2e', loadLive);

  expect(first.points).toHaveLength(E2E_PROVIDER_QUOTA_FIXTURE_POINT_COUNT);
  expect(new Set(first.points.map(({ providerKey }) => providerKey))).toEqual(
    new Set(['claude', 'codex', 'older-provider']),
  );
  expect(first).not.toBe(second);
  expect(first.points).not.toBe(second.points);
  expect(liveLoads).toBe(0);
});

test('rejects demo quota reads before loading the live adapter', async () => {
  let liveLoads = 0;

  await expect(
    resolveProviderQuotaHistoryForServer(request, 'demo', () => {
      liveLoads += 1;
      return Promise.reject(new Error('Unexpected live reader load.'));
    }),
  ).rejects.toBeInstanceOf(Response);
  expect(liveLoads).toBe(0);
});

test('delegates validated live quota requests to the query-only adapter', async () => {
  let received: unknown;
  const fixture: ProviderQuotaHistoryResult = {
    coverage: [],
    generatedAt: '2026-07-15T11:00:00.000Z',
    latest: [],
    points: [],
    skipped: 0,
    truncated: false,
  };

  const result = await resolveProviderQuotaHistoryForServer(request, 'live', () =>
    Promise.resolve((value) => {
      received = value;
      return Promise.resolve(fixture);
    }),
  );

  expect(result).toBe(fixture);
  expect(received).toEqual({ ...request, maximumPoints: 1000 });
});
