import { beforeAll, expect, test } from 'bun:test';
import type { ProviderQuotaHistoryPoint } from '@ai-usage/report-core/provider-quota';
import {
  isProviderStatusDataset,
  type ProviderStatus,
  providerStatusWithFreshness,
} from '@ai-usage/report-core/provider-status';
import { providerStatusWithFeedFreshness, quotaStatusDataset, renderQuotaHistory, renderQuotaJson } from './quota';
import { setColor } from './render/colors';

const ANSI_ESCAPE = String.fromCharCode(27);

const point = (
  input: Partial<ProviderQuotaHistoryPoint> & Pick<ProviderQuotaHistoryPoint, 'firstObservedAt' | 'usedPercent'>,
): ProviderQuotaHistoryPoint => ({
  accountScope: null,
  blocked: false,
  group: '5h',
  lastObservedAt: input.firstObservedAt,
  limitSeconds: 18_000,
  machineId: 'machine-1',
  machineLabel: 'Laptop',
  providerKey: 'codex',
  providerLabel: 'Codex',
  resetAt: '2026-07-15T12:00:00.000Z',
  source: { confidence: 'authoritative', key: 'codex-app-server', mode: 'poll' },
  windowId: 'codex:5h',
  windowLabel: '5h',
  ...input,
});

const CLAUDE = { providerKey: 'claude', providerLabel: 'Claude' } as const;

// Two providers x two windows, with one collection gap inside the Claude 5h window: the points share
// a resetAt so the segmenter breaks on the 35-minute hole rather than on a reset.
const twoProviderHistory: ProviderQuotaHistoryPoint[] = [
  point({
    ...CLAUDE,
    firstObservedAt: '2026-07-15T09:00:00.000Z',
    resetAt: '2026-07-15T13:00:00.000Z',
    usedPercent: 22,
    windowId: 'claude:5h',
  }),
  point({
    ...CLAUDE,
    firstObservedAt: '2026-07-15T09:05:00.000Z',
    resetAt: '2026-07-15T13:00:00.000Z',
    usedPercent: 30,
    windowId: 'claude:5h',
  }),
  point({
    ...CLAUDE,
    firstObservedAt: '2026-07-15T09:40:00.000Z',
    resetAt: '2026-07-15T13:00:00.000Z',
    usedPercent: 68,
    windowId: 'claude:5h',
  }),
  point({
    ...CLAUDE,
    firstObservedAt: '2026-07-15T09:00:00.000Z',
    group: 'weekly',
    resetAt: '2026-07-21T00:00:00.000Z',
    usedPercent: 61,
    windowId: 'claude:weekly',
    windowLabel: 'Weekly',
  }),
  point({
    ...CLAUDE,
    firstObservedAt: '2026-07-15T09:05:00.000Z',
    group: 'weekly',
    resetAt: '2026-07-21T00:00:00.000Z',
    usedPercent: 63,
    windowId: 'claude:weekly',
    windowLabel: 'Weekly',
  }),
  point({ firstObservedAt: '2026-07-15T09:00:00.000Z', usedPercent: 10 }),
  point({ firstObservedAt: '2026-07-15T09:05:00.000Z', usedPercent: 14 }),
  point({
    firstObservedAt: '2026-07-15T09:00:00.000Z',
    group: 'weekly',
    resetAt: '2026-07-21T00:00:00.000Z',
    usedPercent: 40,
    windowId: 'codex:weekly',
    windowLabel: 'Weekly',
  }),
  point({
    firstObservedAt: '2026-07-15T09:05:00.000Z',
    group: 'weekly',
    resetAt: '2026-07-21T00:00:00.000Z',
    usedPercent: 41,
    windowId: 'codex:weekly',
    windowLabel: 'Weekly',
  }),
];

beforeAll(() => {
  setColor(false);
});

test('groups quota history by provider then window and reports each trend endpoint', () => {
  const output = renderQuotaHistory(twoProviderHistory, '7d');

  const claudeHeading = output.indexOf('═══ Claude subscription quota — last 7d ═══');
  const codexHeading = output.indexOf('═══ Codex subscription quota — last 7d ═══');
  expect(claudeHeading).toBeGreaterThanOrEqual(0);
  expect(codexHeading).toBeGreaterThan(claudeHeading);

  // Window order inside a provider is the shared label order, so 5h precedes Weekly.
  const claudeSection = output.slice(claudeHeading, codexHeading);
  expect(claudeSection.indexOf('5h')).toBeLessThan(claudeSection.indexOf('Weekly'));

  expect(output).toContain('22% → 68%');
  expect(output).toContain('61% → 63%');
  expect(output).toContain('10% → 14%');
  expect(output).toContain('40% → 41%');
});

test('marks the collection gap only in the window that actually has one', () => {
  const output = renderQuotaHistory(twoProviderHistory, '7d');
  const codexHeading = output.indexOf('═══ Codex subscription quota — last 7d ═══');
  const claudeSection = output.slice(0, codexHeading);
  const codexSection = output.slice(codexHeading);

  expect(claudeSection).toContain('·gap·');
  expect(codexSection).not.toContain('·gap·');
});

test('explains an empty range instead of drawing an empty chart', () => {
  expect(renderQuotaHistory([], '24h')).toBe('No stored provider quota history in the last 24h.');
});

test('does not present a partial read with no surviving points as an absent history', () => {
  // Skipping every corrupt row leaves the same empty array as a store that never recorded anything.
  // Collapsing the two would tell the reader nothing exists when observations were in fact dropped.
  const partial = renderQuotaHistory([], '24h', { partial: true });

  expect(partial).toBe(
    'Stored provider quota history in the last 24h is partial; no valid observations could be rendered.',
  );
  expect(partial).not.toBe(renderQuotaHistory([], '24h'));
});

test('states that history is read-only so the reader knows it is not a fresh reading', () => {
  expect(renderQuotaHistory(twoProviderHistory, '30d')).toContain(
    "Read from stored observations only. Run 'ai-usage quota' for a fresh reading.",
  );
});

test('emits no ANSI escapes when color is disabled', () => {
  setColor(false);
  expect(renderQuotaHistory(twoProviderHistory, '7d')).not.toContain(ANSI_ESCAPE);
});

test('prefers the authoritative reading when two sources describe the same instant', () => {
  const output = renderQuotaHistory(
    [
      point({ firstObservedAt: '2026-07-15T09:00:00.000Z', usedPercent: 20 }),
      // Backfilled rollout point for the same instant as the live reading below.
      point({
        firstObservedAt: '2026-07-15T09:05:00.000Z',
        source: { confidence: 'historical', key: 'codex-rollout', mode: 'backfill' },
        usedPercent: 91,
      }),
      point({ firstObservedAt: '2026-07-15T09:05:00.000Z', usedPercent: 44 }),
    ],
    '7d',
  );

  expect(output).toContain('20% → 44%');
  expect(output).not.toContain('91%');
});

test('still marks a collection gap that straddles a quota reset', () => {
  // The shared segmenter reports breakReason 'reset' here because resetAt also changed, so trusting
  // it alone would draw a two-hour hiatus as continuous history.
  const output = renderQuotaHistory(
    [
      point({ firstObservedAt: '2026-07-15T09:00:00.000Z', usedPercent: 80 }),
      point({ firstObservedAt: '2026-07-15T11:00:00.000Z', resetAt: '2026-07-15T18:00:00.000Z', usedPercent: 5 }),
    ],
    '7d',
  );

  expect(output).toContain('·gap·');
});

test('distinguishes same-window rows that differ only by account scope', () => {
  const output = renderQuotaHistory(
    [
      point({ accountScope: 'team', firstObservedAt: '2026-07-15T09:00:00.000Z', usedPercent: 20 }),
      point({ accountScope: 'team', firstObservedAt: '2026-07-15T09:05:00.000Z', usedPercent: 24 }),
      point({ accountScope: 'personal', firstObservedAt: '2026-07-15T09:00:00.000Z', usedPercent: 70 }),
      point({ accountScope: 'personal', firstObservedAt: '2026-07-15T09:05:00.000Z', usedPercent: 74 }),
    ],
    '7d',
  );

  expect(output).toContain('personal');
  expect(output).toContain('team');
});

test('falls through to the window id when machine and account are identical', () => {
  // The shape real Codex data takes: one machine, no account scope, two windows sharing a label.
  const output = renderQuotaHistory(
    [
      point({ firstObservedAt: '2026-07-15T09:00:00.000Z', usedPercent: 20, windowId: 'codex:primary' }),
      point({ firstObservedAt: '2026-07-15T09:05:00.000Z', usedPercent: 24, windowId: 'codex:primary' }),
      point({ firstObservedAt: '2026-07-15T09:00:00.000Z', usedPercent: 70, windowId: 'codex:secondary' }),
      point({ firstObservedAt: '2026-07-15T09:05:00.000Z', usedPercent: 74, windowId: 'codex:secondary' }),
    ],
    '7d',
  );

  expect(output).toContain('codex:primary');
  expect(output).toContain('codex:secondary');
  // The shared machine label names nothing here, so it must not be the qualifier.
  expect(output).not.toContain('Laptop');
});

test('says so when the read was truncated or skipped rows', () => {
  const partial = renderQuotaHistory(twoProviderHistory, '7d', { partial: true });
  const complete = renderQuotaHistory(twoProviderHistory, '7d');

  expect(partial).toContain('History is partial or contains skipped observations.');
  expect(complete).not.toContain('History is partial');
});

test('falls back to the machine id when two machines share a label', () => {
  const output = renderQuotaHistory(
    [
      point({ firstObservedAt: '2026-07-15T09:00:00.000Z', machineId: 'machine-a', usedPercent: 20 }),
      point({ firstObservedAt: '2026-07-15T09:05:00.000Z', machineId: 'machine-a', usedPercent: 24 }),
      point({ firstObservedAt: '2026-07-15T09:00:00.000Z', machineId: 'machine-b', usedPercent: 70 }),
      point({ firstObservedAt: '2026-07-15T09:05:00.000Z', machineId: 'machine-b', usedPercent: 74 }),
    ],
    '7d',
  );

  expect(output).toContain('machine-a');
  expect(output).toContain('machine-b');
});

test('keeps the sparkline column bounded when history is heavily fragmented', () => {
  // Ten observations a day apart: every neighbour is a gap, far more than the row can draw.
  const sparse = Array.from({ length: 10 }, (_unused, index) =>
    point({
      firstObservedAt: new Date(Date.parse('2026-07-05T09:00:00.000Z') + index * 86_400_000).toISOString(),
      usedPercent: index * 9,
    }),
  );

  const row = renderQuotaHistory(sparse, '30d')
    .split('\n')
    .find((line) => line.includes('→')) as string;
  const sparkline = row.slice(row.indexOf('5h') + '5h'.length, row.indexOf('→') - '  0% '.length);
  expect(sparkline.trim().length).toBeLessThanOrEqual(24);
  expect(row).toContain('·gap·');
});

const FEED_NOW = new Date('2026-07-15T12:00:00.000Z');

const providerStatus = (
  input: Partial<ProviderStatus> & Pick<ProviderStatus, 'generatedAt' | 'key' | 'label' | 'source'>,
): ProviderStatus => ({
  machineId: 'machine-1',
  plan: 'pro',
  state: 'ok',
  windows: [
    {
      blocked: false,
      group: '5h',
      id: 'primary',
      label: '5h',
      limitSeconds: 18_000,
      remainingPercent: 60,
      resetsAt: '2026-07-15T14:00:00.000Z',
      scope: 'global',
      usedPercent: 40,
    },
  ],
  ...input,
});

// A live reading 20 minutes old is past the 15-minute budget; the session-log reading is two days old,
// which the feed also calls stale; the fresh live reading stays as observed.
const feedProviders: ProviderStatus[] = [
  providerStatus({ generatedAt: '2026-07-15T11:40:00.000Z', key: 'codex', label: 'Codex', source: 'live-api' }),
  providerStatus({
    generatedAt: '2026-07-13T12:00:00.000Z',
    key: 'claude',
    label: 'Claude',
    source: 'local-history',
  }),
  providerStatus({
    generatedAt: '2026-07-15T11:58:00.000Z',
    key: 'codex:team',
    label: 'Codex',
    source: 'live-api',
    state: 'partial',
  }),
];

const TWO_DAYS_OLD = '2026-07-13T12:00:00.000Z';
const TWENTY_MINUTES_OLD = '2026-07-15T11:40:00.000Z';
const TWO_MINUTES_OLD = '2026-07-15T11:58:00.000Z';

test('holds live and session-log readings to the same fifteen-minute feed budget', () => {
  for (const source of ['live-api', 'local-history'] as const) {
    const fresh = providerStatus({ generatedAt: TWO_MINUTES_OLD, key: 'codex', label: 'Codex', source });
    const old = providerStatus({ generatedAt: TWENTY_MINUTES_OLD, key: 'codex', label: 'Codex', source });

    expect(providerStatusWithFeedFreshness(fresh, FEED_NOW).state).toBe('ok');
    expect(providerStatusWithFeedFreshness(old, FEED_NOW)).toEqual({ ...old, state: 'stale' });
  }
});

test('is stricter than the report freshness, which never ages a session-log reading', () => {
  const sessionLog = providerStatus({
    generatedAt: TWO_DAYS_OLD,
    key: 'codex',
    label: 'Codex',
    source: 'local-history',
  });

  expect(providerStatusWithFreshness(sessionLog, FEED_NOW).state).toBe('ok');
  expect(providerStatusWithFeedFreshness(sessionLog, FEED_NOW).state).toBe('stale');
});

test('leaves manual and unsupported readings and already-terminal states as stored', () => {
  for (const source of ['manual', 'unsupported'] as const) {
    const provider = providerStatus({ generatedAt: TWO_DAYS_OLD, key: 'codex', label: 'Codex', source });

    expect(providerStatusWithFeedFreshness(provider, FEED_NOW)).toBe(provider);
  }
  // `unsupported` is also a state (Claude without rate limits); aging it would replace that reason with `stale`.
  for (const state of ['error', 'auth-required', 'stale', 'unsupported'] as const) {
    for (const source of ['live-api', 'local-history'] as const) {
      const provider = providerStatus({ generatedAt: TWO_DAYS_OLD, key: 'codex', label: 'Codex', source, state });

      expect(providerStatusWithFeedFreshness(provider, FEED_NOW)).toBe(provider);
    }
  }
});

test('projects the quota feed as a versioned provider-status dataset stamped with the read time', () => {
  const dataset = quotaStatusDataset(feedProviders, FEED_NOW);

  expect(dataset.schemaVersion).toBe(1);
  expect(dataset.generatedAt).toBe('2026-07-15T12:00:00.000Z');
  expect(isProviderStatusDataset(dataset)).toBe(true);
});

test('applies freshness with the injected clock and preserves provider order', () => {
  const dataset = quotaStatusDataset(feedProviders, FEED_NOW);

  expect(dataset.providers.map(({ key }) => key)).toEqual(['codex', 'claude', 'codex:team']);
  expect(dataset.providers.map(({ state }) => state)).toEqual(['stale', 'stale', 'partial']);
  // The observation time is the provider's, never the read time.
  expect(dataset.providers.map(({ generatedAt }) => generatedAt)).toEqual(
    feedProviders.map(({ generatedAt }) => generatedAt),
  );
  expect(feedProviders[0]?.state).toBe('ok');
});

test('judges freshness against the clock it is given rather than the wall clock', () => {
  const earlier = quotaStatusDataset(feedProviders, new Date('2026-07-15T11:50:00.000Z'));

  expect(earlier.providers[0]?.state).toBe('ok');
});

test('projects an empty store read as an empty provider list', () => {
  expect(quotaStatusDataset([], FEED_NOW)).toEqual({
    generatedAt: '2026-07-15T12:00:00.000Z',
    providers: [],
    schemaVersion: 1,
  });
});

test('renders the quota feed as indented JSON with no ANSI escapes even when colour is forced', () => {
  setColor(true);
  try {
    const output = renderQuotaJson(quotaStatusDataset(feedProviders, FEED_NOW));

    expect(output).not.toContain(ANSI_ESCAPE);
    expect(output).toBe(JSON.stringify(quotaStatusDataset(feedProviders, FEED_NOW), null, 2));
    expect(JSON.parse(output)).toEqual(quotaStatusDataset(feedProviders, FEED_NOW));
  } finally {
    setColor(false);
  }
});
