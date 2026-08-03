import { describe, expect, test } from 'bun:test';
import type { FocusedOverviewSessionItem, FocusedSessionShape } from '@ai-usage/report-core/focused-report-query';
import { presentSessionShape, sessionShapePosition } from './session-shape-model';

const item = (label: string): FocusedOverviewSessionItem => ({
  costApprox: 4,
  costKnown: true,
  durationMs: 60_000,
  harness: 'Codex',
  kind: 'campaign',
  label,
  row: { rowId: label } as FocusedOverviewSessionItem['row'],
  sessionCount: 2,
});

const shape = (): FocusedSessionShape => ({
  harnesses: ['Codex'],
  harnessSummaries: [],
  outliers: [item('Derived campaign')],
  points: [{ ...item('Derived campaign'), aggregateCount: 3 }],
  totalPoints: 3,
  xDomain: { max: 6, min: 0 },
  xTicks: [],
  yDomain: { max: 3, min: -3 },
  yTicks: [],
});

describe('P2 Session Shape model', () => {
  test('keeps log-scaled points inside the accepted plot insets', () => {
    expect(sessionShapePosition(shape(), 1000, 0.001)).toEqual({ x: 50, y: 92 });
    expect(sessionShapePosition(shape(), 1_000_000, 1000)).toEqual({ x: 96, y: 8 });
  });

  test('applies campaign language to points and outliers without losing aggregate counts', () => {
    const presented = presentSessionShape(shape(), (entry) => ({ ...entry, label: 'Renamed campaign' }));
    expect(presented.points[0]).toMatchObject({ aggregateCount: 3, label: 'Renamed campaign' });
    expect(presented.outliers[0]?.label).toBe('Renamed campaign');
  });
});
