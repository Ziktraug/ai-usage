import type { SerializedRow } from '@ai-usage/core/report-data';
import { describe, expect, test } from 'bun:test';
import {
  buildDashboardMetrics,
  buildPreviousPeriodSummary,
  buildSortedDashboardRows,
  buildVisibleSummary,
  createFilterSnapshot,
  filterRowsByDateBounds,
  filterTimelineRows,
} from './dashboard-model';
import type { DateBounds } from './date-range';
import { enrichReportRow } from './shared';

const baseRow: SerializedRow = {
  date: '2026-06-10T12:00:00.000Z',
  endDate: null,
  activeDate: '2026-06-10T12:00:00.000Z',
  harness: 'Codex',
  provider: 'Codex API',
  name: 'Base session',
  sessionLabel: 'Base session',
  model: 'gpt-5',
  project: 'alpha',
  tokIn: 10,
  tokOut: 5,
  tokCr: 3,
  tokCw: 2,
  tokenTotal: 20,
  freshTokens: 17,
  costActual: 1,
  costApprox: 1,
  costKnown: true,
  calls: 1,
  durationMs: 60_000,
  turns: 2,
  tools: 3,
  linesAdded: 4,
  linesDeleted: 1,
  lineDelta: 5,
};

const row = (overrides: Partial<SerializedRow> = {}) => enrichReportRow({ ...baseRow, ...overrides });

describe('dashboard model', () => {
  test('filters timeline rows from a search snapshot', () => {
    const rows = [
      row({ name: 'Alpha build', sessionLabel: 'Alpha build', project: 'alpha', harness: 'Codex' }),
      row({ name: 'Beta review', sessionLabel: 'Beta review', project: 'beta', harness: 'Claude', provider: 'Claude sub' }),
    ];

    const filtered = filterTimelineRows(rows, createFilterSnapshot('alpha', 'Codex', { project: 'alpha' }));

    expect(filtered.map((item) => item.sessionLabel)).toEqual(['Alpha build']);
  });

  test('builds visible and previous summaries from date bounds', () => {
    const rows = [
      row({
        name: 'Current expensive',
        sessionLabel: 'Current expensive',
        activeDate: '2026-06-10T12:00:00.000Z',
        date: '2026-06-10T12:00:00.000Z',
        costApprox: 2,
        freshTokens: 30,
      }),
      row({
        name: 'Previous day',
        sessionLabel: 'Previous day',
        activeDate: '2026-06-09T12:00:00.000Z',
        date: '2026-06-09T12:00:00.000Z',
        costApprox: 1,
        freshTokens: 15,
      }),
      row({
        name: 'Older day',
        sessionLabel: 'Older day',
        activeDate: '2026-06-08T12:00:00.000Z',
        date: '2026-06-08T12:00:00.000Z',
        costApprox: 5,
        freshTokens: 50,
      }),
    ];
    const bounds: DateBounds = {
      from: new Date('2026-06-10T00:00:00.000Z'),
      to: new Date('2026-06-10T23:59:59.999Z'),
    };

    expect(filterRowsByDateBounds(rows, bounds).map((item) => item.sessionLabel)).toEqual(['Current expensive']);

    const summary = buildVisibleSummary(rows, bounds);
    const previous = buildPreviousPeriodSummary(rows, bounds, new Date('2026-06-11T12:00:00.000Z'));
    const metrics = buildDashboardMetrics(summary, previous);

    expect(summary.sessionCount).toBe(1);
    expect(summary.totalCost).toBe(2);
    expect(summary.fresh).toBe(30);
    expect(previous?.sessionCount).toBe(1);
    expect(previous?.totalCost).toBe(1);
    expect(metrics.find((metric) => metric.label === 'API value')?.delta?.pct).toBe(100);
  });

  test('sorts export rows without mutating the filtered row order', () => {
    const rows = [
      row({ name: 'Low cost', sessionLabel: 'Low cost', costApprox: 1 }),
      row({ name: 'High cost', sessionLabel: 'High cost', costApprox: 5 }),
    ];

    const sorted = buildSortedDashboardRows(rows, [{ id: 'cost', desc: true }]);

    expect(sorted.map((item) => item.sessionLabel)).toEqual(['High cost', 'Low cost']);
    expect(rows.map((item) => item.sessionLabel)).toEqual(['Low cost', 'High cost']);
  });
});
