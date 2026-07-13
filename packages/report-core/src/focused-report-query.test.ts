import { describe, expect, test } from 'bun:test';
import { serializedRowsToCSV } from './csv';
import {
  type FocusedOverviewRequest,
  type FocusedReportSupport,
  focusedAdvancedAnalysisFingerprint,
  focusedOverviewFingerprint,
  parseFocusedCsvRequest,
  parseFocusedOverviewRequest,
  parseFocusedReportQueryResult,
  projectFocusedBreakdown,
  projectFocusedCsv,
  projectFocusedHtmlPayload,
  projectFocusedOverview,
  projectFocusedSupport,
} from './focused-report-query';
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
  freshTokens: day * 10,
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
  projectGroupConfigs: [{ id: 'group-a', name: 'Group A', sources: [{ project: 'ai-usage' }] }],
  projectGroups: [],
  warnings: [{ message: 'warning' }],
};

const overviewRequest: FocusedOverviewRequest = {
  includeAdvanced: true,
  query: {
    filters: { fields: {}, harness: [], machine: [], query: '' },
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
    expect(focusedAdvancedAnalysisFingerprint(overviewRequest.query)).toStartWith('focused-advanced-analysis-v1:');
    expect(focusedAdvancedAnalysisFingerprint(overviewRequest.query)).not.toBe(
      focusedAdvancedAnalysisFingerprint({ ...overviewRequest.query, revision: 'revision-b' }),
    );
    const { includeAdvanced: _includeAdvanced, ...requestWithoutAdvancedMode } = overviewRequest;
    expect(() => parseFocusedOverviewRequest(requestWithoutAdvancedMode)).toThrow('unknown or missing');
    expect(() => parseFocusedOverviewRequest({ ...overviewRequest, extra: true })).toThrow('unknown or missing');
    expect(() =>
      parseFocusedCsvRequest({ query: overviewRequest.query, sort: [{ desc: false, id: 'unknown' }] }),
    ).toThrow('invalid');
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
    expect(result.view.records?.topCost?.name).toBe('four');
    expect(result.view.topSessions.map(({ label }) => label)).toEqual(['four', 'three', 'two']);
    expect(result.view.sessionShape?.totalPoints).toBe(3);
    expect(result.view.punchcard?.maxSessions).toBe(1);
    expect(result.view.advancedSummary?.hasSessionShape).toBe(true);
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

    const undatedRows = rows.map((sourceRow) => ({ ...sourceRow, activeDate: null, date: null }));
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

  test('projects breakdown groups with Cursor and project-editor context', () => {
    const result = projectFocusedBreakdown(rows, support, { query: overviewRequest.query });

    expect(result.groups.projects.map(({ key }) => key)).toEqual(['ai-usage', 'side']);
    expect(result.groups.models.reduce((sum, group) => sum + group.sessions, 0)).toBe(3);
    expect(result.context.cursorCommitAttribution).toEqual(support.datasets?.cursorCommitAttribution ?? []);
    expect(result.context.projectGroupConfigs).toEqual(support.projectGroupConfigs);
    expect(result.context.warnings).toEqual(support.warnings);
    expect(
      parseFocusedReportQueryResult('breakdown', JSON.parse(JSON.stringify(result)), { query: overviewRequest.query }),
    ).toEqual(result);
  });

  test('rejects malformed nested Breakdown groups and context at the transport boundary', () => {
    const request = { query: overviewRequest.query };
    const result = projectFocusedBreakdown(rows, support, request);

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
        { ...result, context: { ...result.context, cursorCommitAttribution: [{ commitHash: 'incomplete' }] } },
        request,
      ),
    ).toThrow('cursorCommitAttribution');
  });

  test('produces complete filtered CSV and full compatibility HTML payloads', () => {
    const csvRequest = { query: overviewRequest.query, sort: [{ desc: true, id: 'total' as const }] };
    const csv = projectFocusedCsv(rows, csvRequest);
    const expectedRows = [rows[3]!, rows[2]!, rows[1]!];

    expect(csv.rowCount).toBe(3);
    expect(csv.csv).toBe(serializedRowsToCSV(expectedRows));
    const html = projectFocusedHtmlPayload(rows, support, { revision: 'revision-a' });
    expect(html.payload.rows).toEqual(rows);
    expect(html.payload.tableRows).toEqual(rows.slice(0, 2));
    expect(html.rowCount).toBe(rows.length);
  });

  test('rejects malformed nested HTML compatibility payloads at the transport boundary', () => {
    const request = { revision: 'revision-a' };
    const result = projectFocusedHtmlPayload(rows, support, request);
    const firstRow = result.payload.rows[0];
    const firstTableRow = result.payload.tableRows[0];
    if (!(firstRow && firstTableRow)) {
      throw new Error('The HTML compatibility fixture must include report rows');
    }
    const invalidPayloadValues = [
      { ...result.payload, unexpected: true },
      { ...result.payload, analytics: { ...result.payload.analytics, byHarness: [{ key: 'incomplete' }] } },
      { ...result.payload, filters: { ...result.payload.filters, sort: 'unknown' } },
      { ...result.payload, generatedAt: '2026-07-13T12:00:00Z' },
      { ...result.payload, omittedRows: -1 },
      { ...result.payload, rows: [{ ...firstRow, tokIn: -1 }] },
      { ...result.payload, tableRows: [{ ...firstTableRow, unexpected: true }] },
      { ...result.payload, datasets: { providerStatus: { schemaVersion: 2 } } },
      { ...result.payload, facets: [] },
      {
        ...result.payload,
        projectGroupConfigs: [{ ...result.payload.projectGroupConfigs?.[0], unexpected: true }],
      },
      { ...result.payload, projectGroups: [{ key: 'incomplete' }] },
      { ...result.payload, warnings: [{ message: 1 }] },
    ];

    expect(parseFocusedReportQueryResult('html-payload', JSON.parse(JSON.stringify(result)), request)).toEqual(result);
    for (const invalidPayload of invalidPayloadValues) {
      expect(() =>
        parseFocusedReportQueryResult('html-payload', { ...result, payload: invalidPayload }, request),
      ).toThrow();
    }
    expect(() =>
      parseFocusedReportQueryResult('html-payload', { ...result, rowCount: rows.length - 1 }, request),
    ).toThrow('compatibility payload');
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
      { harness: ['Claude Code', 'Codex'], machine: ['Machine A'], truncated: false },
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

  test('rejects malformed nested bootstrap support at the transport boundary', () => {
    const request = { revision: 'revision-a' };
    const dateDomain = { first: '2026-07-01T10:00:00.000Z', last: '2026-07-04T10:00:00.000Z' };
    const result = projectFocusedSupport(
      support,
      { harness: ['Claude Code', 'Codex'], machine: ['Machine A'], truncated: false },
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
      { harness: ['Claude Code', 'Codex'], machine: ['Machine A'], truncated: false },
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
