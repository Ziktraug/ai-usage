import { beforeAll, expect, test } from 'bun:test';
import type { ProviderQuotaHistoryPoint } from '@ai-usage/report-core/provider-quota';
import { renderQuotaHistory } from './quota';
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
