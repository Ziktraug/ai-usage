import { describe, expect, test } from 'bun:test';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import { projectSessionPage } from '@ai-usage/report-core/session-query';
import {
  buildCampaignTableItems,
  buildCampaignTableRows,
  buildCampaignViews,
  buildDashboardMetrics,
  buildModelGroups,
  buildPreviousPeriodSummary,
  buildProjectGroupRows,
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

const sourcedRow = (sessionId: string, overrides: Partial<SerializedRow> = {}) =>
  row({
    name: sessionId,
    sessionLabel: sessionId,
    source: {
      harnessKey: 'codex',
      sourceSessionId: sessionId,
      rootSourceSessionId: sessionId,
      machineId: 'machine-a',
      machineLabel: 'Machine A',
      ...overrides.source,
    },
    ...overrides,
  });

describe('dashboard model', () => {
  test('filters timeline rows from a search snapshot', () => {
    const rows = [
      row({ name: 'Alpha build', sessionLabel: 'Alpha build', project: 'alpha', harness: 'Codex' }),
      row({
        name: 'Beta review',
        sessionLabel: 'Beta review',
        project: 'beta',
        harness: 'Claude',
        provider: 'Claude sub',
      }),
    ];

    const filtered = filterTimelineRows(rows, createFilterSnapshot('alpha', ['Codex'], [], { project: 'alpha' }));

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

  test('groups projects by the native projected project name from the report payload', () => {
    const bounds: DateBounds = { from: null, to: null };
    const rows = [
      row({
        project: 'exalibur · Machine A',
        rawProject: 'exalibur',
        source: {
          harnessKey: 'codex',
          sourceSessionId: 'machine-a-session',
          machineId: 'machine-a',
          machineLabel: 'Machine A',
        },
      }),
      row({
        project: 'exalibur · Machine B',
        rawProject: 'exalibur',
        source: {
          harnessKey: 'codex',
          sourceSessionId: 'machine-b-session',
          machineId: 'machine-b',
          machineLabel: 'Machine B',
        },
      }),
      row({
        project: 'exalibur',
        rawProject: 'exalibur2',
        source: {
          harnessKey: 'codex',
          sourceSessionId: 'aliased-session',
          machineId: 'machine-c',
          machineLabel: 'Machine C',
        },
      }),
    ];

    const groups = buildProjectGroupRows(rows, bounds);

    expect(groups.map((group) => group.key).sort()).toEqual([
      'exalibur',
      'exalibur · Machine A',
      'exalibur · Machine B',
    ]);
  });

  test('groups model rows by shared base model identity', () => {
    const bounds: DateBounds = { from: null, to: null };
    const rows = [
      row({ model: 'openai/gpt-5.4', costApprox: 2 }),
      row({ model: 'cursor/gpt-5.4-high', costApprox: 3 }),
      row({ model: 'gpt-5-codex', costApprox: 5 }),
    ];

    const groups = buildModelGroups(rows, bounds, 10);

    const gpt54 = groups.find((group) => group.key === 'gpt-5.4');
    expect(gpt54?.sessions).toBe(2);
    expect(gpt54?.costSum).toBe(5);
    expect(groups.find((group) => group.key === 'gpt-5-codex')?.sessions).toBe(1);
  });

  test('builds campaign views by machine and root source id without merging rows', () => {
    const parent = sourcedRow('parent', { costApprox: 4, tokenTotal: 40, freshTokens: 30 });
    const child = sourcedRow('child', {
      costApprox: 2,
      tokenTotal: 20,
      freshTokens: 15,
      source: {
        harnessKey: 'codex',
        sourceSessionId: 'child',
        parentSourceSessionId: 'parent',
        rootSourceSessionId: 'parent',
        machineId: 'machine-a',
      },
    });
    const sameIdsOtherMachine = sourcedRow('child', {
      source: {
        harnessKey: 'codex',
        sourceSessionId: 'child',
        parentSourceSessionId: 'parent',
        rootSourceSessionId: 'parent',
        machineId: 'machine-b',
      },
    });

    const campaigns = buildCampaignViews([parent, child, sameIdsOtherMachine], [parent, child, sameIdsOtherMachine]);

    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]?.campaignKey).toBe('machine-a:codex:parent');
    expect(campaigns[0]?.root).toBe(parent);
    expect(campaigns[0]?.allRows).toEqual([parent, child]);
    expect(campaigns[0]?.visibleTotals.totalCost).toBe(6);
    expect(campaigns[0]?.visibleTotals.tokenTotal).toBe(60);
  });

  test('keeps the root as context when only a child matches filters', () => {
    const parent = sourcedRow('parent', { costApprox: 10, tokenTotal: 100, freshTokens: 90 });
    const child = sourcedRow('child', {
      costApprox: 3,
      tokenTotal: 30,
      freshTokens: 20,
      source: {
        harnessKey: 'codex',
        sourceSessionId: 'child',
        parentSourceSessionId: 'parent',
        rootSourceSessionId: 'parent',
        machineId: 'machine-a',
      },
    });

    const campaign = buildCampaignViews([parent, child], [child])[0];

    expect(campaign?.root).toBe(parent);
    expect(campaign?.visibleRows).toEqual([child]);
    expect(campaign?.visibleChildren).toEqual([child]);
    expect(campaign?.visibleCount).toBe(1);
    expect(campaign?.totalCount).toBe(2);
    expect(campaign?.visibleTotals.totalCost).toBe(3);
    expect(campaign?.allTotals.totalCost).toBe(13);
  });

  test('builds grouped table items that remove visible children from the root level and sort by visible totals', () => {
    const parent = sourcedRow('campaign parent', { costApprox: 1, tokenTotal: 10, freshTokens: 10 });
    const child = sourcedRow('campaign child', {
      costApprox: 9,
      tokenTotal: 90,
      freshTokens: 90,
      source: {
        harnessKey: 'codex',
        sourceSessionId: 'campaign child',
        parentSourceSessionId: 'campaign parent',
        rootSourceSessionId: 'campaign parent',
        machineId: 'machine-a',
      },
    });
    const standalone = row({
      name: 'standalone',
      sessionLabel: 'standalone',
      costApprox: 5,
      tokenTotal: 50,
      freshTokens: 50,
    });

    const grouped = buildCampaignTableItems(
      [parent, child, standalone],
      [parent, child, standalone],
      [{ id: 'cost', desc: true }],
      true,
    );
    const flat = buildCampaignTableItems(
      [parent, child, standalone],
      [parent, child, standalone],
      [{ id: 'cost', desc: true }],
      false,
    );

    expect(
      grouped.map((item) => (item.kind === 'campaign' ? item.campaign.root.sessionLabel : item.row.sessionLabel)),
    ).toEqual(['campaign parent', 'standalone']);
    expect(grouped[0]?.kind).toBe('campaign');
    expect(grouped[0]?.kind === 'campaign' ? grouped[0].campaign.visibleTotals.totalCost : 0).toBe(10);
    expect(flat.map((item) => item.row.sessionLabel)).toEqual(['campaign child', 'standalone', 'campaign parent']);
  });

  test('sorts campaigns by latest visible activity for date sorting', () => {
    const firstParent = sourcedRow('first parent', {
      activeDate: '2026-06-10T12:00:00.000Z',
      date: '2026-06-10T12:00:00.000Z',
    });
    const firstChild = sourcedRow('first child', {
      activeDate: '2026-06-12T12:00:00.000Z',
      date: '2026-06-12T12:00:00.000Z',
      source: {
        harnessKey: 'codex',
        sourceSessionId: 'first child',
        parentSourceSessionId: 'first parent',
        rootSourceSessionId: 'first parent',
        machineId: 'machine-a',
      },
    });
    const secondParent = sourcedRow('second parent', {
      activeDate: '2026-06-11T12:00:00.000Z',
      date: '2026-06-11T12:00:00.000Z',
      source: {
        harnessKey: 'codex',
        sourceSessionId: 'second parent',
        rootSourceSessionId: 'second parent',
        machineId: 'machine-a',
      },
    });
    const secondChild = sourcedRow('second child', {
      activeDate: '2026-06-11T13:00:00.000Z',
      date: '2026-06-11T13:00:00.000Z',
      source: {
        harnessKey: 'codex',
        sourceSessionId: 'second child',
        parentSourceSessionId: 'second parent',
        rootSourceSessionId: 'second parent',
        machineId: 'machine-a',
      },
    });

    const items = buildCampaignTableItems(
      [firstParent, firstChild, secondParent, secondChild],
      [firstParent, firstChild, secondParent, secondChild],
      [{ id: 'date', desc: true }],
      true,
    );

    expect(items.map((item) => item.row.sessionLabel)).toEqual(['first parent', 'second parent']);
  });

  test('projects campaign table rows with aggregate metrics and latest visible date', () => {
    const parent = sourcedRow('parent', {
      activeDate: '2026-06-10T12:00:00.000Z',
      costApprox: 1,
      date: '2026-06-10T12:00:00.000Z',
      freshTokens: 10,
      tokenTotal: 10,
    });
    const child = sourcedRow('child', {
      activeDate: '2026-06-12T12:00:00.000Z',
      costApprox: 4,
      date: '2026-06-12T12:00:00.000Z',
      freshTokens: 40,
      tokenTotal: 40,
      source: {
        harnessKey: 'codex',
        sourceSessionId: 'child',
        parentSourceSessionId: 'parent',
        rootSourceSessionId: 'parent',
        machineId: 'machine-a',
      },
    });

    const rows = buildCampaignTableRows([parent, child], [parent, child], [{ id: 'date', desc: true }], true);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionLabel).toBe('parent');
    expect(rows[0]?.campaignVisibleCount).toBe(2);
    expect(rows[0]?.campaignTotalCount).toBe(2);
    expect(rows[0]?.activeDate).toBe('2026-06-12T12:00:00.000Z');
    expect(rows[0]?.sortDate).toBe(child.sortDate);
    expect(rows[0]?.costApprox).toBe(5);
    expect(rows[0]?.freshTokens).toBe(50);
    expect(rows[0]?.children?.map((row) => row.sessionLabel)).toEqual(['child']);
  });

  test('keeps the focused report-core session page projection in fixture parity', () => {
    const parent = sourcedRow('campaign parent', { costApprox: 1, freshTokens: 10, tokenTotal: 10 });
    const child = sourcedRow('campaign child', {
      costApprox: 9,
      freshTokens: 90,
      source: {
        harnessKey: 'codex',
        machineId: 'machine-a',
        parentSourceSessionId: 'campaign parent',
        rootSourceSessionId: 'campaign parent',
        sourceSessionId: 'campaign child',
      },
      tokenTotal: 90,
    });
    const standalone = row({ costApprox: 5, name: 'standalone', sessionLabel: 'standalone' });
    const input = [parent, child, standalone];
    const sorting: { desc: boolean; id: 'cost' }[] = [{ desc: true, id: 'cost' }];

    const legacyRows = buildCampaignTableRows(input, input, sorting, true).map(
      ({ children: _children, ...item }) => item,
    );
    const focusedPage = projectSessionPage(input, {
      campaigns: true,
      cursor: null,
      filters: { fields: {}, harness: [], machine: [], query: '' },
      pageSize: 200,
      range: { from: null, to: null },
      revision: 'fixture-revision',
      sort: sorting,
    });

    expect(focusedPage.items.map((item) => item.row)).toEqual(legacyRows);
    expect(focusedPage.itemCount).toBe(2);
    expect(focusedPage.sessionCount).toBe(3);
  });

  test('reuses prepared campaign views when projecting table rows', () => {
    const parent = sourcedRow('prepared parent', { costApprox: 1 });
    const child = sourcedRow('prepared child', {
      costApprox: 4,
      source: {
        harnessKey: 'codex',
        machineId: 'machine-a',
        parentSourceSessionId: 'prepared parent',
        rootSourceSessionId: 'prepared parent',
        sourceSessionId: 'prepared child',
      },
    });
    const campaigns = buildCampaignViews([parent, child], [parent, child]);

    const rows = buildCampaignTableRows([], [parent, child], [{ id: 'cost', desc: true }], true, campaigns);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.campaignTotalCount).toBe(2);
    expect(rows[0]?.costApprox).toBe(5);
  });
});
