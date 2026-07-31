import type { ProviderQuotaHistoryPoint, ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';

const fixtureQuotaPoint = (input: {
  readonly at: string;
  readonly resetAt: string;
  readonly usedPercent: number;
  readonly window: '5h' | 'weekly';
}): ProviderQuotaHistoryPoint => ({
  accountScope: 'fixture-account',
  blocked: false,
  firstObservedAt: input.at,
  group: input.window,
  lastObservedAt: input.at,
  limitSeconds: input.window === '5h' ? 18_000 : 604_800,
  machineId: 'fixture-machine',
  machineLabel: 'Fixture Machine',
  providerKey: 'codex',
  providerLabel: 'Codex',
  resetAt: input.resetAt,
  source: { confidence: 'authoritative', key: 'codex-app-server', mode: 'poll' },
  usedPercent: input.usedPercent,
  windowId: `codex:${input.window}`,
  windowLabel: input.window === '5h' ? '5h' : 'Weekly',
});

export const createE2EProviderQuotaHistoryFixture = (): ProviderQuotaHistoryResult => ({
  coverage: [],
  generatedAt: '2026-07-15T10:40:00.000Z',
  latest: [],
  points: [
    fixtureQuotaPoint({
      at: '2026-07-15T09:00:00.000Z',
      resetAt: '2026-07-15T12:00:00.000Z',
      usedPercent: 22,
      window: '5h',
    }),
    fixtureQuotaPoint({
      at: '2026-07-15T09:05:00.000Z',
      resetAt: '2026-07-15T12:00:00.000Z',
      usedPercent: 28,
      window: '5h',
    }),
    fixtureQuotaPoint({
      at: '2026-07-15T09:30:00.000Z',
      resetAt: '2026-07-15T12:00:00.000Z',
      usedPercent: 35,
      window: '5h',
    }),
    fixtureQuotaPoint({
      at: '2026-07-15T09:35:00.000Z',
      resetAt: '2026-07-15T17:00:00.000Z',
      usedPercent: 4,
      window: '5h',
    }),
    fixtureQuotaPoint({
      at: '2026-07-15T09:00:00.000Z',
      resetAt: '2026-07-21T00:00:00.000Z',
      usedPercent: 61,
      window: 'weekly',
    }),
    fixtureQuotaPoint({
      at: '2026-07-15T09:35:00.000Z',
      resetAt: '2026-07-21T00:00:00.000Z',
      usedPercent: 63,
      window: 'weekly',
    }),
  ],
  skipped: 0,
  truncated: false,
});
