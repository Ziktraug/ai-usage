import { describe, expect, test } from 'bun:test';
import { projectFocusedOverview } from '@ai-usage/report-core/focused-report-query';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import { projectSessionPage, type SessionQueryFilters } from '@ai-usage/report-core/session-query';
import type { DateBounds } from '../../../date-range';
import { demoReportPayload } from '../../../report-data';
import { enrichReportRow } from '../../../shared';
import type { ReportSummary } from '../presentation/report-value';
import {
  buildCampaignTableItems,
  buildCampaignTableRows,
  buildCampaignViews,
  buildDashboardMetrics,
  buildHarnessProviderGroups,
  buildModelGroups,
  buildPreviousPeriodBounds,
  buildPreviousPeriodSummary,
  buildProjectGroupRows,
  buildSortedDashboardRows,
  buildVisibleSummary,
  comparePeriodMetric,
  createFilterSnapshot,
  filterRowsByDateBounds,
  filterTimelineRows,
  machineFilterOptionsForRows,
  type PeriodBaseline,
  type PeriodBaselineInput,
  type PeriodRecordedHistory,
  periodRecordedHistory,
  previousPeriodWindow,
  processedTokensReading,
  resolvePeriodBaseline,
  totalApiValueReading,
} from './dashboard-model';

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

  test('keeps a session with no origin in every origin selection', () => {
    const unclassified = row({ name: 'Unclassified', originProvenance: 'origin-unsupported' });
    const selections = [[], ['human'], ['subagent'], ['classifier'], ['human', 'subagent']] as const;

    for (const selection of selections) {
      const filtered = filterTimelineRows([unclassified], createFilterSnapshot('', [], [], {}, [...selection]));
      expect(filtered).toEqual([unclassified]);
    }
  });

  test('filters duplicate machine labels by stable machine ID', () => {
    const rows = [
      sourcedRow('machine-a', {
        source: {
          harnessKey: 'codex',
          machineId: 'machine-a',
          machineLabel: 'Shared machine',
          rootSourceSessionId: 'machine-a',
          sourceSessionId: 'machine-a',
        },
      }),
      sourcedRow('machine-b', {
        source: {
          harnessKey: 'codex',
          machineId: 'machine-b',
          machineLabel: 'Shared machine',
          rootSourceSessionId: 'machine-b',
          sourceSessionId: 'machine-b',
        },
      }),
    ];
    const filtered = filterTimelineRows(rows, createFilterSnapshot('', [], ['machine-b'], {}));
    expect(filtered.map((item) => item.sessionLabel)).toEqual(['machine-b']);
    expect(machineFilterOptionsForRows(rows)).toEqual([
      { label: 'Shared machine', value: 'machine-a' },
      { label: 'Shared machine', value: 'machine-b' },
    ]);
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
    expect(metrics.find((metric) => metric.label === 'Subscription value')?.value).toBe('$0.00');
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
        project: 'exalibur — Machine A',
        projectGroupId: 'source:machine-a|/work/exalibur',
        projectSourceId: 'machine-a|/work/exalibur',
        rawProject: 'exalibur',
        source: {
          harnessKey: 'codex',
          sourceSessionId: 'machine-a-session',
          machineId: 'machine-a',
          machineLabel: 'Machine A',
        },
      }),
      row({
        project: 'exalibur — Machine B',
        projectGroupId: 'source:machine-b|/work/exalibur',
        projectSourceId: 'machine-b|/work/exalibur',
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
        projectGroupId: 'group:exalibur',
        projectSourceId: 'machine-c|/work/exalibur2',
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

    expect(
      groups.map(({ key, label }) => ({ key, label })).sort((left, right) => left.key.localeCompare(right.key)),
    ).toEqual([
      { key: 'group:exalibur', label: 'exalibur' },
      { key: 'source:machine-a|/work/exalibur', label: 'exalibur — Machine A' },
      { key: 'source:machine-b|/work/exalibur', label: 'exalibur — Machine B' },
    ]);
  });

  test('preserves complete, partial, absent, and measured-zero project line coverage', () => {
    const bounds: DateBounds = { from: null, to: null };
    const rows = [
      row({ project: 'complete', linesAdded: 3, linesDeleted: 1 }),
      row({ project: 'complete', linesAdded: 0, linesDeleted: 2 }),
      row({ project: 'partial', linesAdded: 4, linesDeleted: 1 }),
      row({ project: 'partial', linesAdded: null, linesDeleted: 2 }),
      row({ project: 'unmeasured', linesAdded: null, linesDeleted: null }),
      row({ project: 'measured-zero', linesAdded: 0, linesDeleted: 0 }),
    ];

    const lineGroups = Object.fromEntries(
      buildProjectGroupRows(rows, bounds).map(({ key, lineMeasurement, linesAdded, linesDeleted }) => [
        key,
        { lineMeasurement, linesAdded, linesDeleted },
      ]),
    );

    expect(lineGroups).toEqual({
      complete: {
        lineMeasurement: { measuredSessions: 2, totalSessions: 2 },
        linesAdded: 3,
        linesDeleted: 3,
      },
      'measured zero': {
        lineMeasurement: { measuredSessions: 1, totalSessions: 1 },
        linesAdded: 0,
        linesDeleted: 0,
      },
      partial: {
        lineMeasurement: { measuredSessions: 1, totalSessions: 2 },
        linesAdded: 4,
        linesDeleted: 1,
      },
      unmeasured: {
        lineMeasurement: { measuredSessions: 0, totalSessions: 1 },
        linesAdded: 0,
        linesDeleted: 0,
      },
    });
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

  test('builds exact harness-provider groups for the local dashboard fallback', () => {
    const bounds: DateBounds = { from: null, to: null };
    const rows = [
      row({ costApprox: 1, harness: 'Codex', provider: 'Codex API' }),
      row({ costApprox: 2, harness: 'Codex', provider: 'Anthropic' }),
      row({ costApprox: 3, harness: 'Claude Code', provider: 'Anthropic' }),
    ];

    expect(
      buildHarnessProviderGroups(rows, bounds, 6).map(({ harness, provider, sessions }) => ({
        harness,
        provider,
        sessions,
      })),
    ).toEqual([
      { harness: 'Claude Code', provider: 'Anthropic', sessions: 1 },
      { harness: 'Codex', provider: 'Anthropic', sessions: 1 },
      { harness: 'Codex', provider: 'Codex API', sessions: 1 },
    ]);
  });

  test('builds campaign views by machine and root source id without merging rows', () => {
    const parent = sourcedRow('parent', { costApprox: 4, tokenTotal: 40, freshTokens: 30 });
    const child = sourcedRow('child', {
      costApprox: 2,
      costKnown: false,
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

    expect(campaigns).toHaveLength(2);
    const primaryCampaign = campaigns.find((campaign) => campaign.campaignKey === 'machine-a:codex:parent');
    const orphanCampaign = campaigns.find((campaign) => campaign.campaignKey === 'machine-b:codex:parent');
    expect(primaryCampaign?.root).toBe(parent);
    expect(primaryCampaign?.allRows).toEqual([parent, child]);
    expect(primaryCampaign?.visibleTotals.totalCost).toBe(6);
    expect(primaryCampaign?.visibleTotals.priceMeasurement).toEqual({
      knownCost: 6,
      state: 'partially measured',
      unpricedFreshTokens: 17,
    });
    expect(primaryCampaign?.visibleTotals.tokenTotal).toBe(60);
    expect(orphanCampaign?.root).toBe(sameIdsOtherMachine);
    expect(orphanCampaign?.visibleCount).toBe(1);
  });

  test('applies a campaign label without changing identity or aggregate values', () => {
    const parent = sourcedRow('parent', { costApprox: 4, tokenTotal: 40 });
    const child = sourcedRow('child', {
      costApprox: 2,
      source: {
        harnessKey: 'codex',
        machineId: 'machine-a',
        parentSourceSessionId: 'parent',
        rootSourceSessionId: 'parent',
        sourceSessionId: 'child',
      },
    });
    const rows = [parent, child];
    const baselineCampaigns = buildCampaignViews(rows, rows);
    const renamedCampaigns = buildCampaignViews(rows, rows, (campaignKey, derivedLabel) =>
      campaignKey === 'machine-a:codex:parent' ? 'Release train' : derivedLabel,
    );

    const baselineCampaign = baselineCampaigns[0];
    const renamedCampaign = renamedCampaigns[0];
    const baselineRow = buildCampaignTableRows(rows, rows, [], baselineCampaigns)[0];
    const renamedRow = buildCampaignTableRows(rows, rows, [], renamedCampaigns)[0];

    expect(renamedCampaign?.label).toBe('Release train');
    expect(renamedCampaign?.campaignKey).toBe(baselineCampaign?.campaignKey);
    expect(renamedCampaign?.root).toBe(baselineCampaign?.root);
    expect(renamedCampaign?.allTotals).toEqual(baselineCampaign?.allTotals);
    expect(renamedCampaign?.visibleTotals).toEqual(baselineCampaign?.visibleTotals);
    expect(baselineRow?.sessionLabel).toBe('parent');
    expect(renamedRow?.sessionLabel).toBe('Release train');
    expect(renamedRow?.campaignKey).toBe(baselineRow?.campaignKey);
    expect(renamedRow?.costApprox).toBe(baselineRow?.costApprox);
  });

  test('filters campaign origins before rolling classifier usage into the parent and keeps singletons', () => {
    const parent = sourcedRow('parent', { freshTokens: 30, origin: 'human' });
    const child = sourcedRow('child', {
      freshTokens: 15,
      origin: 'subagent',
      source: {
        harnessKey: 'codex',
        machineId: 'machine-a',
        parentSourceSessionId: 'parent',
        rootSourceSessionId: 'parent',
        sourceSessionId: 'child',
      },
    });
    const classifier = sourcedRow('classifier-review', {
      freshTokens: 5,
      origin: 'classifier',
      source: {
        harnessKey: 'codex',
        machineId: 'machine-a',
        parentSourceSessionId: 'parent',
        rootSourceSessionId: 'parent',
        sourceSessionId: 'classifier-review',
      },
    });
    const singleton = row({ name: 'singleton', sessionLabel: 'singleton' });
    const campaignKey = 'machine-a:codex:parent';
    const allRows = [parent, child, classifier, singleton];
    const visible = filterTimelineRows(
      allRows,
      createFilterSnapshot('', [], [], { campaign: campaignKey }, ['human', 'subagent']),
    );
    const campaign = buildCampaignViews(allRows, visible)[0];

    expect(visible).toEqual([parent, child]);
    expect(campaign).toMatchObject({
      allClassifiers: [classifier],
      campaignKey,
      totalCount: 3,
      visibleCount: 2,
      visibleTotals: { freshTokens: 50 },
    });
    expect(buildCampaignViews([singleton], [singleton])).toMatchObject([
      { root: singleton, totalCount: 1, visibleCount: 1 },
    ]);
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

  test('builds only campaign table items, including a campaign of one, sorted by visible totals', () => {
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

    const items = buildCampaignTableItems(
      [parent, child, standalone],
      [parent, child, standalone],
      [{ id: 'cost', desc: true }],
    );

    expect(items.map((item) => item.campaign.root.sessionLabel)).toEqual(['campaign parent', 'standalone']);
    expect(items.every((item) => item.kind === 'campaign')).toBe(true);
    expect(items[0]?.campaign.visibleTotals.totalCost).toBe(10);
    expect(items[1]?.campaign.visibleCount).toBe(1);
  });

  test('preserves a human root on a singleton campaign display row', () => {
    const humanRoot = sourcedRow('human singleton', { origin: 'human', subagent: false });

    const rows = buildCampaignTableRows([humanRoot], [humanRoot], [{ id: 'date', desc: true }]);

    expect(rows[0]?.subagent).toBe(false);
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

    const rows = buildCampaignTableRows([parent, child], [parent, child], [{ id: 'date', desc: true }]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionLabel).toBe('parent');
    expect(rows[0]?.campaignVisibleCount).toBe(2);
    expect(rows[0]?.campaignTotalCount).toBe(2);
    expect(rows[0]?.activeDate).toBe('2026-06-12T12:00:00.000Z');
    expect(rows[0]?.sortDate).toBe(child.sortDate);
    expect(rows[0]?.costApprox).toBe(5);
    expect(rows[0]?.freshTokens).toBe(50);
    expect(rows[0]?.children?.map((childRow) => childRow.sessionLabel)).toEqual(['child']);
  });

  test('projects a campaign date from matched rows rather than a later classifier rollup', () => {
    const parent = sourcedRow('parent', {
      activeDate: '2026-07-16T08:00:00.000Z',
      date: '2026-07-16T08:00:00.000Z',
      origin: 'human',
    });
    const child = sourcedRow('child', {
      activeDate: '2026-07-15T10:00:00.000Z',
      date: '2026-07-15T10:00:00.000Z',
      origin: 'subagent',
      source: {
        harnessKey: 'codex',
        machineId: 'machine-a',
        parentSourceSessionId: 'parent',
        rootSourceSessionId: 'parent',
        sourceSessionId: 'child',
      },
    });
    const classifier = sourcedRow('review', {
      activeDate: '2026-07-18T09:00:00.000Z',
      date: '2026-07-18T09:00:00.000Z',
      origin: 'classifier',
      source: {
        harnessKey: 'codex',
        machineId: 'machine-a',
        parentSourceSessionId: 'parent',
        rootSourceSessionId: 'parent',
        sourceSessionId: 'review',
      },
    });

    const rows = buildCampaignTableRows([parent, child, classifier], [child], [{ id: 'date', desc: true }]);

    expect(rows[0]?.activeDate).toBe(child.activeDate);
    expect(rows[0]?.sortDate).toBe(child.sortDate);
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

    const legacyRows = buildCampaignTableRows(input, input, sorting).map(({ children: _children, ...item }) => item);
    const focusedPage = projectSessionPage(input, {
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

    const rows = buildCampaignTableRows([], [parent, child], [{ id: 'cost', desc: true }], campaigns);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.campaignTotalCount).toBe(2);
    expect(rows[0]?.costApprox).toBe(5);
  });
});

describe('period-over-period comparison', () => {
  const generatedAt = new Date('2026-06-11T12:00:00.000Z');
  /** A closed seven-day selection: 4 June 00:00 to 10 June 23:59:59.999. */
  const week: DateBounds = {
    from: new Date('2026-06-04T00:00:00.000Z'),
    to: new Date('2026-06-10T23:59:59.999Z'),
  };
  const weekBefore = {
    from: new Date('2026-05-28T00:00:00.001Z'),
    to: new Date('2026-06-03T23:59:59.999Z'),
  };
  const datedRow = (name: string, activeDate: string, overrides: Partial<SerializedRow> = {}) =>
    row({ activeDate, date: activeDate, name, sessionLabel: name, ...overrides });
  const summaryOf = (...rows: ReturnType<typeof row>[]): ReportSummary =>
    buildVisibleSummary(rows, { from: null, to: null });
  const everyHarness = (first: Date): PeriodRecordedHistory => ({ first, limitedToHarnesses: [] });
  const baselineFor = (overrides: Partial<PeriodBaselineInput<ReportSummary>> = {}): PeriodBaseline<ReportSummary> =>
    resolvePeriodBaseline({
      bounds: week,
      generatedAt,
      previousSummary: summaryOf(datedRow('previous', '2026-06-01T12:00:00.000Z')),
      recordedHistory: everyHarness(new Date('2026-01-01T00:00:00.000Z')),
      ...overrides,
    });

  describe('previous window', () => {
    test('has the length of the selection and ends where the selection starts', () => {
      expect(previousPeriodWindow(week, generatedAt)).toEqual(weekBefore);
    });

    test('ends an open selection at the generation instant, as the focused projections do', () => {
      const open: DateBounds = { from: new Date('2026-06-04T00:00:00.000Z'), to: null };
      const expected = { from: new Date('2026-05-27T12:00:00.000Z'), to: new Date('2026-06-03T23:59:59.999Z') };

      expect(previousPeriodWindow(open, generatedAt)).toEqual(expected);
      expect(buildPreviousPeriodBounds(open, generatedAt)).toEqual(expected);
    });

    test('never shrinks below one day', () => {
      const morning: DateBounds = {
        from: new Date('2026-06-11T00:00:00.000Z'),
        to: new Date('2026-06-11T06:00:00.000Z'),
      };

      expect(previousPeriodWindow(morning, generatedAt)).toEqual({
        from: new Date('2026-06-10T00:00:00.000Z'),
        to: new Date('2026-06-10T23:59:59.999Z'),
      });
    });

    test('does not exist for a selection without a start', () => {
      expect(previousPeriodWindow({ from: null, to: null }, generatedAt)).toBeNull();
      expect(previousPeriodWindow({ from: null, to: week.to }, generatedAt)).toBeNull();
    });

    test.each([
      { label: 'a closed selection', range: { from: '2026-06-04T00:00:00.000Z', to: '2026-06-10T23:59:59.999Z' } },
      { label: 'an open selection', range: { from: '2026-06-04T00:00:00.000Z', to: null } },
    ])('holds exactly the sessions the focused Overview projection counts for $label', ({ range }) => {
      const window = previousPeriodWindow(
        { from: new Date(range.from), to: range.to === null ? null : new Date(range.to) },
        generatedAt,
      );
      if (window === null) {
        throw new Error('A bounded selection must have a previous window');
      }
      const { rows: _rows, tableRows: _tableRows, ...support } = demoReportPayload;
      const at = (name: string, time: number): SerializedRow => ({
        ...baseRow,
        activeDate: new Date(time).toISOString(),
        date: new Date(time).toISOString(),
        name,
        sessionLabel: name,
        source: { harnessKey: 'codex', rootSourceSessionId: name, sourceSessionId: name },
      });
      const projectedPrevious = (rows: SerializedRow[]) =>
        projectFocusedOverview(
          rows,
          { ...support, generatedAt: generatedAt.toISOString() },
          {
            includeAdvanced: false,
            query: {
              filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
              range,
              revision: 'window-parity',
            },
            timeline: { dimension: 'harness', granularity: 'day' },
          },
        ).view.previousSummary;

      expect(
        projectedPrevious([at('first instant', window.from.getTime()), at('last instant', window.to.getTime())])
          ?.sessionCount,
      ).toBe(2);
      expect(
        projectedPrevious([at('too early', window.from.getTime() - 1), at('selected', window.to.getTime() + 1)]),
      ).toBeNull();
    });
  });

  describe('baseline', () => {
    test('is the previous summary over the equal-length window when history covers it', () => {
      const previousSummary = summaryOf(datedRow('previous', '2026-06-01T12:00:00.000Z'));

      expect(baselineFor({ previousSummary })).toEqual({
        kind: 'available',
        previous: previousSummary,
        window: weekBefore,
      });
    });

    test('is covered by history that starts exactly with the previous window', () => {
      expect(baselineFor({ recordedHistory: everyHarness(weekBefore.from) }).kind).toBe('available');
    });

    test('does not exist for a full-range selection, whatever summary is supplied', () => {
      expect(baselineFor({ bounds: { from: null, to: null } })).toEqual({ kind: 'full-range' });
      expect(baselineFor({ bounds: { from: null, to: week.to }, previousSummary: null })).toEqual({
        kind: 'full-range',
      });
    });

    test('is unrecorded when history starts inside the selected period', () => {
      const history = everyHarness(new Date('2026-06-05T08:00:00.000Z'));

      expect(baselineFor({ previousSummary: null, recordedHistory: history })).toEqual({
        history,
        kind: 'history-shorter-than-window',
        previousPeriod: 'unrecorded',
        window: weekBefore,
      });
      expect(
        baselineFor({ previousSummary: null, recordedHistory: everyHarness(new Date('2026-06-04T00:00:00.000Z')) })
          .kind,
      ).toBe('history-shorter-than-window');
    });

    test('is only partly recorded when history starts inside the previous window', () => {
      const history = everyHarness(new Date('2026-06-01T12:00:00.000Z'));

      expect(baselineFor({ recordedHistory: history })).toEqual({
        history,
        kind: 'history-shorter-than-window',
        previousPeriod: 'partly-recorded',
        window: weekBefore,
      });
    });

    test('keeps the harnesses the deciding history is limited to', () => {
      const history = { first: new Date('2026-06-01T12:00:00.000Z'), limitedToHarnesses: ['Codex'] };

      expect(baselineFor({ recordedHistory: history })).toMatchObject({ history, previousPeriod: 'partly-recorded' });
    });

    test('has no sessions when history covers the previous window but nothing matched in it', () => {
      expect(baselineFor({ previousSummary: null })).toEqual({ kind: 'no-previous-sessions', window: weekBefore });
      expect(baselineFor({ previousSummary: null, recordedHistory: null })).toEqual({
        kind: 'no-previous-sessions',
        window: weekBefore,
      });
    });
  });

  describe('deciding history', () => {
    const noFilter: SessionQueryFilters = { fields: {}, harness: [], machine: [], origin: [], query: '' };
    const unfilteredFirst = '2026-04-12T10:05:00.000Z';
    const filteredFirst = '2026-05-24T14:18:00.000Z';
    const historyFor = (filters: Partial<SessionQueryFilters>) =>
      periodRecordedHistory({ filteredFirst, filters: { ...noFilter, ...filters }, unfilteredFirst });

    test('is the history of every harness when nothing is filtered', () => {
      expect(historyFor({})).toEqual({ first: new Date(unfilteredFirst), limitedToHarnesses: [] });
    });

    test('is the history of the selected harnesses under a harness filter alone', () => {
      expect(historyFor({ harness: ['OpenCode'] })).toEqual({
        first: new Date(filteredFirst),
        limitedToHarnesses: ['OpenCode'],
      });
    });

    const beyondHarness: readonly { readonly filters: Partial<SessionQueryFilters>; readonly label: string }[] = [
      { filters: { query: 'OpenCode' }, label: 'a text query' },
      { filters: { fields: { model: 'qwen3-coder' } }, label: 'a model' },
      { filters: { fields: { project: 'ai-usage' } }, label: 'a project' },
      { filters: { machine: ['machine-a'] }, label: 'a machine' },
      { filters: { origin: ['classifier'] }, label: 'an origin' },
      { filters: { localTimeCell: { hour: 9, weekday: 1 } }, label: 'a local time cell' },
      { filters: { harness: ['OpenCode'], query: 'Tune' }, label: 'a harness with another filter' },
    ];

    test.each(beyondHarness)(
      'is the unfiltered history under $label, where a late first match is no unrecorded period',
      ({ filters }) => {
        expect(historyFor(filters)).toEqual({ first: new Date(unfilteredFirst), limitedToHarnesses: [] });
      },
    );

    test('does not exist when the history that decides holds no dated activity', () => {
      expect(periodRecordedHistory({ filteredFirst, filters: noFilter, unfilteredFirst: null })).toBeNull();
      expect(
        periodRecordedHistory({
          filteredFirst: null,
          filters: { ...noFilter, harness: ['Codex'] },
          unfilteredFirst,
        }),
      ).toBeNull();
    });

    test('lets an empty previous window under a model filter read as no previous sessions', () => {
      const history = historyFor({ fields: { model: 'qwen3-coder' } });

      expect(baselineFor({ previousSummary: null, recordedHistory: history }).kind).toBe('no-previous-sessions');
    });
  });

  describe('metric', () => {
    const current = summaryOf(datedRow('current', '2026-06-08T12:00:00.000Z', { costApprox: 3, tokIn: 40 }));
    const previous = summaryOf(datedRow('previous', '2026-06-01T12:00:00.000Z', { costApprox: 2, tokIn: 15 }));
    const available = baselineFor({ previousSummary: previous });

    test('measures the change against the previous window with one reading for both periods', () => {
      const read: (summary: ReportSummary) => ReturnType<typeof totalApiValueReading> = (summary) =>
        totalApiValueReading(summary);
      const seen: ReportSummary[] = [];

      expect(
        comparePeriodMetric(
          available,
          current,
          (summary) => {
            seen.push(summary);
            return read(summary);
          },
          false,
        ),
      ).toEqual({
        current: 3,
        kind: 'change',
        percent: 50,
        previous: 2,
        provisional: false,
        window: weekBefore,
      });
      expect(seen).toEqual([current, previous]);
    });

    test('reports a decrease, an unchanged value and a provisional period', () => {
      const baseline = baselineFor({ previousSummary: current });

      expect(comparePeriodMetric(baseline, previous, processedTokensReading, false)).toMatchObject({
        current: 25,
        kind: 'change',
        percent: -50,
        previous: 50,
      });
      expect(comparePeriodMetric(baseline, current, processedTokensReading, false)).toMatchObject({
        kind: 'change',
        percent: 0,
      });
      expect(comparePeriodMetric(baseline, previous, processedTokensReading, true)).toMatchObject({
        kind: 'change',
        provisional: true,
      });
    });

    test('derives no percentage from a zero baseline', () => {
      const unpricedWork = summaryOf(datedRow('free', '2026-06-01T12:00:00.000Z', { costApprox: 0 }));
      const baseline = baselineFor({ previousSummary: unpricedWork });

      expect(comparePeriodMetric(baseline, current, totalApiValueReading, false)).toEqual({
        kind: 'zero-baseline',
        window: weekBefore,
      });
      expect(comparePeriodMetric(baseline, unpricedWork, totalApiValueReading, false)).toEqual({
        kind: 'zero-baseline',
        window: weekBefore,
      });
    });

    test('keeps a partly measured metric out of the percentage without silencing a complete one', () => {
      const partlyPriced = summaryOf(
        datedRow('priced', '2026-06-01T10:00:00.000Z', { costApprox: 2, tokIn: 15 }),
        datedRow('unpriced', '2026-06-01T12:00:00.000Z', { costApprox: 0, costKnown: false, tokIn: 15 }),
      );
      const partialBaseline = baselineFor({ previousSummary: partlyPriced });

      expect(comparePeriodMetric(partialBaseline, current, totalApiValueReading, false)).toEqual({
        current: { complete: true, value: 3 },
        kind: 'partial-measurement',
        previous: { complete: false, value: 2 },
        window: weekBefore,
      });
      expect(comparePeriodMetric(available, partlyPriced, totalApiValueReading, false)).toMatchObject({
        current: { complete: false, value: 2 },
        kind: 'partial-measurement',
        previous: { complete: true, value: 2 },
      });
      expect(comparePeriodMetric(partialBaseline, current, processedTokensReading, false)).toMatchObject({
        current: 50,
        kind: 'change',
        previous: 50,
      });
    });

    test.each([
      baselineFor({ bounds: { from: null, to: null } }),
      baselineFor({ previousSummary: null, recordedHistory: everyHarness(new Date('2026-06-05T08:00:00.000Z')) }),
      baselineFor({ recordedHistory: everyHarness(new Date('2026-06-01T12:00:00.000Z')) }),
      baselineFor({ previousSummary: null }),
    ])('carries the missing baseline through unchanged: $kind', (baseline) => {
      expect<unknown>(comparePeriodMetric(baseline, current, processedTokensReading, false)).toBe(baseline);
    });
  });

  test('compares the same aggregation over both windows under the current filter set', () => {
    const rows = [
      datedRow('Codex current', '2026-06-08T12:00:00.000Z', { tokIn: 90 }),
      datedRow('Codex previous', '2026-06-01T12:00:00.000Z', { tokIn: 40 }),
      datedRow('Claude current', '2026-06-09T12:00:00.000Z', { harness: 'Claude', tokIn: 10 }),
      datedRow('Claude previous', '2026-06-02T12:00:00.000Z', { harness: 'Claude', tokIn: 190 }),
    ];
    const processedTokensChange = (filtered: typeof rows) =>
      comparePeriodMetric(
        resolvePeriodBaseline({
          bounds: week,
          generatedAt,
          previousSummary: buildPreviousPeriodSummary(filtered, week, generatedAt),
          recordedHistory: everyHarness(new Date('2026-01-01T00:00:00.000Z')),
        }),
        buildVisibleSummary(filtered, week),
        processedTokensReading,
        false,
      );

    expect(processedTokensChange(rows)).toMatchObject({ current: 120, kind: 'change', percent: -52, previous: 250 });
    expect(processedTokensChange(filterTimelineRows(rows, createFilterSnapshot('', ['Codex'], [], {})))).toMatchObject({
      current: 100,
      kind: 'change',
      percent: 100,
      previous: 50,
    });
  });
});
