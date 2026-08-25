import type { ProviderQuotaHistoryPoint, ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';

interface FixtureQuotaPointInput {
  readonly at: string;
  /** When the store coalesced this reading, the instant its identical run stopped being extended. */
  readonly heldUntil?: string;
  readonly providerKey?: string;
  readonly providerLabel?: string;
  readonly resetAt: string;
  readonly sourceKey?: string;
  readonly usedPercent: number;
  readonly window: '5h' | 'weekly';
}

const fixtureQuotaPoint = (input: FixtureQuotaPointInput): ProviderQuotaHistoryPoint => {
  const providerKey = input.providerKey ?? 'codex';
  return {
    accountScope: 'fixture-account',
    blocked: false,
    firstObservedAt: input.at,
    group: input.window,
    lastObservedAt: input.heldUntil ?? input.at,
    limitSeconds: input.window === '5h' ? 18_000 : 604_800,
    machineId: 'fixture-machine',
    machineLabel: 'Fixture Machine',
    providerKey,
    providerLabel: input.providerLabel ?? 'Codex',
    resetAt: input.resetAt,
    source: { confidence: 'authoritative', key: input.sourceKey ?? 'codex-app-server', mode: 'poll' },
    usedPercent: input.usedPercent,
    windowId: `${providerKey}:${input.window}`,
    windowLabel: input.window === '5h' ? '5h' : 'Weekly',
  };
};

const CLAUDE_FIXTURE_PROVIDER = {
  providerKey: 'claude',
  providerLabel: 'Claude',
  sourceKey: 'claude-agent-sdk',
} as const;

const OLDER_FIXTURE_PROVIDER = {
  providerKey: 'older-provider',
  providerLabel: 'Older provider',
  sourceKey: 'older-provider-fixture',
} as const;

const FIXTURE_POINT_INPUTS = [
  { at: '2026-07-15T09:00:00.000Z', resetAt: '2026-07-15T12:00:00.000Z', usedPercent: 22, window: '5h' },
  { at: '2026-07-15T09:05:00.000Z', resetAt: '2026-07-15T12:00:00.000Z', usedPercent: 28, window: '5h' },
  { at: '2026-07-15T09:30:00.000Z', resetAt: '2026-07-15T12:00:00.000Z', usedPercent: 35, window: '5h' },
  { at: '2026-07-15T09:35:00.000Z', resetAt: '2026-07-15T17:00:00.000Z', usedPercent: 4, window: '5h' },
  { at: '2026-07-15T09:00:00.000Z', resetAt: '2026-07-21T00:00:00.000Z', usedPercent: 61, window: 'weekly' },
  { at: '2026-07-15T09:35:00.000Z', resetAt: '2026-07-21T00:00:00.000Z', usedPercent: 63, window: 'weekly' },
  {
    ...CLAUDE_FIXTURE_PROVIDER,
    at: '2026-07-15T09:10:00.000Z',
    resetAt: '2026-07-15T13:00:00.000Z',
    usedPercent: 12,
    window: '5h',
  },
  {
    ...CLAUDE_FIXTURE_PROVIDER,
    at: '2026-07-15T09:15:00.000Z',
    resetAt: '2026-07-15T13:00:00.000Z',
    usedPercent: 19,
    window: '5h',
  },
  {
    ...CLAUDE_FIXTURE_PROVIDER,
    at: '2026-07-15T09:15:00.000Z',
    resetAt: '2026-07-22T00:00:00.000Z',
    usedPercent: 44,
    window: 'weekly',
  },
  {
    ...OLDER_FIXTURE_PROVIDER,
    at: '2026-07-10T09:00:00.000Z',
    resetAt: '2026-07-10T14:00:00.000Z',
    usedPercent: 37,
    window: '5h',
  },
  // Observed before the 24h window opens and held into it: the store's anchor row. At `24h` the
  // drawer must carry it in as a held value rather than stretch its axis back two days; at `7d` it
  // is an ordinary in-range point.
  {
    at: '2026-07-13T08:00:00.000Z',
    heldUntil: '2026-07-15T08:55:00.000Z',
    resetAt: '2026-07-13T12:00:00.000Z',
    usedPercent: 48,
    window: '5h',
  },
] as const satisfies readonly FixtureQuotaPointInput[];

/**
 * How many points the fixture below carries, published on its own so client code can gate on
 * "quota history exists in e2e" without pulling the fixture data into the browser bundle — the
 * report entry has a measured gzip budget, and importing the factory costs ~370 gzipped bytes.
 * The annotation is the drift guard: it is the tuple's literal length, so adding or removing a
 * fixture point without updating this number fails typecheck rather than silently re-opening the
 * empty-drawer bug the gate exists to prevent.
 */
export const E2E_PROVIDER_QUOTA_FIXTURE_POINT_COUNT: (typeof FIXTURE_POINT_INPUTS)['length'] = 11;

export const createE2EProviderQuotaHistoryFixture = (): ProviderQuotaHistoryResult => ({
  coverage: [],
  generatedAt: '2026-07-15T10:40:00.000Z',
  latest: [],
  points: FIXTURE_POINT_INPUTS.map((input) => fixtureQuotaPoint(input)),
  skipped: 0,
  truncated: false,
});
