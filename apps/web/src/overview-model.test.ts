import type { SerializedRow } from '@ai-usage/report-core/report-data';
import { describe, expect, test } from 'bun:test';
import { toDateInputValue } from './date-range';
import { buildCampaignViews } from './dashboard-model';
import {
  buildCalendarHeatmapData,
  buildModelMigrationData,
  buildOverviewSessionItems,
  buildOverviewRecords,
  buildPunchcardData,
  buildSessionShapeData,
  buildTopSessions,
} from './overview-model';
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

const heatDay = (data: NonNullable<ReturnType<typeof buildCalendarHeatmapData>>, day: string) =>
  data.weeks.flatMap((week) => week.days).find((cell) => cell && toDateInputValue(cell.date) === day) ?? null;

describe('overview model', () => {
  test('builds calendar heatmap data from dated sessions', () => {
    const rows = [
      row({
        sessionLabel: 'A',
        activeDate: '2026-06-10T12:00:00.000Z',
        date: '2026-06-10T12:00:00.000Z',
        costApprox: 2,
      }),
      row({
        sessionLabel: 'B',
        activeDate: '2026-06-10T15:00:00.000Z',
        date: '2026-06-10T15:00:00.000Z',
        costApprox: 3,
      }),
      row({
        sessionLabel: 'C',
        activeDate: '2026-06-11T12:00:00.000Z',
        date: '2026-06-11T12:00:00.000Z',
        costApprox: 0,
        costKnown: false,
      }),
    ];

    const data = buildCalendarHeatmapData(rows, new Date('2026-06-11T12:00:00.000Z'));
    const june10 = data ? heatDay(data, '2026-06-10') : null;

    expect(data?.useCost).toBe(true);
    expect(data?.todayKey).toBe('2026-06-11');
    expect(june10?.sessions).toBe(2);
    expect(june10?.cost).toBe(5);
    expect(june10?.level).toBeGreaterThan(0);
  });

  test('builds model migration series and paths', () => {
    const rows = [
      row({
        sessionLabel: 'GPT one',
        activeDate: '2026-06-01T12:00:00.000Z',
        date: '2026-06-01T12:00:00.000Z',
        model: 'gpt-5',
        costApprox: 5,
      }),
      row({
        sessionLabel: 'Claude',
        activeDate: '2026-06-02T12:00:00.000Z',
        date: '2026-06-02T12:00:00.000Z',
        model: 'claude-sonnet',
        costApprox: 2,
      }),
      row({
        sessionLabel: 'GPT two',
        activeDate: '2026-06-03T12:00:00.000Z',
        date: '2026-06-03T12:00:00.000Z',
        model: 'gpt-5',
        costApprox: 4,
      }),
    ];

    const data = buildModelMigrationData(rows);

    expect(data?.weekly).toBe(false);
    expect(data?.series.map((series) => series.key)).toEqual(['gpt-5', 'claude-sonnet']);
    expect(data?.grandTotal).toBe(11);
    expect(data?.paths).toHaveLength(2);
  });

  test('builds session shape chart data for timed priced rows', () => {
    const rows = [
      row({ sessionLabel: 'Short', durationMs: 60_000, costApprox: 0.1, harness: 'Codex' }),
      row({ sessionLabel: 'Medium', durationMs: 600_000, costApprox: 1, harness: 'Claude' }),
      row({ sessionLabel: 'Long', durationMs: 3_600_000, costApprox: 10, harness: 'Codex' }),
    ];

    const data = buildSessionShapeData(rows);

    expect(data?.points).toHaveLength(3);
    expect(data?.harnesses).toEqual(['Codex', 'Claude']);
    expect(data?.xPct(600_000)).toBeGreaterThan(0);
    expect(data?.yPct(1)).toBeGreaterThan(0);
  });

  test('builds punchcard density', () => {
    const rows = [
      row({
        sessionLabel: 'A',
        activeDate: '2026-06-10T12:00:00.000Z',
        date: '2026-06-10T12:00:00.000Z',
        costApprox: 2,
      }),
      row({
        sessionLabel: 'B',
        activeDate: '2026-06-10T12:30:00.000Z',
        date: '2026-06-10T12:30:00.000Z',
        costApprox: 3,
      }),
    ];

    const data = buildPunchcardData(rows);
    const cells = data?.cells.flat() ?? [];

    expect(data?.maxSessions).toBe(2);
    expect(cells.reduce((sum, cell) => sum + cell.sessions, 0)).toBe(2);
    expect(cells.reduce((sum, cell) => sum + cell.cost, 0)).toBe(5);
  });

  test('builds records and top sessions', () => {
    const rows = [
      row({
        sessionLabel: 'High',
        activeDate: '2026-06-10T12:00:00.000Z',
        date: '2026-06-10T12:00:00.000Z',
        costApprox: 10,
        durationMs: 60_000,
      }),
      row({
        sessionLabel: 'Long',
        activeDate: '2026-06-09T12:00:00.000Z',
        date: '2026-06-09T12:00:00.000Z',
        costApprox: 3,
        durationMs: 3_600_000,
      }),
      row({
        sessionLabel: 'Old',
        activeDate: '2026-06-08T12:00:00.000Z',
        date: '2026-06-08T12:00:00.000Z',
        costApprox: 1,
        durationMs: 600_000,
      }),
    ];

    const records = buildOverviewRecords(rows, rows);
    const top = buildTopSessions(rows, 2);

    expect(records?.topCost?.sessionLabel).toBe('High');
    expect(records?.longest?.sessionLabel).toBe('Long');
    expect(records?.streak).toBe(3);
    expect(top.map((item) => item.label)).toEqual(['High', 'Long']);
  });

  test('groups campaigns for top sessions and session shape without double counting children', () => {
    const campaignRoot = row({
      sessionLabel: 'Campaign root',
      activeDate: '2026-06-10T12:00:00.000Z',
      date: '2026-06-10T12:00:00.000Z',
      costApprox: 8,
      durationMs: 600_000,
      source: {
        harnessKey: 'codex',
        sourceSessionId: 'root-1',
        rootSourceSessionId: 'root-1',
        machineId: 'machine-a',
      },
    });
    const campaignChild = row({
      sessionLabel: 'Campaign child',
      activeDate: '2026-06-10T12:05:00.000Z',
      date: '2026-06-10T12:05:00.000Z',
      costApprox: 5,
      durationMs: 300_000,
      source: {
        harnessKey: 'codex',
        sourceSessionId: 'child-1',
        parentSourceSessionId: 'root-1',
        rootSourceSessionId: 'root-1',
        machineId: 'machine-a',
      },
    });
    const soloA = row({ sessionLabel: 'Solo A', costApprox: 12, durationMs: 120_000 });
    const soloB = row({ sessionLabel: 'Solo B', costApprox: 3, durationMs: 240_000 });
    const rows = [campaignRoot, campaignChild, soloA, soloB];
    const campaigns = buildCampaignViews(rows, rows);

    const items = buildOverviewSessionItems(rows, campaigns);
    const top = buildTopSessions(rows, 2, campaigns);
    const shape = buildSessionShapeData(rows, campaigns);

    expect(items.map((item) => item.label).sort()).toEqual(['Campaign root', 'Solo A', 'Solo B']);
    expect(top.map((item) => item.kind)).toEqual(['campaign', 'session']);
    expect(top.map((item) => item.costApprox)).toEqual([13, 12]);
    expect(shape?.points.map((item) => item.label).sort()).toEqual(['Campaign root', 'Solo A', 'Solo B']);
  });
});
