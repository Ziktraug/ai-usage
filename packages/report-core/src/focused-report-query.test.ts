import { describe, expect, test } from 'bun:test';
import {
  type FocusedMachineFreshness,
  type FocusedOverviewRequest,
  type FocusedReportSupport,
  focusedAdvancedAnalysisFingerprint,
  focusedOverviewFingerprint,
  focusedTimelineDimensionDefinitions,
  focusedTimelineDimensions,
  parseFocusedOverviewRequest,
  parseFocusedReportQueryResult,
  projectFocusedBreakdown,
  projectFocusedOverview,
  projectFocusedSupport,
} from './focused-report-query';
import { localTimeRowFields } from './local-time-row.test-fixture';
import {
  MAX_BREAKDOWN_REFRESH_BYTES,
  MAX_OVERVIEW_REFRESH_BYTES,
  MAX_SERVED_BOOTSTRAP_BYTES,
  REPORT_AUDIT_FIXTURE_SEED,
} from './report-budgets';
import type { SerializedRow } from './report-data';

const row = (name: string, day: number, cost: number, project = 'ai-usage'): SerializedRow => ({
  activeDate: `2026-07-${String(day).padStart(2, '0')}T10:00:00.000Z`,
  calls: day,
  costActual: cost / 2,
  costApprox: cost,
  costKnown: true,
  costQuota: 0,
  date: `2026-07-${String(day).padStart(2, '0')}T09:00:00.000Z`,
  durationMs: day * 60_000,
  endDate: `2026-07-${String(day).padStart(2, '0')}T10:00:00.000Z`,
  freshTokens: day * 3,
  harness: day % 2 === 0 ? 'Claude Code' : 'Codex',
  lineDelta: day,
  linesAdded: day,
  linesDeleted: 0,
  model: day % 2 === 0 ? 'claude-opus-4-6' : 'gpt-5.4',
  name,
  project,
  provider: day % 2 === 0 ? 'Anthropic' : 'Codex API',
  sessionLabel: name,
  source: {
    harnessKey: 'codex',
    machineId: 'machine-a',
    machineLabel: 'Machine A',
    rootSourceSessionId: name,
    sourceSessionId: name,
  },
  tokCr: day,
  tokCw: day,
  tokIn: day,
  tokOut: day,
  tokenTotal: day * 4,
  tools: day,
  turns: day,
});

const rows = [row('one', 1, 1), row('two', 2, 2), row('three', 3, 3), row('four', 4, 4, 'side')];

const support: FocusedReportSupport = {
  analytics: {
    averageDurationMs: null,
    byHarness: [],
    byModel: [],
    byProvider: [],
    costPer100Lines: null,
    durationMs: 0,
    durationRows: 0,
    lineCount: 0,
    linesA: 0,
    linesD: 0,
    meanCost: 0,
    medianCost: 0,
    pricedCount: 0,
    recentSessions: 0,
    sessionCount: rows.length,
    tools: 0,
    totalCost: 0,
    turns: 0,
    unpricedCount: 0,
  },
  datasets: {
    cursorCommitAttribution: [
      {
        blankLinesAdded: 0,
        blankLinesDeleted: 0,
        branchName: 'main',
        commitDate: 'Mon Jul 13 10:00:00 2026 +0200',
        commitHash: 'a'.repeat(40),
        commitMessage: 'test',
        composerLinesAdded: 1,
        composerLinesDeleted: 0,
        humanLinesAdded: 1,
        humanLinesDeleted: 0,
        linesAdded: 2,
        linesDeleted: 0,
        scoredAt: '2026-07-13T08:00:00.000Z',
        tabLinesAdded: 0,
        tabLinesDeleted: 0,
        v1AiPercentage: null,
        v2AiPercentage: 50,
      },
    ],
  },
  filters: { limit: 2, minTokens: 0, project: null, since: null, sort: 'date' },
  generatedAt: '2026-07-13T12:00:00.000Z',
  omittedRows: 0,
  timeZone: 'UTC',
  projectGroupConfigs: [{ id: 'group-a', name: 'Group A', sources: [{ project: 'ai-usage' }] }],
  projectGroups: [],
  warnings: [{ message: 'warning' }],
};

const overviewRequest: FocusedOverviewRequest = {
  includeAdvanced: true,
  query: {
    filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
    range: { from: '2026-07-02T00:00:00.000Z', to: '2026-07-04T23:59:59.999Z' },
    revision: 'revision-a',
  },
  timeline: { dimension: 'model', granularity: 'day' },
};

describe('focused report query contracts', () => {
  test('strictly validates canonical requests and fingerprints semantic scope', () => {
    expect(parseFocusedOverviewRequest(overviewRequest)).toEqual(overviewRequest);
    expect(focusedOverviewFingerprint(overviewRequest)).toStartWith('focused-overview-v1:');
    expect(focusedOverviewFingerprint({ ...overviewRequest, includeAdvanced: false })).not.toBe(
      focusedOverviewFingerprint(overviewRequest),
    );
    const dimensionFingerprints = focusedTimelineDimensions.map((dimension) =>
      focusedOverviewFingerprint({
        ...overviewRequest,
        timeline: { ...overviewRequest.timeline, dimension },
      }),
    );
    expect(new Set(dimensionFingerprints).size).toBe(focusedTimelineDimensions.length);
    expect(new Set(focusedTimelineDimensionDefinitions.map(({ label }) => label)).size).toBe(
      focusedTimelineDimensions.length,
    );
    for (const dimension of focusedTimelineDimensions) {
      expect(
        parseFocusedOverviewRequest({
          ...overviewRequest,
          timeline: { ...overviewRequest.timeline, dimension },
        }).timeline.dimension,
      ).toBe(dimension);
    }
    expect(focusedAdvancedAnalysisFingerprint(overviewRequest.query)).toStartWith('focused-advanced-analysis-v1:');
    expect(focusedAdvancedAnalysisFingerprint(overviewRequest.query)).not.toBe(
      focusedAdvancedAnalysisFingerprint({ ...overviewRequest.query, revision: 'revision-b' }),
    );
    const { includeAdvanced: _includeAdvanced, ...requestWithoutAdvancedMode } = overviewRequest;
    expect(() => parseFocusedOverviewRequest(requestWithoutAdvancedMode)).toThrow('unknown or missing');
    expect(() => parseFocusedOverviewRequest({ ...overviewRequest, extra: true })).toThrow('unknown or missing');
  });

  test('applies a local punchcard cell before every focused aggregation', () => {
    const timedRow = (name: string, day: number, hour: number, minute: number, cost: number): SerializedRow => ({
      ...row(name, 1, cost),
      ...localTimeRowFields(day, hour, minute),
    });
    const fixtures = [
      timedRow('monday-13:59', 27, 13, 59, 1),
      timedRow('monday-14:00', 27, 14, 0, 2),
      timedRow('monday-14:59', 27, 14, 59, 3),
      timedRow('monday-15:00', 27, 15, 0, 4),
      timedRow('sunday-14:00', 26, 14, 0, 5),
      { ...row('missing-time', 1, 6), activeDate: null, date: null, endDate: null },
    ];
    const request: FocusedOverviewRequest = {
      ...overviewRequest,
      query: {
        ...overviewRequest.query,
        filters: { ...overviewRequest.query.filters, localTimeCell: { hour: 14, weekday: 0 } },
        range: { from: null, to: null },
      },
    };

    const monday = projectFocusedOverview(fixtures, support, request);
    expect(monday.summary.sessionCount).toBe(2);
    expect(monday.timeline?.grandSessions).toBe(2);
    expect(monday.view.topSessions.map(({ label }) => label)).toEqual(['monday-14:59', 'monday-14:00']);
    expect(monday.view.punchcard?.cells[0]?.[14]?.sessions).toBe(2);

    const sunday = projectFocusedOverview(fixtures, support, {
      ...request,
      query: {
        ...request.query,
        filters: { ...request.query.filters, localTimeCell: { hour: 14, weekday: 6 } },
      },
    });
    expect(sunday.view.topSessions.map(({ label }) => label)).toEqual(['sunday-14:00']);
  });

  test('omits advanced analysis work and results from timeline-only requests', () => {
    const result = projectFocusedOverview(rows, support, { ...overviewRequest, includeAdvanced: false });

    expect(result.summary.sessionCount).toBe(3);
    expect(result.timeline?.grandSessions).toBe(rows.length);
    expect(result.view.advancedSummary).toBeNull();
    expect(result.view.punchcard).toBeNull();
    expect(result.view.sessionShape).toBeNull();
  });

  test('projects every bounded Overview aggregate without returning the full row set', () => {
    const result = projectFocusedOverview(rows, support, overviewRequest);

    expect(result.dateDomain).toEqual({
      first: '2026-07-01T10:00:00.000Z',
      last: '2026-07-04T10:00:00.000Z',
    });
    expect(result.summary.sessionCount).toBe(3);
    expect(result.summary.totalCost).toBe(9);
    expect(result.timeline?.grandSessions).toBe(rows.length);
    expect(result.view.heatmap?.weeks.length).toBeGreaterThan(0);
    expect(result.view.records?.topCost?.row.name).toBe('four');
    expect(result.view.topSessions.map(({ label }) => label)).toEqual(['four', 'three', 'two']);
    expect(result.view.sessionShape?.totalPoints).toBe(3);
    expect(result.view.punchcard?.maxSessions).toBe(1);
    expect(result.view.advancedSummary?.hasSessionShape).toBe(true);
    expect(result.view.advancedSummary?.summary).toBe(
      'Duration/value patterns and weekly/hourly activity · 3 sessions',
    );
    expect(Object.hasOwn(result, 'rows')).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2 * 1024 * 1024);
    expect(parseFocusedReportQueryResult('overview', JSON.parse(JSON.stringify(result)), overviewRequest)).toEqual(
      result,
    );
    expect(() =>
      parseFocusedReportQueryResult(
        'overview',
        { ...result, requestFingerprint: 'focused-overview-v1:0000000000000000' },
        overviewRequest,
      ),
    ).toThrow('fingerprint');
  });

  test('projects bounded executive harness and model groups for the selected period', () => {
    const result = projectFocusedOverview(rows, support, overviewRequest);

    expect(result.view.executive).toEqual({
      harnesses: [
        {
          key: 'Claude Code',
          label: 'Claude Code',
          priceMeasurement: { knownCost: 6, state: 'measured', unpricedFreshTokens: 0 },
          processedTokens: 24,
          sessions: 2,
          total: 6,
        },
        {
          key: 'Codex',
          label: 'Codex',
          priceMeasurement: { knownCost: 3, state: 'measured', unpricedFreshTokens: 0 },
          processedTokens: 12,
          sessions: 1,
          total: 3,
        },
      ],
      models: [
        {
          key: 'claude-opus-4-6',
          label: 'claude-opus-4-6',
          priceMeasurement: { knownCost: 6, state: 'measured', unpricedFreshTokens: 0 },
          processedTokens: 24,
          sessions: 2,
          total: 6,
        },
        {
          key: 'gpt-5.4',
          label: 'gpt-5.4',
          priceMeasurement: { knownCost: 3, state: 'measured', unpricedFreshTokens: 0 },
          processedTokens: 12,
          sessions: 1,
          total: 3,
        },
      ],
    });
  });

  test('keeps the mandatory executive result empty when no rows match', () => {
    const request = { ...overviewRequest, includeAdvanced: false };
    const result = projectFocusedOverview([], support, request);

    expect(result.view.executive).toEqual({ harnesses: [], models: [] });
    expect(parseFocusedReportQueryResult('overview', JSON.parse(JSON.stringify(result)), request)).toEqual(result);
  });

  test('preserves partial lower bounds and segment-accurate processed tokens', () => {
    const partialSegmentedRow: SerializedRow = {
      ...row('partial-executive', 3, 2),
      costKnown: false,
      freshTokens: 30,
      harness: 'Mixed Harness',
      model: 'gpt-5.4-high',
      modelSegments: [
        {
          costApprox: 2,
          costKnown: true,
          model: 'gpt-5.4-high',
          tokCr: 1,
          tokCw: 2,
          tokIn: 3,
          tokOut: 4,
        },
        {
          costApprox: 0,
          costKnown: false,
          model: 'mystery-model',
          tokCr: 5,
          tokCw: 6,
          tokIn: 7,
          tokOut: 8,
        },
      ],
      models: ['gpt-5.4-high', 'mystery-model'],
      tokCr: 6,
      tokCw: 8,
      tokIn: 10,
      tokOut: 12,
      tokenTotal: 36,
    };
    const request: FocusedOverviewRequest = {
      ...overviewRequest,
      includeAdvanced: false,
      query: { ...overviewRequest.query, range: { from: null, to: null } },
    };

    const result = projectFocusedOverview([partialSegmentedRow], support, request);

    expect(result.view.executive.harnesses).toEqual([
      {
        key: 'Mixed Harness',
        label: 'Mixed Harness',
        priceMeasurement: { knownCost: 2, state: 'partially measured', unpricedFreshTokens: 21 },
        processedTokens: 36,
        sessions: 1,
        total: 2,
      },
    ]);
    expect(result.view.executive.models).toEqual([
      {
        key: 'gpt-5.4',
        label: 'gpt-5.4',
        priceMeasurement: { knownCost: 2, state: 'measured', unpricedFreshTokens: 0 },
        processedTokens: 10,
        sessions: 1,
        total: 2,
      },
      {
        key: 'mystery-model',
        label: 'mystery-model',
        priceMeasurement: { knownCost: 0, state: 'partially measured', unpricedFreshTokens: 21 },
        processedTokens: 26,
        sessions: 1,
        total: 0,
      },
    ]);
  });

  test('keeps exactly five harness groups without manufacturing Other', () => {
    const fixtureRows = [5, 4, 3, 2, 1].map((cost) => ({
      ...row(`harness-${cost}`, cost, cost),
      harness: `Harness ${cost}`,
      model: `model-${cost}`,
    }));
    const request: FocusedOverviewRequest = {
      ...overviewRequest,
      includeAdvanced: false,
      query: { ...overviewRequest.query, range: { from: null, to: null } },
    };

    const result = projectFocusedOverview(fixtureRows, support, request);

    expect(result.view.executive.harnesses.map(({ key }) => key)).toEqual([
      'Harness 5',
      'Harness 4',
      'Harness 3',
      'Harness 2',
      'Harness 1',
    ]);
    expect(result.view.executive.harnesses.some(({ label }) => label === 'Other')).toBe(false);
  });

  test('combines every harness remainder into a collision-safe partial Other and limits models to five', () => {
    const fixtureRows: SerializedRow[] = [6, 5, 4, 3, 2].map((cost) => ({
      ...row(`harness-${cost}`, cost, cost),
      harness: `Harness ${cost}`,
      model: `model-${cost}`,
    }));
    fixtureRows.push({
      ...row('reserved-harness', 1, 1),
      costKnown: false,
      harness: '__ai_usage_other__',
      model: 'model-1',
      modelSegments: [
        {
          costApprox: 1,
          costKnown: true,
          model: 'model-1',
          tokCr: 0,
          tokCw: 0,
          tokIn: 1,
          tokOut: 0,
        },
        {
          costApprox: 0,
          costKnown: false,
          model: 'unpriced-other',
          tokCr: 1,
          tokCw: 1,
          tokIn: 0,
          tokOut: 1,
        },
      ],
      models: ['model-1', 'unpriced-other'],
    });
    const request: FocusedOverviewRequest = {
      ...overviewRequest,
      includeAdvanced: false,
      query: { ...overviewRequest.query, range: { from: null, to: null } },
    };

    const result = projectFocusedOverview(fixtureRows, support, request);

    expect(result.view.executive.harnesses.slice(0, 4).map(({ key }) => key)).toEqual([
      'Harness 6',
      'Harness 5',
      'Harness 4',
      'Harness 3',
    ]);
    expect(result.view.executive.harnesses[4]).toEqual({
      key: '___ai_usage_other__',
      label: 'Other',
      priceMeasurement: { knownCost: 3, state: 'partially measured', unpricedFreshTokens: 2 },
      processedTokens: 12,
      sessions: 2,
      total: 3,
    });
    expect(result.view.executive.models).toHaveLength(5);
    expect(result.view.executive.models.map(({ key }) => key)).toEqual([
      'model-6',
      'model-5',
      'model-4',
      'model-3',
      'model-2',
    ]);
    expect(result.view.executive.models.some(({ label }) => label === 'Other')).toBe(false);
  });

  test('uses the stable analytics key rather than session count to order equal executive totals', () => {
    const fixtureRows = [
      { ...row('z', 1, 1), harness: 'z-harness', model: 'z-model' },
      { ...row('a-1', 1, 0.5), harness: 'a-harness', model: 'a-model' },
      { ...row('a-2', 1, 0.5), harness: 'a-harness', model: 'a-model' },
      { ...row('accent', 1, 1), harness: 'ä-harness', model: 'ä-model' },
    ];
    const request: FocusedOverviewRequest = {
      ...overviewRequest,
      includeAdvanced: false,
      query: { ...overviewRequest.query, range: { from: null, to: null } },
    };

    const result = projectFocusedOverview(fixtureRows, support, request);

    expect(result.view.executive.harnesses.map(({ key, sessions }) => ({ key, sessions }))).toEqual([
      { key: 'a-harness', sessions: 2 },
      { key: 'z-harness', sessions: 1 },
      { key: 'ä-harness', sessions: 1 },
    ]);
    expect(result.view.executive.models.map(({ key, sessions }) => ({ key, sessions }))).toEqual([
      { key: 'a-model', sessions: 2 },
      { key: 'z-model', sessions: 1 },
      { key: 'ä-model', sessions: 1 },
    ]);
  });

  test('keeps full-range and bounded empty previous periods distinct from available prior data', () => {
    const withPrior = projectFocusedOverview(rows, support, overviewRequest);
    const withoutPrior = projectFocusedOverview(rows, support, {
      ...overviewRequest,
      query: {
        ...overviewRequest.query,
        range: { from: '2026-07-01T00:00:00.000Z', to: overviewRequest.query.range.to },
      },
    });
    const fullRange = projectFocusedOverview(rows, support, {
      ...overviewRequest,
      query: { ...overviewRequest.query, range: { from: null, to: null } },
    });

    expect(withPrior.view.previousSummary?.sessionCount).toBe(1);
    expect(withoutPrior.view.previousSummary).toBeNull();
    expect(fullRange.view.previousSummary).toBeNull();
  });

  test('groups focused timelines by campaign, machine, project identity, and declared origin', () => {
    const request = {
      ...overviewRequest,
      includeAdvanced: false,
      query: { ...overviewRequest.query, range: { from: null, to: null } },
    };

    const campaignRows = rows.map((sourceRow) =>
      sourceRow.name === 'two'
        ? {
            ...sourceRow,
            source: {
              ...sourceRow.source!,
              parentSourceSessionId: 'one',
              rootSourceSessionId: 'one',
            },
          }
        : sourceRow,
    );
    const campaign = projectFocusedOverview(campaignRows, support, {
      ...request,
      timeline: { dimension: 'campaign', granularity: 'day' },
    });
    const machine = projectFocusedOverview(campaignRows, support, {
      ...request,
      timeline: { dimension: 'machine', granularity: 'day' },
    });
    const originRows: SerializedRow[] = [
      { ...campaignRows[0]!, origin: 'human' },
      { ...campaignRows[1]!, origin: 'subagent' },
      {
        ...campaignRows[2]!,
        origin: 'classifier',
        source: {
          ...campaignRows[2]!.source!,
          parentSourceSessionId: 'one',
          rootSourceSessionId: 'one',
        },
      },
      { ...campaignRows[3]!, originProvenance: 'origin-unsupported' },
      { ...row('absent', 5, 5), originProvenance: 'origin-absent' },
      { ...row('degraded', 6, 6), originProvenance: 'origin-degraded' },
    ];
    const origin = projectFocusedOverview(originRows, support, {
      ...request,
      timeline: { dimension: 'origin', granularity: 'day' },
    });
    const project = projectFocusedOverview(
      campaignRows.map((sourceRow) => ({
        ...sourceRow,
        project: 'AI Usage — Machine A',
        projectGroupId: 'group:ai-usage',
        rawProject: 'ai-usage',
      })),
      support,
      { ...request, timeline: { dimension: 'project', granularity: 'day' } },
    );

    expect(campaign.timeline?.series.find(({ label }) => label === 'one')).toMatchObject({
      label: 'one',
      sessions: 2,
      total: 3,
    });
    expect(machine.timeline?.series).toEqual([
      expect.objectContaining({ key: 'machine-a', label: 'Machine A', sessions: 4, total: 10 }),
    ]);
    expect(origin.timeline?.series.map(({ key }) => key).sort()).toEqual(['classifier', 'human', 'subagent']);
    expect(origin.timeline?.unclassified).toMatchObject({
      causes: [
        { kind: 'origin-unsupported', sessions: 1 },
        { kind: 'origin-absent', sessions: 1 },
        { kind: 'origin-degraded', sessions: 1 },
      ],
      sessions: 3,
      total: 15,
    });
    expect(origin.timeline?.series.some(({ key }) => key.includes('unknown'))).toBe(false);
    expect(project.timeline?.series).toEqual([
      expect.objectContaining({ key: 'group:ai-usage', label: 'AI Usage — Machine A', sessions: 4, total: 10 }),
    ]);

    const filteredCampaign = projectFocusedOverview(campaignRows, support, {
      ...request,
      query: {
        ...request.query,
        filters: { ...request.query.filters, harness: ['Claude Code'] },
      },
      timeline: { dimension: 'campaign', granularity: 'day' },
    });
    expect(filteredCampaign.timeline?.series.find(({ label }) => label === 'one')).toMatchObject({
      label: 'one',
      sessions: 1,
      total: 2,
    });
  });

  test('uses stable machine IDs for filters and timeline keys when labels collide', () => {
    const machineRows = [
      {
        ...rows[0]!,
        source: {
          ...rows[0]!.source!,
          machineId: 'machine-a',
          machineLabel: 'Shared machine',
        },
      },
      {
        ...rows[1]!,
        source: {
          ...rows[1]!.source!,
          machineId: 'machine-b',
          machineLabel: 'Shared machine',
        },
      },
    ];
    const request: FocusedOverviewRequest = {
      ...overviewRequest,
      includeAdvanced: false,
      query: { ...overviewRequest.query, range: { from: null, to: null } },
      timeline: { dimension: 'machine', granularity: 'day' },
    };

    const unfiltered = projectFocusedOverview(machineRows, support, request);
    expect(unfiltered.timeline?.series.map(({ key, label, sessions }) => ({ key, label, sessions }))).toEqual([
      { key: 'machine-b', label: 'Shared machine', sessions: 1 },
      { key: 'machine-a', label: 'Shared machine', sessions: 1 },
    ]);

    const filtered = projectFocusedOverview(machineRows, support, {
      ...request,
      query: {
        ...request.query,
        filters: { ...request.query.filters, machine: ['machine-b'] },
      },
    });
    expect(filtered.summary.sessionCount).toBe(1);
    expect(filtered.timeline?.series.map(({ key }) => key)).toEqual(['machine-b']);
  });

  test('uses campaign aggregates for session records while preserving day records', () => {
    const campaignRoot = {
      ...row('record-campaign-root', 2, 5),
      durationMs: 7_200_000,
      source: {
        harnessKey: 'codex',
        machineId: 'machine-a',
        machineLabel: 'Machine A',
        rootSourceSessionId: 'record-campaign-root',
        sourceSessionId: 'record-campaign-root',
      },
    };
    const campaignChild = {
      ...row('record-campaign-child', 3, 7),
      durationMs: 15_000_000,
      source: {
        harnessKey: 'codex',
        machineId: 'machine-a',
        machineLabel: 'Machine A',
        parentSourceSessionId: 'record-campaign-root',
        rootSourceSessionId: 'record-campaign-root',
        sourceSessionId: 'record-campaign-child',
      },
    };
    const standalone = {
      ...row('record-standalone', 4, 10),
      durationMs: 3_600_000,
    };

    const result = projectFocusedOverview([campaignRoot, campaignChild, standalone], support, overviewRequest);

    expect(result.view.records?.topCost).toMatchObject({
      costApprox: 12,
      kind: 'campaign',
      label: 'record-campaign-root',
      sessionCount: 2,
    });
    expect(result.view.records?.longest).toMatchObject({
      durationMs: 7_200_000,
      kind: 'campaign',
      label: 'record-campaign-root',
      row: { name: 'record-campaign-root' },
    });
    expect(result.view.records?.busiest).toEqual({
      cost: 10,
      date: '2026-07-04T00:00:00.000Z',
      sessions: 1,
    });
    expect(result.view.records?.streak).toBe(3);
    expect(result.view.records?.streakEnd).toBe('2026-07-04T00:00:00.000Z');
  });

  test('preserves known API-value subtotals and completeness for top sessions and campaigns', () => {
    const campaignRoot = {
      ...row('campaign-root', 2, 5),
      source: {
        harnessKey: 'codex',
        machineId: 'machine-a',
        machineLabel: 'Machine A',
        rootSourceSessionId: 'campaign-root',
        sourceSessionId: 'campaign-root',
      },
    };
    const campaignChild = {
      ...row('campaign-child', 3, 7),
      costKnown: false,
      source: {
        harnessKey: 'codex',
        machineId: 'machine-a',
        machineLabel: 'Machine A',
        parentSourceSessionId: 'campaign-root',
        rootSourceSessionId: 'campaign-root',
        sourceSessionId: 'campaign-child',
      },
    };
    const partialSession = { ...row('partial-session', 4, 10), costKnown: false };

    const result = projectFocusedOverview([campaignRoot, campaignChild, partialSession], support, overviewRequest);

    expect(
      result.view.topSessions.map(({ costApprox, costKnown, kind, label }) => ({
        costApprox,
        costKnown,
        kind,
        label,
      })),
    ).toEqual([
      { costApprox: 12, costKnown: false, kind: 'campaign', label: 'campaign-root' },
      { costApprox: 10, costKnown: false, kind: 'campaign', label: 'partial-session' },
    ]);
    expect(result.view.sessionShape).toBeNull();
    expect(result.view.advancedSummary?.hasSessionShape).toBe(false);
  });

  test('keeps partial known subtotals aligned between an identical summary and timeline range', () => {
    const partialSegmentedRow: SerializedRow = {
      ...row('partial-segmented', 3, 2),
      costKnown: false,
      freshTokens: 18,
      modelSegments: [
        {
          costApprox: 2,
          costKnown: true,
          model: 'gpt-5.4',
          tokCr: 1,
          tokCw: 2,
          tokIn: 3,
          tokOut: 4,
        },
        {
          costApprox: 0,
          costKnown: false,
          model: 'unpriced-model',
          tokCr: 5,
          tokCw: 5,
          tokIn: 6,
          tokOut: 7,
        },
      ],
    };
    const exactRangeRequest: FocusedOverviewRequest = {
      ...overviewRequest,
      query: { ...overviewRequest.query, range: { from: null, to: null } },
    };

    const result = projectFocusedOverview([row('measured', 2, 4), partialSegmentedRow], support, exactRangeRequest);

    expect(result.summary.totalCost).toBe(6);
    expect(result.summary.priceMeasurement).toEqual({
      knownCost: 6,
      state: 'partially measured',
      unpricedFreshTokens: 18,
    });
    expect(result.timeline?.grandTotal).toBe(result.summary.totalCost);
    expect(result.timeline?.priceMeasurement).toEqual(result.summary.priceMeasurement);
    expect(result.timeline?.series.find(({ key }) => key === 'unpriced-model')?.priceMeasurement).toEqual({
      knownCost: 0,
      state: 'partially measured',
      unpricedFreshTokens: 18,
    });
  });

  test('excludes partial API-value lower bounds from exact session-shape analysis', () => {
    const partialRows = [1, 2, 3].map((day) => ({
      ...row(`partial-${day}`, day, day),
      costKnown: false,
    }));
    const request: FocusedOverviewRequest = {
      ...overviewRequest,
      query: { ...overviewRequest.query, range: { from: null, to: null } },
    };

    const result = projectFocusedOverview(partialRows, support, request);

    expect(result.view.sessionShape).toBeNull();
    expect(result.view.advancedSummary?.hasSessionShape).toBe(false);
    expect(result.view.advancedSummary?.summary).toBe('Weekly/hourly activity · 3 sessions');
  });

  test('keeps projected session-shape outliers within the transport bound', () => {
    const outlierRows = [100, 80, 60, 40, 20, 10, 1, 2, 3, 4, 5, 6].map((cost, index) =>
      row(`outlier-${index + 1}`, index + 1, cost),
    );
    const request: FocusedOverviewRequest = {
      ...overviewRequest,
      query: { ...overviewRequest.query, range: { from: null, to: null } },
    };

    const result = projectFocusedOverview(outlierRows, support, request);

    expect(result.view.sessionShape?.outliers.length).toBeLessThanOrEqual(6);
    expect(() => parseFocusedReportQueryResult('overview', JSON.parse(JSON.stringify(result)), request)).not.toThrow();
  });

  test('rejects incoherent API price measurements at the focused transport boundary', () => {
    const partialResult = projectFocusedOverview(rows, support, overviewRequest);
    const zeroResult = projectFocusedOverview([], support, overviewRequest);
    const invalidResults = [
      {
        expectedMessage: 'unpriced volume is inconsistent',
        result: {
          ...partialResult,
          summary: {
            ...partialResult.summary,
            priceMeasurement: {
              ...partialResult.summary.priceMeasurement,
              state: 'measured' as const,
              unpricedFreshTokens: 1,
            },
          },
        },
      },
      {
        expectedMessage: 'zero state is inconsistent',
        result: {
          ...zeroResult,
          summary: {
            ...zeroResult.summary,
            priceMeasurement: {
              ...zeroResult.summary.priceMeasurement,
              state: 'measured' as const,
            },
          },
        },
      },
    ];

    for (const { expectedMessage, result } of invalidResults) {
      expect(() => parseFocusedReportQueryResult('overview', result, overviewRequest)).toThrow(expectedMessage);
    }
  });

  test('strictly validates Overview date domains and preserves an explicit empty domain', () => {
    const result = projectFocusedOverview(rows, support, overviewRequest);
    const invalidDateDomains = [
      undefined,
      { first: result.dateDomain?.first },
      { first: '2026-07-01T10:00:00Z', last: '2026-07-04T10:00:00.000Z' },
      { first: '2026-07-05T10:00:00.000Z', last: '2026-07-04T10:00:00.000Z' },
      { first: '2026-07-01T10:00:00.000Z', last: '2026-07-04T10:00:00.000Z', unexpected: true },
    ];

    for (const dateDomain of invalidDateDomains) {
      expect(() => parseFocusedReportQueryResult('overview', { ...result, dateDomain }, overviewRequest)).toThrow();
    }

    const undatedRows = rows.map((sourceRow) => ({ ...sourceRow, activeDate: null, date: null, endDate: null }));
    const undatedRequest: FocusedOverviewRequest = {
      ...overviewRequest,
      query: { ...overviewRequest.query, range: { from: null, to: null } },
    };
    const undatedResult = projectFocusedOverview(undatedRows, support, undatedRequest);

    expect(undatedResult.dateDomain).toBeNull();
    expect(undatedResult.timeline).toBeNull();
    expect(
      parseFocusedReportQueryResult('overview', JSON.parse(JSON.stringify(undatedResult)), undatedRequest),
    ).toEqual(undatedResult);
  });

  test('rejects malformed nested Overview timeline data at the transport boundary', () => {
    const result = projectFocusedOverview(rows, support, overviewRequest);

    expect(() =>
      parseFocusedReportQueryResult('overview', { ...result, timeline: 'not-a-timeline' }, overviewRequest),
    ).toThrow('timeline');
  });

  test('rejects malformed nested Overview presentation data at the transport boundary', () => {
    const result = projectFocusedOverview(rows, support, overviewRequest);
    const firstSession = result.view.topSessions[0];
    if (!firstSession) {
      throw new Error('The Overview fixture must include a top session');
    }

    expect(() =>
      parseFocusedReportQueryResult(
        'overview',
        {
          ...result,
          view: {
            ...result.view,
            topSessions: [{ ...firstSession, row: { ...firstSession.row, unexpected: true } }],
          },
        },
        overviewRequest,
      ),
    ).toThrow('invalid serialized usage row');
    expect(() =>
      parseFocusedReportQueryResult(
        'overview',
        { ...result, view: { ...result.view, punchcard: { cells: [], maxSessions: 1 } } },
        overviewRequest,
      ),
    ).toThrow('seven days');
    expect(() =>
      parseFocusedReportQueryResult(
        'overview',
        {
          ...result,
          view: {
            ...result.view,
            advancedSummary: result.view.advancedSummary
              ? { ...result.view.advancedSummary, hasPunchcard: false }
              : null,
          },
        },
        overviewRequest,
      ),
    ).toThrow('flags');
  });

  test('requires the exact executive shape at the focused transport boundary', () => {
    const result = projectFocusedOverview(rows, support, overviewRequest);
    const { executive: _executive, ...viewWithoutExecutive } = result.view;

    expect(() =>
      parseFocusedReportQueryResult('overview', { ...result, view: viewWithoutExecutive }, overviewRequest),
    ).toThrow('unknown or missing');
    expect(() =>
      parseFocusedReportQueryResult(
        'overview',
        {
          ...result,
          view: { ...result.view, executive: { ...result.view.executive, unexpected: true } },
        },
        overviewRequest,
      ),
    ).toThrow('unknown or missing');
  });

  test('rejects unbounded, empty, or duplicate executive keys', () => {
    const result = projectFocusedOverview(rows, support, overviewRequest);
    const first = result.view.executive.harnesses[0];
    if (!first) {
      throw new Error('The executive fixture must include a harness group');
    }
    const sixGroups = Array.from({ length: 6 }, (_, index) => ({ ...first, key: `harness-${index}` }));

    expect(() =>
      parseFocusedReportQueryResult(
        'overview',
        {
          ...result,
          view: {
            ...result.view,
            executive: { ...result.view.executive, harnesses: sixGroups },
          },
        },
        overviewRequest,
      ),
    ).toThrow('at most 5');
    expect(() =>
      parseFocusedReportQueryResult(
        'overview',
        {
          ...result,
          view: {
            ...result.view,
            executive: { ...result.view.executive, harnesses: [first, { ...first }] },
          },
        },
        overviewRequest,
      ),
    ).toThrow('unique');
    expect(() =>
      parseFocusedReportQueryResult(
        'overview',
        {
          ...result,
          view: {
            ...result.view,
            executive: { ...result.view.executive, harnesses: [{ ...first, key: ' ' }] },
          },
        },
        overviewRequest,
      ),
    ).toThrow('non-empty');
  });

  test('rejects invalid executive values and price measurements', () => {
    const result = projectFocusedOverview(rows, support, overviewRequest);
    const first = result.view.executive.harnesses[0];
    if (!first) {
      throw new Error('The executive fixture must include a harness group');
    }
    const withHarness = (harness: Record<string, unknown>) => ({
      ...result,
      view: {
        ...result.view,
        executive: { ...result.view.executive, harnesses: [harness] },
      },
    });

    expect(() =>
      parseFocusedReportQueryResult('overview', withHarness({ ...first, sessions: -1 }), overviewRequest),
    ).toThrow('non-negative safe integer');
    expect(() =>
      parseFocusedReportQueryResult('overview', withHarness({ ...first, processedTokens: -1 }), overviewRequest),
    ).toThrow('finite number');
    expect(() =>
      parseFocusedReportQueryResult('overview', withHarness({ ...first, total: -1 }), overviewRequest),
    ).toThrow('finite number');
    expect(() =>
      parseFocusedReportQueryResult(
        'overview',
        withHarness({
          ...first,
          priceMeasurement: { ...first.priceMeasurement, knownCost: first.total + 1 },
        }),
        overviewRequest,
      ),
    ).toThrow('match its aggregate cost');
    expect(() =>
      parseFocusedReportQueryResult('overview', withHarness({ ...first, unexpected: true }), overviewRequest),
    ).toThrow('unknown or missing');
  });

  test('projects breakdown groups with Cursor and project-editor context', () => {
    const result = projectFocusedBreakdown(rows, support, { query: overviewRequest.query });

    expect(result.groups.projects.map(({ key }) => key)).toEqual(['ai usage', 'side']);
    expect(result.groups.projects.map(({ label }) => label)).toEqual(['ai-usage', 'side']);
    expect(result.groups.models.reduce((sum, group) => sum + group.sessions, 0)).toBe(3);
    expect(result.context.cursorCommitAttribution).toEqual(support.datasets?.cursorCommitAttribution ?? []);
    expect(result.context.projectGroupConfigs).toEqual(support.projectGroupConfigs);
    expect(result.context.warnings).toEqual(support.warnings);
    expect(
      parseFocusedReportQueryResult('breakdown', JSON.parse(JSON.stringify(result)), { query: overviewRequest.query }),
    ).toEqual(result);
  });

  test('projects each exact harness-provider pair without losing or duplicating totals', () => {
    const jointRows: SerializedRow[] = [
      { ...row('codex-codex', 1, 1), harness: 'Codex', provider: 'Codex API' },
      { ...row('codex-anthropic', 2, 2), harness: 'Codex', provider: 'Anthropic' },
      { ...row('claude-anthropic', 3, 3), harness: 'Claude Code', provider: 'Anthropic' },
    ];
    const result = projectFocusedBreakdown(jointRows, support, {
      query: { ...overviewRequest.query, range: { from: null, to: null } },
    });
    const pairs = result.groups.harnessProviders;

    expect(pairs.map(({ harness, provider, sessions }) => ({ harness, provider, sessions }))).toEqual([
      { harness: 'Claude Code', provider: 'Anthropic', sessions: 1 },
      { harness: 'Codex', provider: 'Anthropic', sessions: 1 },
      { harness: 'Codex', provider: 'Codex API', sessions: 1 },
    ]);
    expect(
      pairs
        .filter(({ harness }) => harness === 'Codex')
        .map(({ provider }) => provider)
        .sort(),
    ).toEqual(['Anthropic', 'Codex API']);
    expect(
      pairs
        .filter(({ provider }) => provider === 'Anthropic')
        .map(({ harness }) => harness)
        .sort(),
    ).toEqual(['Claude Code', 'Codex']);
    expect(
      pairs.reduce(
        (totals, group) => ({
          cache: totals.cache + group.cache,
          costSum: totals.costSum + group.costSum,
          fresh: totals.fresh + group.fresh,
          inp: totals.inp + group.inp,
          sessions: totals.sessions + group.sessions,
          tools: totals.tools + group.tools,
          turns: totals.turns + group.turns,
        }),
        { cache: 0, costSum: 0, fresh: 0, inp: 0, sessions: 0, tools: 0, turns: 0 },
      ),
    ).toEqual({ cache: 6, costSum: 6, fresh: 18, inp: 6, sessions: 3, tools: 6, turns: 6 });
  });

  test('preserves complete, partial, absent, and measured-zero project line coverage', () => {
    const lineRows: SerializedRow[] = [
      { ...row('complete-a', 2, 1, 'complete'), linesAdded: 3, linesDeleted: 1 },
      { ...row('complete-b', 3, 1, 'complete'), linesAdded: 0, linesDeleted: 2 },
      { ...row('partial-a', 2, 1, 'partial'), linesAdded: 4, linesDeleted: 1 },
      { ...row('partial-b', 3, 1, 'partial'), linesAdded: null, linesDeleted: 2 },
      { ...row('unmeasured', 2, 1, 'unmeasured'), linesAdded: null, linesDeleted: null },
      { ...row('measured-zero', 2, 1, 'measured-zero'), linesAdded: 0, linesDeleted: 0 },
    ];

    const result = projectFocusedBreakdown(lineRows, support, { query: overviewRequest.query });
    const lineGroups = Object.fromEntries(
      result.groups.projects.map(({ key, lineMeasurement, linesAdded, linesDeleted }) => [
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
    expect(
      parseFocusedReportQueryResult('breakdown', JSON.parse(JSON.stringify(result)), {
        query: overviewRequest.query,
      }),
    ).toEqual(result);
  });

  test('uses source model segments for model filters, timelines, and breakdowns', () => {
    const mixedModelRow: SerializedRow = {
      ...row('mixed-model', 5, 3),
      costApprox: 3,
      freshTokens: 30,
      model: 'gpt-5.4',
      models: ['gpt-5.4', 'claude-sonnet-4-6'],
      modelSegments: [
        {
          costApprox: 2,
          costKnown: true,
          model: 'gpt-5.4',
          tokCr: 0,
          tokCw: 0,
          tokIn: 10,
          tokOut: 0,
        },
        {
          costApprox: 1,
          costKnown: true,
          model: 'claude-sonnet-4-6',
          tokCr: 0,
          tokCw: 0,
          tokIn: 0,
          tokOut: 20,
        },
      ],
      tokCr: 0,
      tokCw: 0,
      tokIn: 10,
      tokOut: 20,
      tokenTotal: 30,
    };
    const unboundedQuery = { ...overviewRequest.query, range: { from: null, to: null } };

    const overview = projectFocusedOverview([mixedModelRow], support, {
      ...overviewRequest,
      query: unboundedQuery,
    });
    const breakdown = projectFocusedBreakdown([mixedModelRow], support, { query: unboundedQuery });
    const filtered = projectFocusedBreakdown([mixedModelRow], support, {
      query: {
        ...unboundedQuery,
        filters: { ...unboundedQuery.filters, fields: { model: 'claude-sonnet-4-6' } },
      },
    });

    expect(overview.timeline?.series.map(({ key, sessions, total }) => ({ key, sessions, total }))).toEqual([
      { key: 'gpt-5.4', sessions: 1, total: 2 },
      { key: 'claude-sonnet-4-6', sessions: 0, total: 1 },
    ]);
    expect(overview.timeline?.grandSessions).toBe(1);
    expect(
      breakdown.groups.models.map(({ costSum, fresh, inp, key, sessions }) => ({
        costSum,
        fresh,
        inp,
        key,
        sessions,
      })),
    ).toEqual([
      { costSum: 2, fresh: 10, inp: 10, key: 'gpt-5.4', sessions: 1 },
      { costSum: 1, fresh: 20, inp: 0, key: 'claude-sonnet-4-6', sessions: 1 },
    ]);
    expect(filtered.groups.harnesses[0]?.sessions).toBe(1);
  });

  test('rejects malformed nested Breakdown groups and context at the transport boundary', () => {
    const request = { query: overviewRequest.query };
    const result = projectFocusedBreakdown(rows, support, request);
    const modelGroup = result.groups.models[0];
    if (!modelGroup) {
      throw new Error('The Breakdown fixture must include a model group');
    }

    expect(() =>
      parseFocusedReportQueryResult(
        'breakdown',
        { ...result, groups: { ...result.groups, models: [{ key: 'incomplete' }] } },
        request,
      ),
    ).toThrow('unknown or missing');
    expect(() =>
      parseFocusedReportQueryResult(
        'breakdown',
        {
          ...result,
          groups: {
            ...result.groups,
            models: [{ ...modelGroup, unpriced: 0, unpricedFreshTokens: 1 }],
          },
        },
        request,
      ),
    ).toThrow();
    expect(() =>
      parseFocusedReportQueryResult(
        'breakdown',
        { ...result, context: { ...result.context, cursorCommitAttribution: [{ commitHash: 'incomplete' }] } },
        request,
      ),
    ).toThrow('cursorCommitAttribution');
  });

  test('prunes large destination-only context from bootstrap support', () => {
    const analyticsGroup = projectFocusedBreakdown(rows, support, { query: overviewRequest.query }).groups.harnesses[0];
    if (!analyticsGroup) {
      throw new Error('The Breakdown fixture must include an analytics group');
    }
    const bloatedSupport: FocusedReportSupport = {
      ...support,
      analytics: { ...support.analytics, byHarness: Array.from({ length: 10_000 }, () => analyticsGroup) },
      datasets: { ...support.datasets, futureDataset: Array.from({ length: 10_000 }, (_, index) => ({ index })) },
      facets: { futureFacet: Array.from({ length: 10_000 }, (_, index) => ({ index })) },
    };
    const result = projectFocusedSupport(
      bloatedSupport,
      {
        harness: ['Claude Code', 'Codex'],
        machine: [{ label: 'Machine A', value: 'machine-a' }],
        truncated: false,
      },
      { revision: 'revision-a' },
    );

    expect(result.filterOptions.harness).toEqual(['Claude Code', 'Codex']);
    expect(result.support.datasets).toBeUndefined();
    expect(result.support.analytics.byHarness).toEqual([]);
    expect(result.support).not.toHaveProperty('facets');
    expect(result.support).not.toHaveProperty('projectGroupConfigs');
    expect(result.support).not.toHaveProperty('projectGroups');
    expect(result.support.warnings).toEqual(support.warnings);
  });

  test('carries bounded exact-revision machine freshness and accounts for entries omitted by the bootstrap budget', () => {
    const machineFreshness: FocusedMachineFreshness = {
      kind: 'available',
      machines: [
        { id: 'machine-a', label: 'Machine A', lastSeenAt: '2026-07-13T11:00:00.000Z' },
        {
          id: 'machine-too-large',
          label: 'x'.repeat(MAX_SERVED_BOOTSTRAP_BYTES),
          lastSeenAt: '2026-07-13T10:00:00.000Z',
        },
      ],
      observedAt: '2026-07-13T12:00:00.000Z',
      omittedMachines: 3,
      skippedRows: 2,
    };
    const result = projectFocusedSupport(
      { ...support, machineFreshness },
      { harness: [], machine: [], truncated: false },
      { revision: 'revision-a' },
    );
    const acceptedMachine = machineFreshness.machines[0];
    if (!acceptedMachine) {
      throw new Error('The freshness fixture must include its accepted machine');
    }

    expect(result.machineFreshness).toEqual({
      kind: 'available',
      machines: [acceptedMachine],
      observedAt: machineFreshness.observedAt,
      omittedMachines: 4,
      skippedRows: 2,
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX_SERVED_BOOTSTRAP_BYTES);
  });

  test('caps machine freshness at 100 entries with exact source omission accounting', () => {
    const result = projectFocusedSupport(
      {
        ...support,
        machineFreshness: {
          kind: 'available',
          machines: Array.from({ length: 101 }, (_, index) => ({
            id: `machine-${index}`,
            label: `Machine ${index}`,
            lastSeenAt: '2026-07-13T11:00:00.000Z',
          })),
          observedAt: support.generatedAt,
          omittedMachines: 3,
          skippedRows: 0,
        },
      },
      { harness: [], machine: [], truncated: false },
      { revision: 'revision-a' },
    );

    expect(result.machineFreshness.kind).toBe('available');
    if (result.machineFreshness.kind !== 'available') {
      throw new Error('The bounded freshness fixture must remain available');
    }
    expect(result.machineFreshness.machines).toHaveLength(100);
    expect(result.machineFreshness.omittedMachines).toBe(4);
  });

  test('marks freshness unavailable when the bootstrap budget cannot retain any captured machine', () => {
    const result = projectFocusedSupport(
      {
        ...support,
        machineFreshness: {
          kind: 'available',
          machines: [
            {
              id: 'machine-too-large',
              label: 'x'.repeat(MAX_SERVED_BOOTSTRAP_BYTES),
              lastSeenAt: '2026-07-13T11:00:00.000Z',
            },
          ],
          observedAt: support.generatedAt,
          omittedMachines: 2,
          skippedRows: 1,
        },
      },
      { harness: [], machine: [], truncated: false },
      { revision: 'revision-a' },
    );

    expect(result.machineFreshness).toEqual({
      kind: 'unavailable',
      observedAt: support.generatedAt,
      omittedMachines: 3,
      reason: 'bootstrap-budget',
      skippedRows: 1,
    });
  });

  test('makes absent freshness explicit and strictly validates both freshness result variants', () => {
    const request = { revision: 'revision-a' };
    const notCaptured = projectFocusedSupport(support, { harness: [], machine: [], truncated: false }, request);

    expect(notCaptured.machineFreshness).toEqual({
      kind: 'unavailable',
      observedAt: support.generatedAt,
      omittedMachines: 0,
      reason: 'not-captured',
      skippedRows: 0,
    });
    expect(parseFocusedReportQueryResult('support', JSON.parse(JSON.stringify(notCaptured)), request)).toEqual(
      notCaptured,
    );

    const available = projectFocusedSupport(
      {
        ...support,
        machineFreshness: {
          kind: 'available',
          machines: [{ id: 'machine-a', label: 'Machine A', lastSeenAt: '2026-07-13T11:00:00.000Z' }],
          observedAt: support.generatedAt,
          omittedMachines: 1,
          skippedRows: 2,
        },
      },
      { harness: [], machine: [], truncated: false },
      request,
    );
    if (available.machineFreshness.kind !== 'available') {
      throw new Error('The freshness fixture must remain available');
    }
    expect(parseFocusedReportQueryResult('support', JSON.parse(JSON.stringify(available)), request)).toEqual(available);

    const invalidFreshnessValues = [
      { ...available.machineFreshness, unexpected: true },
      { ...available.machineFreshness, observedAt: '2026-07-13T12:00:00Z' },
      { ...available.machineFreshness, observedAt: '2026-07-14T12:00:00.000Z' },
      { ...available.machineFreshness, omittedMachines: -1 },
      { ...available.machineFreshness, skippedRows: 0.5 },
      {
        ...available.machineFreshness,
        machines: [...available.machineFreshness.machines, ...available.machineFreshness.machines],
      },
      {
        kind: 'available',
        machines: [{ id: '', label: 'Machine A', lastSeenAt: support.generatedAt }],
        observedAt: support.generatedAt,
        omittedMachines: 0,
        skippedRows: 0,
      },
      {
        kind: 'available',
        machines: [{ id: 'machine-a', label: '', lastSeenAt: support.generatedAt }],
        observedAt: support.generatedAt,
        omittedMachines: 0,
        skippedRows: 0,
      },
      {
        kind: 'unavailable',
        observedAt: support.generatedAt,
        omittedMachines: 0,
        reason: 'network-error',
        skippedRows: 0,
      },
    ];
    for (const machineFreshness of invalidFreshnessValues) {
      expect(() => parseFocusedReportQueryResult('support', { ...available, machineFreshness }, request)).toThrow();
    }
  });

  test('rejects malformed nested bootstrap support at the transport boundary', () => {
    const request = { revision: 'revision-a' };
    const dateDomain = { first: '2026-07-01T10:00:00.000Z', last: '2026-07-04T10:00:00.000Z' };
    const result = projectFocusedSupport(
      support,
      {
        harness: ['Claude Code', 'Codex'],
        machine: [{ label: 'Machine A', value: 'machine-a' }],
        truncated: false,
      },
      request,
      { dateDomain },
    );
    const invalidSupportValues = [
      { ...result.support, unexpected: true },
      { ...result.support, analytics: { ...result.support.analytics, byHarness: [{ key: 'incomplete' }] } },
      { ...result.support, analytics: { ...result.support.analytics, sessionCount: -1 } },
      { ...result.support, filters: { ...result.support.filters, sort: 'unknown' } },
      { ...result.support, generatedAt: '2026-07-13T12:00:00Z' },
      { ...result.support, omittedRows: -1 },
      { ...result.support, warnings: [{ message: 1 }] },
      {
        ...result.support,
        datasets: {
          providerStatus: {
            generatedAt: result.support.generatedAt,
            providers: [],
            schemaVersion: 2,
          },
        },
      },
    ];

    expect(result.dateDomain).toEqual(dateDomain);
    expect(parseFocusedReportQueryResult('support', JSON.parse(JSON.stringify(result)), request)).toEqual(result);
    for (const invalidSupport of invalidSupportValues) {
      expect(() => parseFocusedReportQueryResult('support', { ...result, support: invalidSupport }, request)).toThrow();
    }
    const { truncation: _truncation, ...withoutTruncation } = result;
    expect(() => parseFocusedReportQueryResult('support', withoutTruncation, request)).toThrow('unknown or missing');
    expect(() =>
      parseFocusedReportQueryResult(
        'support',
        { ...result, truncation: { ...result.truncation, warningsOmitted: -1 } },
        request,
      ),
    ).toThrow('non-negative safe integer');
    const invalidDateDomains = [
      undefined,
      { first: dateDomain.first },
      { first: '2026-07-01T10:00:00Z', last: dateDomain.last },
      { first: '2026-07-05T10:00:00.000Z', last: dateDomain.last },
      { ...dateDomain, unexpected: true },
    ];
    for (const invalidDateDomain of invalidDateDomains) {
      expect(() =>
        parseFocusedReportQueryResult('support', { ...result, dateDomain: invalidDateDomain }, request),
      ).toThrow();
    }

    const emptyResult = projectFocusedSupport(support, { harness: [], machine: [], truncated: false }, request);
    expect(emptyResult.dateDomain).toBeNull();
    expect(parseFocusedReportQueryResult('support', JSON.parse(JSON.stringify(emptyResult)), request)).toEqual(
      emptyResult,
    );
  });

  test('keeps the supported 50,000-row focused projections inside frozen byte budgets', () => {
    const maximumRows = Array.from({ length: 50_000 }, (_, index) => {
      const fixtureRow = row(
        `audit-${REPORT_AUDIT_FIXTURE_SEED}-${index}`,
        (index % 28) + 1,
        (index % 1000) / 100,
        `project-${index}`,
      );
      const fixtureSource = fixtureRow.source;
      if (!fixtureSource) {
        throw new Error('The deterministic audit row must include source identity');
      }
      const { harnessKey } = fixtureSource;
      if (!harnessKey) {
        throw new Error('The deterministic audit row must include a harness key');
      }
      return {
        ...fixtureRow,
        source: {
          ...fixtureSource,
          harnessKey,
          rootSourceSessionId: `audit-root-${index}`,
          sourceSessionId: `audit-session-${index}`,
        },
      };
    });
    const maximumSupport = {
      ...support,
      analytics: { ...support.analytics, sessionCount: maximumRows.length },
    };
    const request: FocusedOverviewRequest = {
      includeAdvanced: true,
      query: {
        filters: { fields: {}, harness: [], machine: [], query: '' },
        range: { from: null, to: null },
        revision: 'audit-revision',
      },
      timeline: { dimension: 'harness', granularity: 'day' },
    };
    const bootstrap = projectFocusedSupport(
      maximumSupport,
      {
        harness: ['Claude Code', 'Codex'],
        machine: [{ label: 'Machine A', value: 'machine-a' }],
        truncated: false,
      },
      { revision: request.query.revision },
    );
    const overview = projectFocusedOverview(maximumRows, maximumSupport, request);
    const breakdown = projectFocusedBreakdown(maximumRows, maximumSupport, { query: request.query });
    const breakdownBytes = Buffer.byteLength(JSON.stringify(breakdown));

    expect(Buffer.byteLength(JSON.stringify(bootstrap))).toBeLessThanOrEqual(MAX_SERVED_BOOTSTRAP_BYTES);
    expect(Buffer.byteLength(JSON.stringify(overview))).toBeLessThanOrEqual(MAX_OVERVIEW_REFRESH_BYTES);
    expect(breakdownBytes).toBeGreaterThan(MAX_OVERVIEW_REFRESH_BYTES);
    expect(breakdownBytes).toBeLessThanOrEqual(MAX_BREAKDOWN_REFRESH_BYTES);
    expect(breakdown.groups.projects).toHaveLength(maximumRows.length);
    expect(overview.summary.sessionCount).toBe(maximumRows.length);
  }, 30_000);
});
