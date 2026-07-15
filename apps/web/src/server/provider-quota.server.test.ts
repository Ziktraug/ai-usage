import { describe, expect, test } from 'bun:test';
import type { ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';
import type { ProviderQuotaRefreshResult } from '@ai-usage/report-data/provider-quota';
import { createProviderQuotaServerCoordinator } from './provider-quota.server';

const history: ProviderQuotaHistoryResult = {
  coverage: [],
  generatedAt: '2026-07-15T10:00:00.000Z',
  latest: [],
  points: [],
  skipped: 0,
  truncated: false,
};
const refresh: ProviderQuotaRefreshResult = { backfill: 'complete', latest: [], live: 'refreshed', warnings: [] };

describe('provider quota server coordinator', () => {
  test('joins concurrent refreshes while history remains independent', async () => {
    let release: ((value: ProviderQuotaRefreshResult) => void) | undefined;
    let refreshCalls = 0;
    const coordinator = createProviderQuotaServerCoordinator({
      history: async () => history,
      refresh: () => {
        refreshCalls++;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });

    const first = coordinator.refresh();
    const second = coordinator.refresh();
    expect(first).toBe(second);
    expect(await coordinator.history({ from: '2026-07-14T10:00:00.000Z', to: '2026-07-15T10:00:00.000Z' })).toBe(
      history,
    );
    release?.(refresh);
    expect(await first).toBe(refresh);
    expect(refreshCalls).toBe(1);
  });
});
