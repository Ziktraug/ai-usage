import { expect, test } from 'bun:test';
import type { ManualMergeImportResult } from '@ai-usage/usage-merge';
import type { UsageMachineFleetItem } from '@ai-usage/usage-store';
import {
  buildSyncFleetMachineViews,
  formatFleetAge,
  formatManualImportSummary,
  formatTransferBytes,
  machineFreshnessStatusLabel,
  machineLabelPresentation,
  machineLabelPresentationForSnapshot,
} from './manual-transfer-model';
import { buildSyncFleetComparisonRows } from './sync-machine-comparison-model';

const fleetItem = (
  id: string,
  label: string,
  sessionCount: number,
  lastSeenAt: string,
  newestSessionAt: string | null = lastSeenAt,
): UsageMachineFleetItem => ({
  hasLocalObservedRows: false,
  hasPortableRows: true,
  id,
  label,
  lastSeenAt,
  newestSessionAt,
  sessionCount,
});

test('formats manual transfer sizes for upload progress', () => {
  expect(formatTransferBytes(0)).toBe('0 B');
  expect(formatTransferBytes(1023)).toBe('1023 B');
  expect(formatTransferBytes(1024)).toBe('1.0 KB');
  expect(formatTransferBytes(1_572_864)).toBe('1.5 MB');
});

test('summarizes changed and unchanged usage rows after a manual import', () => {
  const result: ManualMergeImportResult = {
    generatedAt: '2026-07-11T12:00:00.000Z',
    machine: { id: 'studio-mac', label: 'Studio Mac' },
    result: {
      deleted: 5,
      fleetChanged: false,
      inserted: 2,
      superseded: 4,
      unchanged: 6,
      updated: 3,
      warnings: 0,
    },
    rows: 20,
    warnings: 0,
  };

  expect(formatManualImportSummary(result)).toBe('Imported Studio Mac: 14 changed, 6 unchanged.');
});

test('builds a current-first fleet and marks machines outside the 30-day report window stale', () => {
  const now = Date.parse('2026-07-05T12:00:00.000Z');
  const views = buildSyncFleetMachineViews(
    { id: 'current', label: 'Current machine' },
    [
      {
        id: 'peer',
        label: 'Peer machine',
        hasLocalObservedRows: false,
        hasPortableRows: true,
        lastSeenAt: '2026-06-01T12:00:00.000Z',
        newestSessionAt: '2026-05-31T12:00:00.000Z',
        sessionCount: 3,
      },
    ],
    now,
  );
  expect(views[0]).toMatchObject({ current: true, id: 'current', sessionCount: 0, stale: true });
  const peer = views.find((machine) => machine.id === 'peer');
  expect(peer).toMatchObject({ current: false, sessionCount: 3, stale: true });
});

test('keeps duplicate machine labels independent through ID-first freshness presentations', () => {
  const now = Date.parse('2026-07-05T12:00:00.000Z');

  expect([
    machineLabelPresentation({ id: 'peer-stale', label: 'Shared label', lastSeenAt: '2026-06-01T12:00:00.000Z' }, now),
    machineLabelPresentation({ id: 'peer-fresh', label: 'Shared label', lastSeenAt: '2026-07-01T12:00:00.000Z' }, now),
  ]).toEqual([
    { freshness: 'stale', label: 'Shared label · Stale', value: 'peer-stale' },
    { freshness: 'fresh', label: 'Shared label', value: 'peer-fresh' },
  ]);
});

test('labels unavailable or omitted dashboard freshness without claiming the machine is fresh', () => {
  const observedAt = Date.parse('2026-07-05T12:00:00.000Z');
  const unavailable = {
    kind: 'unavailable',
    observedAt,
    omittedMachines: 2,
    reason: 'not-captured',
    skippedRows: 1,
  } as const;

  expect(machineFreshnessStatusLabel(unavailable)).toBe('Freshness unavailable');
  expect(machineLabelPresentationForSnapshot({ id: 'peer', label: 'Peer' }, unavailable)).toEqual({
    freshness: 'unavailable',
    label: 'Peer · Freshness unavailable',
    value: 'peer',
  });

  const partial = {
    kind: 'available',
    machines: [{ id: 'known', label: 'Known', lastSeenAt: '2026-07-05T11:00:00.000Z' }],
    observedAt,
    omittedMachines: 1,
    skippedRows: 0,
  } as const;
  expect(machineFreshnessStatusLabel(partial)).toBe('Freshness unavailable');
  expect(machineLabelPresentationForSnapshot({ id: 'known', label: 'Known' }, partial).freshness).toBe('fresh');
  expect(machineLabelPresentationForSnapshot({ id: 'omitted', label: 'Omitted' }, partial).label).toBe(
    'Omitted · Freshness unavailable',
  );
});

test('formats machine freshness as a compact relative age', () => {
  const now = Date.parse('2026-07-05T12:00:00.000Z');
  expect(formatFleetAge(null, now)).toBe('No activity recorded');
  expect(formatFleetAge('2026-07-05T11:30:00.000Z', now)).toBe('30m ago');
  expect(formatFleetAge('2026-07-03T12:00:00.000Z', now)).toBe('2d ago');
});

test('builds stable current-first machine comparison rows with explicit freshness states', () => {
  const now = Date.parse('2026-07-05T12:00:00.000Z');
  const rows = buildSyncFleetComparisonRows(
    { id: 'current', label: 'Current' },
    [
      fleetItem('peer-b', 'Peer', 3, '2026-06-01T12:00:00.000Z', '2026-05-31T12:00:00.000Z'),
      fleetItem('current', 'Current', 4, '2026-07-05T11:00:00.000Z'),
      fleetItem('peer-a', 'Peer', 3, 'invalid', null),
    ],
    now,
  );

  expect(rows.map(({ current, id, sessionSharePercent }) => ({ current, id, sessionSharePercent }))).toEqual([
    { current: true, id: 'current', sessionSharePercent: 40 },
    { current: false, id: 'peer-a', sessionSharePercent: 30 },
    { current: false, id: 'peer-b', sessionSharePercent: 30 },
  ]);
  expect(rows.reduce((total, row) => total + row.sessionSharePercent, 0)).toBe(100);
  expect(rows[0]).toMatchObject({
    freshness: 'fresh',
    freshnessLabel: 'Fresh · 1h ago',
    newestSessionLabel: '1h ago',
  });
  expect(rows[1]).toMatchObject({
    freshness: 'unavailable',
    freshnessLabel: 'Freshness unavailable',
  });
  expect(rows[2]).toMatchObject({
    freshness: 'stale',
    freshnessLabel: 'Stale · 34d ago',
  });
});

test('apportions whole percentages to 100 and keeps a zero-session fleet at zero', () => {
  const now = Date.parse('2026-07-05T12:00:00.000Z');
  const rounded = buildSyncFleetComparisonRows(
    { id: 'current', label: 'Current' },
    [
      fleetItem('current', 'Current', 1, '2026-07-05T11:00:00.000Z'),
      fleetItem('peer-b', 'B', 1, '2026-07-05T11:00:00.000Z'),
      fleetItem('peer-a', 'A', 1, '2026-07-05T11:00:00.000Z'),
    ],
    now,
  );
  expect(rounded.map((row) => row.sessionSharePercent)).toEqual([34, 33, 33]);
  expect(rounded.reduce((total, row) => total + row.sessionSharePercent, 0)).toBe(100);

  const zero = buildSyncFleetComparisonRows(
    { id: 'current', label: 'Current' },
    [fleetItem('peer', 'Peer', 0, 'invalid', null)],
    now,
  );
  expect(zero.map((row) => row.id)).toEqual(['current', 'peer']);
  expect(zero.map((row) => row.sessionSharePercent)).toEqual([0, 0]);
  expect(zero[0]).toMatchObject({
    freshness: 'unavailable',
    freshnessLabel: 'Freshness unavailable',
  });
});
