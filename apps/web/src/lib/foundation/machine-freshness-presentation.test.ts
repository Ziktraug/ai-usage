import { describe, expect, test } from 'bun:test';
import {
  machineFreshnessSnapshotFromFocused,
  machineFreshnessStatusLabel,
  machineLabelPresentationForSnapshot,
} from './machine-freshness-presentation';

describe('machine freshness presentation seam', () => {
  test('projects the accepted bootstrap and keeps labels keyed by machine identity', () => {
    const snapshot = machineFreshnessSnapshotFromFocused({
      kind: 'available',
      machines: [{ id: 'machine-1', label: 'Workstation', lastSeenAt: '2026-08-01T12:00:00.000Z' }],
      observedAt: '2026-08-02T12:00:00.000Z',
      omittedMachines: 0,
      skippedRows: 0,
    });

    expect(machineFreshnessStatusLabel(snapshot)).toBeNull();
    expect(machineLabelPresentationForSnapshot({ id: 'machine-1', label: 'Alias' }, snapshot)).toEqual({
      freshness: 'fresh',
      label: 'Workstation',
      value: 'machine-1',
    });
    expect(machineLabelPresentationForSnapshot({ id: 'machine-2', label: 'Workstation' }, snapshot)).toEqual({
      freshness: 'unavailable',
      label: 'Workstation · Freshness unavailable',
      value: 'machine-2',
    });
  });
});
