import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { harnessProviderAnalyticsKey } from '@ai-usage/report-core/analytics';
import {
  type FocusedOverviewRequest,
  type FocusedReportSupport,
  parseFocusedReportQueryResult,
  projectFocusedBreakdown,
  projectFocusedOverview,
  projectFocusedSupport,
} from '@ai-usage/report-core/focused-report-query';
import {
  MAX_BREAKDOWN_REFRESH_BYTES,
  MAX_OVERVIEW_REFRESH_BYTES,
  REPORT_AUDIT_FIXTURE_SEED,
} from '@ai-usage/report-core/report-budgets';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import { enrichSessionPresentationRow } from '@ai-usage/report-core/session-query';
import { localTimeRowFields } from '@ai-usage/report-core/test-fixtures/local-time-row';
import { Effect } from 'effect';
import { executeFocusedReportQuery } from './focused-report-query-sqlite';
import { createServedRevisionQueryDatabase } from './served-revision';
import { assertSessionQueryDatabase, type SessionQuerySqliteDatabase } from './session-query-sqlite';
import { publishServedReportRevision, updateUsageMachineLabel } from './writer';

const UNBOUNDED_PRESENTATION_SCAN_PATTERN = /SELECT\s+row_json\s+FROM\s+session_rows\s+ORDER BY/u;
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { force: true, recursive: true })));
  temporaryDirectories.clear();
});

const row = (name: string, day: number, cost: number): SerializedRow => ({
  activeDate: `2026-07-0${day}T10:00:00.000Z`,
  calls: day,
  costActual: cost / 2,
  costApprox: cost,
  costKnown: true,
  date: `2026-07-0${day}T09:00:00.000Z`,
  durationMs: day * 60_000,
  endDate: `2026-07-0${day}T10:00:00.000Z`,
  freshTokens: day * 3,
  harness: day % 2 ? 'Codex' : 'Claude Code',
  lineDelta: day,
  linesAdded: day,
  linesDeleted: 0,
  model: day % 2 ? 'gpt-5.4' : 'claude-opus-4-6',
  name,
  project: 'AI Usage — Machine A',
  projectGroupId: 'group:ai-usage',
  provider: day % 2 ? 'Codex API' : 'Anthropic',
  rawProject: 'ai-usage',
  sessionLabel: name,
  source: {
    harnessKey: 'codex',
    machineId: 'machine-a',
    machineLabel: 'Machine A',
    ...(name === 'two' ? { parentSourceSessionId: 'one' } : {}),
    rootSourceSessionId: name === 'two' ? 'one' : name,
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

const rows = [
  row('one', 1, 1),
  {
    ...row('two', 2, 2),
    costKnown: false,
    modelSegments: [
      {
        costApprox: 2,
        costKnown: true,
        model: 'claude-opus-4-6',
        tokCr: 1,
        tokCw: 1,
        tokIn: 1,
        tokOut: 0,
      },
      {
        costApprox: 0,
        costKnown: false,
        model: 'unpriced-model',
        tokCr: 1,
        tokCw: 1,
        tokIn: 1,
        tokOut: 2,
      },
    ],
  },
  row('three', 3, 3),
  row('four', 4, 4),
];
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
  filters: { limit: 2, minTokens: 0, project: null, since: null, sort: 'date' },
  generatedAt: '2026-07-13T12:00:00.000Z',
  omittedRows: 0,
  timeZone: 'UTC',
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

type TestQueryDatabase = SessionQuerySqliteDatabase & { readonly close: () => void };

const publishFixture = async (
  revisionDirectory: string,
  fixtureRows: readonly SerializedRow[],
  fixtureSupport: FocusedReportSupport,
  revision = 'revision-a',
): Promise<string> => {
  const dbPath = path.join(revisionDirectory, 'usage.sqlite');
  await Effect.runPromise(
    updateUsageMachineLabel({
      dbPath,
      machine: { id: 'machine-a', label: 'Machine A' },
      updatedAt: new Date(fixtureSupport.generatedAt),
    }),
  );
  await Effect.runPromise(
    publishServedReportRevision({
      assemble: () => ({
        configFingerprint: 'c'.repeat(64),
        generatedAt: fixtureSupport.generatedAt,
        projectAliases: [],
        projectGroupConfigs: [],
        rows: fixtureRows,
        sourceAuthorities: fixtureRows.map(() => 'local-observed' as const),
        support: fixtureSupport,
      }),
      dbPath,
      now: 1000,
      revision,
      ttlMs: 300_000,
    }),
  );
  return dbPath;
};

const openServedFixture = (dbPath: string, revision: string): TestQueryDatabase => {
  const rawDatabase = new Database(dbPath, { readonly: true });
  const scoped = createServedRevisionQueryDatabase(rawDatabase, revision) as SessionQuerySqliteDatabase;
  const database = { close: () => rawDatabase.close(), query: (sql: string) => scoped.query(sql) };
  assertSessionQueryDatabase(database);
  return database;
};

const fixture = async (): Promise<{ database: TestQueryDatabase; revisionDirectory: string }> => {
  const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-focused-query-'));
  temporaryDirectories.add(revisionDirectory);
  const dbPath = await publishFixture(revisionDirectory, rows, support);
  const database = openServedFixture(dbPath, 'revision-a');
  return { database, revisionDirectory };
};

describe('focused report SQLite queries', () => {
  test('matches pure Overview and Breakdown projections with bounded query counts', async () => {
    const { database } = await fixture();
    const overviewTrace: string[] = [];
    try {
      const overview = executeFocusedReportQuery(database, 'overview', overviewRequest, ({ sql }) =>
        overviewTrace.push(sql),
      );
      expect(overview).toEqual(projectFocusedOverview(rows, support, overviewRequest));
      expect('dateDomain' in overview ? overview.dateDomain : undefined).toEqual({
        first: '2026-07-01T10:00:00.000Z',
        last: '2026-07-04T10:00:00.000Z',
      });
      if (!('view' in overview)) {
        throw new Error('The focused Overview query must return an Overview result');
      }
      expect(overview.summary.priceMeasurement).toEqual({
        knownCost: 9,
        state: 'partially measured',
        unpricedFreshTokens: 4,
      });
      expect(overview.timeline?.priceMeasurement).toEqual({
        knownCost: 10,
        state: 'partially measured',
        unpricedFreshTokens: 4,
      });
      expect(overview.view.topSessions.find(({ label }) => label === 'one')).toMatchObject({
        costApprox: 2,
        costKnown: false,
      });
      expect(overviewTrace).toHaveLength(2);
      expect(overviewTrace.some((sql) => sql.includes('source_row_json'))).toBe(false);
      expect(overviewTrace.some((sql) => sql.includes('LIMIT 50001'))).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(overview))).toBeLessThan(2 * 1024 * 1024);
      const basicOverviewRequest = { ...overviewRequest, includeAdvanced: false };
      const basicOverviewTrace: string[] = [];
      const basicOverview = executeFocusedReportQuery(database, 'overview', basicOverviewRequest, ({ sql }) =>
        basicOverviewTrace.push(sql),
      );
      expect(basicOverviewTrace.some((sql) => sql.includes('source_row_json'))).toBe(false);
      expect(basicOverviewTrace.some((sql) => UNBOUNDED_PRESENTATION_SCAN_PATTERN.test(sql))).toBe(false);
      expect(basicOverviewTrace.every((sql) => !sql.includes('SELECT * FROM session_rows'))).toBe(true);
      expect(basicOverviewTrace.some((sql) => sql.includes('executive_dimensions AS'))).toBe(true);
      const topSessionsSql = basicOverviewTrace.find((sql) => sql.includes('campaign_rollup AS'));
      expect(topSessionsSql).toBeDefined();
      expect(topSessionsSql).not.toContain('FROM visible AS matched');
      expect(topSessionsSql).not.toContain('root.row_json AS row_json');
      if (!('view' in basicOverview)) {
        throw new Error('The focused Overview query must return an Overview result');
      }
      expect(basicOverview.view.advancedSummary).toBeNull();
      expect(basicOverview.view.executive).toEqual({
        harnesses: [
          {
            key: 'Claude Code',
            label: 'Claude Code',
            priceMeasurement: { knownCost: 6, state: 'partially measured', unpricedFreshTokens: 4 },
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
            processedTokens: 19,
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
          {
            key: 'unpriced-model',
            label: 'unpriced-model',
            priceMeasurement: { knownCost: 0, state: 'partially measured', unpricedFreshTokens: 4 },
            processedTokens: 5,
            sessions: 1,
            total: 0,
          },
        ],
      });
      expect(basicOverview).toEqual(projectFocusedOverview(rows, support, basicOverviewRequest));
      expect(basicOverview.view.punchcard).toBeNull();
      expect(basicOverview.view.sessionShape).toBeNull();

      const breakdownRequest = { query: overviewRequest.query };
      const breakdownTrace: string[] = [];
      const breakdown = executeFocusedReportQuery(database, 'breakdown', breakdownRequest, ({ sql }) =>
        breakdownTrace.push(sql),
      );
      expect(breakdown).toEqual(projectFocusedBreakdown(rows, support, breakdownRequest));
      expect(breakdownTrace).toHaveLength(3);
      expect(breakdownTrace.some((sql) => sql.includes('source_row_json') || sql.includes('row_json'))).toBe(false);
      expect(breakdownTrace.every((sql) => !sql.includes('SELECT * FROM session_rows'))).toBe(true);
    } finally {
      database.close();
    }
  });

  test('keeps complete, partial, absent, and measured-zero project line coverage in pure parity', async () => {
    const projectRow = (
      name: string,
      day: number,
      project: string,
      linesAdded: number | null,
      linesDeleted: number | null,
    ): SerializedRow => ({
      ...row(name, day, 1),
      lineDelta: linesAdded === null && linesDeleted === null ? null : (linesAdded ?? 0) + (linesDeleted ?? 0),
      linesAdded,
      linesDeleted,
      project,
      projectGroupId: `group:${project}`,
      rawProject: project,
    });
    const lineRows: SerializedRow[] = [
      projectRow('complete-a', 2, 'complete', 3, 1),
      projectRow('complete-b', 3, 'complete', 0, 2),
      projectRow('partial-a', 2, 'partial', 4, 1),
      projectRow('partial-b', 3, 'partial', null, 2),
      projectRow('unmeasured', 2, 'unmeasured', null, null),
      projectRow('measured-zero', 2, 'measured-zero', 0, 0),
    ];
    const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-focused-line-coverage-'));
    temporaryDirectories.add(revisionDirectory);
    const dbPath = await publishFixture(revisionDirectory, lineRows, support);
    const database = openServedFixture(dbPath, 'revision-a');
    const request = { query: overviewRequest.query };

    try {
      const result = executeFocusedReportQuery(database, 'breakdown', request);
      expect(result).toEqual(projectFocusedBreakdown(lineRows, support, request));
      if (!('groups' in result)) {
        throw new Error('The focused Breakdown query must return Breakdown groups');
      }
      expect(
        Object.fromEntries(
          result.groups.projects.map(({ key, lineMeasurement, linesAdded, linesDeleted }) => [
            key,
            { lineMeasurement, linesAdded, linesDeleted },
          ]),
        ),
      ).toEqual({
        'group:complete': {
          lineMeasurement: { measuredSessions: 2, totalSessions: 2 },
          linesAdded: 3,
          linesDeleted: 3,
        },
        'group:measured-zero': {
          lineMeasurement: { measuredSessions: 1, totalSessions: 1 },
          linesAdded: 0,
          linesDeleted: 0,
        },
        'group:partial': {
          lineMeasurement: { measuredSessions: 1, totalSessions: 2 },
          linesAdded: 4,
          linesDeleted: 1,
        },
        'group:unmeasured': {
          lineMeasurement: { measuredSessions: 0, totalSessions: 1 },
          linesAdded: 0,
          linesDeleted: 0,
        },
      });
    } finally {
      database.close();
    }
  });

  test('keeps campaign, machine, origin, and project timelines in pure/SQLite parity', async () => {
    const { database } = await fixture();
    const baseRequest: FocusedOverviewRequest = {
      ...overviewRequest,
      includeAdvanced: false,
      query: { ...overviewRequest.query, range: { from: null, to: null } },
    };
    try {
      const results = new Map<string, ReturnType<typeof projectFocusedOverview>>();
      for (const dimension of ['campaign', 'machine', 'origin', 'project'] as const) {
        const request: FocusedOverviewRequest = {
          ...baseRequest,
          timeline: { dimension, granularity: 'day' },
        };
        const overview = executeFocusedReportQuery(database, 'overview', request);
        expect(overview).toEqual(projectFocusedOverview(rows, support, request));
        if (!('timeline' in overview)) {
          throw new Error(`The ${dimension} focused query must return an Overview result`);
        }
        results.set(dimension, overview);
      }

      expect(results.get('campaign')?.timeline?.series.find(({ label }) => label === 'one')).toMatchObject({
        label: 'one',
        sessions: 2,
        total: 3,
      });
      expect(results.get('machine')?.timeline?.series).toEqual([
        expect.objectContaining({ key: 'machine-a', label: 'Machine A', sessions: 4, total: 10 }),
      ]);
      expect(results.get('origin')?.timeline?.series).toEqual([]);
      expect(results.get('origin')?.timeline?.unclassified).toMatchObject({ causes: [], sessions: 4, total: 10 });
      expect(results.get('project')?.timeline?.series).toEqual([
        expect.objectContaining({ key: 'group:ai-usage', label: 'AI Usage — Machine A', sessions: 4, total: 10 }),
      ]);

      const filteredCampaignRequest: FocusedOverviewRequest = {
        ...baseRequest,
        query: {
          ...baseRequest.query,
          filters: { ...baseRequest.query.filters, harness: ['Claude Code'] },
        },
        timeline: { dimension: 'campaign', granularity: 'day' },
      };
      const filteredCampaign = executeFocusedReportQuery(database, 'overview', filteredCampaignRequest);
      expect(filteredCampaign).toEqual(projectFocusedOverview(rows, support, filteredCampaignRequest));
      if (!('timeline' in filteredCampaign)) {
        throw new Error('The filtered campaign query must return an Overview result');
      }
      expect(filteredCampaign.timeline?.series.find(({ label }) => label === 'one')).toMatchObject({
        label: 'one',
        sessions: 1,
        total: 2,
      });
    } finally {
      database.close();
    }
  });

  test('keeps classified and unclassified processed-token timelines in pure/SQLite parity', async () => {
    const classified: SerializedRow = {
      ...row('classified', 1, 1),
      freshTokens: 15,
      origin: 'human',
      tokCr: 2,
      tokCw: 3,
      tokIn: 5,
      tokOut: 7,
      tokenTotal: 17,
    };
    const unclassified: SerializedRow = {
      ...row('unclassified', 2, 2),
      freshTokens: 49,
      originProvenance: 'origin-unsupported',
      tokCr: 11,
      tokCw: 13,
      tokIn: 17,
      tokOut: 19,
      tokenTotal: 60,
    };
    const fixtureRows = [classified, unclassified];
    const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-focused-timeline-tokens-'));
    temporaryDirectories.add(revisionDirectory);
    const database = openServedFixture(await publishFixture(revisionDirectory, fixtureRows, support), 'revision-a');
    const request: FocusedOverviewRequest = {
      ...overviewRequest,
      includeAdvanced: false,
      query: { ...overviewRequest.query, range: { from: null, to: null } },
      timeline: { dimension: 'origin', granularity: 'day' },
    };
    try {
      const overview = executeFocusedReportQuery(database, 'overview', request);
      const expected = projectFocusedOverview(fixtureRows, support, request);
      expect(overview).toEqual(expected);
      if (!('summary' in overview) || overview.timeline === null) {
        throw new Error('The SQLite token fixture must return an Overview timeline');
      }

      expect(overview.timeline).toMatchObject({
        grandTokens: 77,
        maxBucketTokens: 60,
        unclassified: { sessions: 1, tokens: 60 },
      });
      expect(overview.timeline.series).toEqual([expect.objectContaining({ key: 'human', sessions: 1, tokens: 17 })]);
      expect(overview.timeline.buckets.map(({ tokens }) => tokens)).toEqual([17, 60]);
      expect(overview.timeline.grandTokens).toBe(
        overview.summary.cacheRead + overview.summary.cacheWrite + overview.summary.tokIn + overview.summary.tokOut,
      );
    } finally {
      database.close();
    }
  });

  test('keeps token-only model segments inside the bounded SQLite Other series', async () => {
    const primaryWithTokenOnlySegments: SerializedRow = {
      ...row('primary-with-token-only-segments', 1, 11),
      freshTokens: 13,
      model: 'model-11',
      modelSegments: [
        {
          costApprox: 11,
          costKnown: true,
          model: 'model-11',
          tokCr: 1,
          tokCw: 1,
          tokIn: 1,
          tokOut: 1,
        },
        {
          costApprox: 0,
          costKnown: true,
          model: 'token-only-a',
          tokCr: 2,
          tokCw: 3,
          tokIn: 0,
          tokOut: 0,
        },
        {
          costApprox: 0,
          costKnown: true,
          model: 'token-only-b',
          tokCr: 0,
          tokCw: 0,
          tokIn: 0,
          tokOut: 7,
        },
      ],
      models: ['model-11', 'token-only-a', 'token-only-b'],
      tokCr: 3,
      tokCw: 4,
      tokIn: 1,
      tokOut: 8,
      tokenTotal: 16,
    };
    const fixtureRows = [
      primaryWithTokenOnlySegments,
      ...Array.from({ length: 10 }, (_, index) => {
        const value = 10 - index;
        return { ...row(`model-${value}`, 1, value), model: `model-${value}` };
      }),
    ];
    const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-focused-token-other-'));
    temporaryDirectories.add(revisionDirectory);
    const database = openServedFixture(await publishFixture(revisionDirectory, fixtureRows, support), 'revision-a');
    const request: FocusedOverviewRequest = {
      ...overviewRequest,
      includeAdvanced: false,
      query: { ...overviewRequest.query, range: { from: null, to: null } },
    };
    try {
      const overview = executeFocusedReportQuery(database, 'overview', request);
      expect(overview).toEqual(projectFocusedOverview(fixtureRows, support, request));
      if (!('timeline' in overview) || overview.timeline === null) {
        throw new Error('The bounded SQLite token fixture must return an Overview timeline');
      }
      const other = overview.timeline.series.find(({ label }) => label === 'Other');
      if (other === undefined) {
        throw new Error('The bounded SQLite token fixture must produce an Other series');
      }

      expect(overview.timeline.series).toHaveLength(12);
      expect(other).toMatchObject({
        memberKeys: ['token-only-a', 'token-only-b'],
        sessions: 0,
        tokens: 12,
        total: 0,
      });
      expect(
        overview.timeline.buckets.find(({ byKey }) => byKey[other.key] !== undefined)?.byKey[other.key],
      ).toMatchObject({ cost: 0, sessions: 0, tokens: 12 });
    } finally {
      database.close();
    }
  });

  test('filters local punchcard cells with pure and SQLite focused row identity parity', async () => {
    const timedRow = (name: string, day: number, hour: number, minute: number): SerializedRow => ({
      ...row(name, 1, 1),
      ...localTimeRowFields(day, hour, minute),
    });
    const fixtureRows = [
      timedRow('monday-13:59', 27, 13, 59),
      timedRow('monday-14:00', 27, 14, 0),
      timedRow('monday-14:59', 27, 14, 59),
      timedRow('monday-15:00', 27, 15, 0),
      timedRow('sunday-14:00', 26, 14, 0),
      { ...row('missing-time', 1, 1), activeDate: null, date: null, endDate: null },
    ];
    const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-focused-time-cell-'));
    temporaryDirectories.add(revisionDirectory);
    const dbPath = await publishFixture(revisionDirectory, fixtureRows, support);
    const database = openServedFixture(dbPath, 'revision-a');
    try {
      for (const weekday of [0, 6] as const) {
        const request: FocusedOverviewRequest = {
          includeAdvanced: false,
          query: {
            ...overviewRequest.query,
            filters: { ...overviewRequest.query.filters, localTimeCell: { hour: 14, weekday } },
            range: { from: null, to: null },
          },
          timeline: { dimension: 'model', granularity: 'day' },
        };
        const expected = projectFocusedOverview(fixtureRows, support, request);
        const actual = executeFocusedReportQuery(database, 'overview', request);
        expect(actual).toEqual(expected);
        if (!('view' in actual)) {
          throw new Error('The local time cell query must return an Overview result');
        }
        expect(actual.summary.sessionCount).toBe(weekday === 0 ? 2 : 1);
        expect(actual.view.topSessions.map(({ row: itemRow }) => itemRow.rowId)).toEqual(
          expected.view.topSessions.map(({ row: itemRow }) => itemRow.rowId),
        );
      }
    } finally {
      database.close();
    }
  });

  test('keeps undeclared-origin sessions in filtered Overview and Breakdown projections', async () => {
    const originRows: SerializedRow[] = [
      { ...row('human', 1, 1), origin: 'human' },
      { ...row('delegated', 2, 2), origin: 'subagent' },
      { ...row('undeclared', 3, 3), originProvenance: 'origin-unsupported' },
    ];
    const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-focused-origin-filter-'));
    temporaryDirectories.add(revisionDirectory);
    const database = openServedFixture(await publishFixture(revisionDirectory, originRows, support), 'revision-a');
    const request: FocusedOverviewRequest = {
      includeAdvanced: false,
      query: {
        ...overviewRequest.query,
        filters: { ...overviewRequest.query.filters, origin: ['human'] },
        range: { from: null, to: null },
      },
      timeline: { dimension: 'origin', granularity: 'day' },
    };
    const breakdownRequest = { query: request.query };
    try {
      const overview = executeFocusedReportQuery(database, 'overview', request);
      const breakdown = executeFocusedReportQuery(database, 'breakdown', breakdownRequest);

      expect(overview).toEqual(projectFocusedOverview(originRows, support, request));
      expect(breakdown).toEqual(projectFocusedBreakdown(originRows, support, breakdownRequest));
      expect('summary' in overview ? overview.summary.sessionCount : null).toBe(2);
      expect('groups' in breakdown ? breakdown.groups.harnesses[0]?.sessions : null).toBe(2);
    } finally {
      database.close();
    }
  });

  test('serves pruned bootstrap support with bounded metadata', async () => {
    const { database } = await fixture();
    try {
      const revisionRequest = { revision: 'revision-a' };
      const supportResult = executeFocusedReportQuery(database, 'support', revisionRequest);
      expect(supportResult).toEqual(
        projectFocusedSupport(
          support,
          {
            harness: ['Claude Code', 'Codex'],
            machine: [{ label: 'Machine A', value: 'machine-a' }],
            truncated: false,
          },
          revisionRequest,
          {
            dateDomain: { first: '2026-07-01T10:00:00.000Z', last: '2026-07-04T10:00:00.000Z' },
            providerRows: [enrichSessionPresentationRow(rows[0]!), enrichSessionPresentationRow(rows[1]!)],
          },
        ),
      );
      expect('dateDomain' in supportResult ? supportResult.dateDomain : undefined).toEqual({
        first: '2026-07-01T10:00:00.000Z',
        last: '2026-07-04T10:00:00.000Z',
      });
      expect(Buffer.byteLength(JSON.stringify(supportResult))).toBeLessThan(512 * 1024);
    } finally {
      database.close();
    }
  });

  test('returns null support and Overview date domains when every session is undated', async () => {
    const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-focused-undated-'));
    temporaryDirectories.add(revisionDirectory);
    const undatedRows = rows.map((sourceRow) => ({ ...sourceRow, activeDate: null, date: null, endDate: null }));
    const database = openServedFixture(await publishFixture(revisionDirectory, undatedRows, support), 'revision-a');
    try {
      const revisionRequest = { revision: 'revision-a' };
      const supportResult = executeFocusedReportQuery(database, 'support', revisionRequest);
      expect('dateDomain' in supportResult ? supportResult.dateDomain : undefined).toBeNull();

      const request: FocusedOverviewRequest = {
        ...overviewRequest,
        includeAdvanced: false,
        query: { ...overviewRequest.query, range: { from: null, to: null } },
      };
      const overview = executeFocusedReportQuery(database, 'overview', request);
      if (!('summary' in overview)) {
        throw new Error('The undated focused query fixture must return an Overview result');
      }
      expect(overview.dateDomain).toBeNull();
      expect(overview.timeline).toBeNull();
      expect(overview.summary.sessionCount).toBe(undatedRows.length);
    } finally {
      database.close();
    }
  });

  test('matches segmented model filters, timeline, and Breakdown projections', async () => {
    const segmentedRow: SerializedRow = {
      ...row('multi-model', 3, 6),
      freshTokens: 77,
      model: 'gpt-5.4-high',
      modelSegments: [
        {
          costApprox: 0.5,
          costKnown: true,
          model: 'gpt-5.4-high',
          tokCr: 1,
          tokCw: 1,
          tokIn: 1,
          tokOut: 1,
        },
        {
          costApprox: 1.5,
          costKnown: true,
          model: 'gpt-5.4-fast',
          tokCr: 2,
          tokCw: 3,
          tokIn: 0,
          tokOut: 1,
        },
        {
          costApprox: 4,
          costKnown: true,
          model: 'claude-opus-4-6',
          tokCr: 30,
          tokCw: 40,
          tokIn: 10,
          tokOut: 20,
        },
      ],
      models: ['gpt-5.4-high', 'gpt-5.4-fast', 'claude-opus-4-6'],
      tokCr: 33,
      tokCw: 44,
      tokIn: 11,
      tokOut: 22,
      tokenTotal: 110,
    };
    const fixtureRows = [segmentedRow, { ...row('single-model', 4, 1), model: 'gpt-4.1' }];
    const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-focused-model-segments-'));
    temporaryDirectories.add(revisionDirectory);
    const database = openServedFixture(
      await publishFixture(revisionDirectory, fixtureRows, support, 'revision-segmented'),
      'revision-segmented',
    );
    const request: FocusedOverviewRequest = {
      includeAdvanced: false,
      query: {
        filters: {
          fields: { model: 'claude-opus-4-6' },
          harness: [],
          machine: [],
          query: '',
        },
        range: { from: null, to: null },
        revision: 'revision-segmented',
      },
      timeline: { dimension: 'model', granularity: 'day' },
    };
    try {
      const overview = executeFocusedReportQuery(database, 'overview', request);
      if (!('view' in overview) || overview.timeline === null) {
        throw new Error('The segmented focused query must return an Overview timeline');
      }
      expect(overview.view.executive).toEqual({
        harnesses: [
          {
            key: 'Codex',
            label: 'Codex',
            priceMeasurement: { knownCost: 6, state: 'measured', unpricedFreshTokens: 0 },
            processedTokens: 110,
            sessions: 1,
            total: 6,
          },
        ],
        models: [
          {
            key: 'claude-opus-4-6',
            label: 'claude-opus-4-6',
            priceMeasurement: { knownCost: 4, state: 'measured', unpricedFreshTokens: 0 },
            processedTokens: 100,
            sessions: 1,
            total: 4,
          },
          {
            key: 'gpt-5.4',
            label: 'gpt-5.4',
            priceMeasurement: { knownCost: 2, state: 'measured', unpricedFreshTokens: 0 },
            processedTokens: 10,
            sessions: 1,
            total: 2,
          },
        ],
      });
      expect(overview).toEqual(projectFocusedOverview(fixtureRows, support, request));
      expect(overview.summary.sessionCount).toBe(1);
      expect(overview.timeline.series).toEqual([
        {
          key: 'claude-opus-4-6',
          label: 'claude-opus-4-6',
          priceMeasurement: { knownCost: 4, state: 'measured', unpricedFreshTokens: 0 },
          sessions: 0,
          tokens: 100,
          total: 4,
        },
        {
          key: 'gpt-5.4',
          label: 'gpt-5.4',
          priceMeasurement: { knownCost: 2, state: 'measured', unpricedFreshTokens: 0 },
          sessions: 1,
          tokens: 10,
          total: 2,
        },
      ]);
      expect(overview.timeline.grandSessions).toBe(1);
      expect(overview.timeline.grandTokens).toBe(110);
      expect(overview.timeline.buckets[0]?.sessions).toBe(1);
      expect(overview.timeline.buckets[0]?.tokens).toBe(110);

      const breakdownRequest = { query: request.query };
      const breakdown = executeFocusedReportQuery(database, 'breakdown', breakdownRequest);
      expect(breakdown).toEqual(projectFocusedBreakdown(fixtureRows, support, breakdownRequest));
      if (!('groups' in breakdown)) {
        throw new Error('The segmented focused query must return Breakdown groups');
      }
      expect(
        breakdown.groups.models.map(({ cache, costSum, inp, key, lineCount, sessions, tools, turns }) => ({
          cache,
          costSum,
          inp,
          key,
          lineCount,
          sessions,
          tools,
          turns,
        })),
      ).toEqual([
        {
          cache: 30,
          costSum: 4,
          inp: 10,
          key: 'claude-opus-4-6',
          lineCount: 0,
          sessions: 1,
          tools: 0,
          turns: 0,
        },
        {
          cache: 3,
          costSum: 2,
          inp: 1,
          key: 'gpt-5.4',
          lineCount: 0,
          sessions: 1,
          tools: 0,
          turns: 0,
        },
      ]);
    } finally {
      database.close();
    }
  });

  test('preserves every exact harness-provider pair and its totals across pure and SQLite projections', async () => {
    const jointRows = [
      { ...row('a-one', 1, 1), harness: 'Harness "A"', provider: 'Provider\nOne' },
      { ...row('a-two', 2, 2), harness: 'Harness "A"', provider: 'Provider Two' },
      { ...row('b-one', 3, 3), harness: 'Harness B', provider: 'Provider\nOne' },
    ];
    const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-focused-joint-distribution-'));
    temporaryDirectories.add(revisionDirectory);
    const revision = 'revision-joint-distribution';
    const dbPath = await publishFixture(revisionDirectory, jointRows, support, revision);
    const database = openServedFixture(dbPath, revision);
    const request = {
      query: {
        filters: { fields: {}, harness: [], machine: [], query: '' },
        range: { from: null, to: null },
        revision,
      },
    };
    try {
      const sqliteResult = executeFocusedReportQuery(database, 'breakdown', request);
      const pureResult = projectFocusedBreakdown(jointRows, support, request);
      expect(sqliteResult).toEqual(pureResult);
      if (!('groups' in sqliteResult)) {
        throw new Error('The joint-distribution query must return Breakdown groups');
      }
      expect(
        sqliteResult.groups.harnessProviders.map(({ costSum, fresh, key, sessions }) => ({
          costSum,
          fresh,
          key,
          sessions,
        })),
      ).toEqual([
        {
          costSum: 3,
          fresh: 9,
          key: harnessProviderAnalyticsKey('Harness B', 'Provider\nOne'),
          sessions: 1,
        },
        {
          costSum: 2,
          fresh: 6,
          key: harnessProviderAnalyticsKey('Harness "A"', 'Provider Two'),
          sessions: 1,
        },
        {
          costSum: 1,
          fresh: 3,
          key: harnessProviderAnalyticsKey('Harness "A"', 'Provider\nOne'),
          sessions: 1,
        },
      ]);
    } finally {
      database.close();
    }
  });

  test('keeps partial API-value lower bounds dimension-invariant in SQLite timelines', async () => {
    const partialRow: SerializedRow = {
      ...row('partially-priced-models', 3, 2),
      costActual: null,
      costKnown: false,
      freshTokens: 2,
      model: 'gpt-5.4-high',
      modelSegments: [
        {
          costApprox: 2,
          costKnown: true,
          model: 'gpt-5.4-high',
          tokCr: 0,
          tokCw: 0,
          tokIn: 1,
          tokOut: 0,
        },
        {
          costApprox: 0,
          costKnown: false,
          model: 'gpt-5.4-fast',
          tokCr: 0,
          tokCw: 0,
          tokIn: 0,
          tokOut: 1,
        },
      ],
      models: ['gpt-5.4-high', 'gpt-5.4-fast'],
      tokCr: 0,
      tokCw: 0,
      tokIn: 1,
      tokOut: 1,
      tokenTotal: 2,
    };
    const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-focused-partial-model-'));
    temporaryDirectories.add(revisionDirectory);
    const database = openServedFixture(await publishFixture(revisionDirectory, [partialRow], support), 'revision-a');
    const modelRequest: FocusedOverviewRequest = {
      includeAdvanced: false,
      query: { ...overviewRequest.query, range: { from: null, to: null } },
      timeline: { dimension: 'model', granularity: 'day' },
    };
    const providerRequest: FocusedOverviewRequest = {
      ...modelRequest,
      timeline: { dimension: 'provider', granularity: 'day' },
    };
    try {
      const modelOverview = executeFocusedReportQuery(database, 'overview', modelRequest);
      const providerOverview = executeFocusedReportQuery(database, 'overview', providerRequest);
      const breakdownRequest = { query: modelRequest.query };
      const breakdown = executeFocusedReportQuery(database, 'breakdown', breakdownRequest);

      expect('view' in modelOverview ? modelOverview.view.executive : null).toEqual({
        harnesses: [
          {
            key: 'Codex',
            label: 'Codex',
            priceMeasurement: { knownCost: 2, state: 'partially measured', unpricedFreshTokens: 1 },
            processedTokens: 2,
            sessions: 1,
            total: 2,
          },
        ],
        models: [
          {
            key: 'gpt-5.4',
            label: 'gpt-5.4',
            priceMeasurement: { knownCost: 2, state: 'partially measured', unpricedFreshTokens: 1 },
            processedTokens: 2,
            sessions: 1,
            total: 2,
          },
        ],
      });
      expect(modelOverview).toEqual(projectFocusedOverview([partialRow], support, modelRequest));
      expect(providerOverview).toEqual(projectFocusedOverview([partialRow], support, providerRequest));
      expect(breakdown).toEqual(projectFocusedBreakdown([partialRow], support, breakdownRequest));
      expect('timeline' in modelOverview ? modelOverview.timeline?.grandTotal : null).toBe(2);
      expect('timeline' in providerOverview ? providerOverview.timeline?.grandTotal : null).toBe(2);
      expect('timeline' in modelOverview ? modelOverview.timeline?.priceMeasurement : null).toEqual({
        knownCost: 2,
        state: 'partially measured',
        unpricedFreshTokens: 1,
      });
      expect('groups' in breakdown ? breakdown.groups.models[0] : null).toMatchObject({
        costPerSession: null,
        costSum: 2,
        key: 'gpt-5.4',
        priced: 0,
        unpriced: 1,
        unpricedFreshTokens: 1,
      });
    } finally {
      database.close();
    }
  });

  test('orders equal model aggregates deterministically across pure and SQLite projections', async () => {
    const tieRows = [
      { ...row('z-row', 1, 1), model: 'z-model' },
      { ...row('a-row', 1, 1), model: 'a-model' },
      { ...row('accent-row', 1, 1), model: 'ä-model' },
    ];
    const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-focused-model-ties-'));
    temporaryDirectories.add(revisionDirectory);
    const database = openServedFixture(await publishFixture(revisionDirectory, tieRows, support), 'revision-a');
    const request: FocusedOverviewRequest = {
      includeAdvanced: false,
      query: { ...overviewRequest.query, range: { from: null, to: null } },
      timeline: { dimension: 'model', granularity: 'day' },
    };
    const breakdownRequest = { query: request.query };
    try {
      const overview = executeFocusedReportQuery(database, 'overview', request);
      const breakdown = executeFocusedReportQuery(database, 'breakdown', breakdownRequest);

      expect('view' in overview ? overview.view.executive.models.map(({ key }) => key) : []).toEqual([
        'a-model',
        'z-model',
        'ä-model',
      ]);
      expect(overview).toEqual(projectFocusedOverview(tieRows, support, request));
      expect(breakdown).toEqual(projectFocusedBreakdown(tieRows, support, breakdownRequest));
      expect('timeline' in overview ? overview.timeline?.series.map(({ key }) => key) : []).toEqual([
        'a-model',
        'z-model',
        'ä-model',
      ]);
      expect('groups' in breakdown ? breakdown.groups.models.map(({ key }) => key) : []).toEqual([
        'a-model',
        'z-model',
        'ä-model',
      ]);
    } finally {
      database.close();
    }
  });

  test('bounds SQLite executive groups and combines the complete harness remainder into Other', async () => {
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
    const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-focused-executive-bounds-'));
    temporaryDirectories.add(revisionDirectory);
    const database = openServedFixture(await publishFixture(revisionDirectory, fixtureRows, support), 'revision-a');
    const request: FocusedOverviewRequest = {
      includeAdvanced: false,
      query: { ...overviewRequest.query, range: { from: null, to: null } },
      timeline: { dimension: 'model', granularity: 'day' },
    };
    try {
      const overview = executeFocusedReportQuery(database, 'overview', request);
      if (!('view' in overview)) {
        throw new Error('The executive bounds fixture must return an Overview result');
      }

      expect(overview.view.executive.harnesses.slice(0, 4).map(({ key }) => key)).toEqual([
        'Harness 6',
        'Harness 5',
        'Harness 4',
        'Harness 3',
      ]);
      expect(overview.view.executive.harnesses[4]).toEqual({
        key: '___ai_usage_other__',
        label: 'Other',
        priceMeasurement: { knownCost: 3, state: 'partially measured', unpricedFreshTokens: 2 },
        processedTokens: 12,
        sessions: 2,
        total: 3,
      });
      expect(overview.view.executive.models.map(({ key }) => key)).toEqual([
        'model-6',
        'model-5',
        'model-4',
        'model-3',
        'model-2',
      ]);
      expect(overview.view.executive.models.some(({ label }) => label === 'Other')).toBe(false);
      expect(overview).toEqual(projectFocusedOverview(fixtureRows, support, request));
    } finally {
      database.close();
    }
  });

  test('returns mandatory empty SQLite executive groups when filters match no sessions', async () => {
    const { database } = await fixture();
    const request: FocusedOverviewRequest = {
      includeAdvanced: false,
      query: {
        ...overviewRequest.query,
        filters: { ...overviewRequest.query.filters, harness: ['Missing Harness'] },
        range: { from: null, to: null },
      },
      timeline: { dimension: 'model', granularity: 'day' },
    };
    try {
      const overview = executeFocusedReportQuery(database, 'overview', request);

      expect('view' in overview ? overview.view.executive : null).toEqual({ harnesses: [], models: [] });
      expect(overview).toEqual(projectFocusedOverview(rows, support, request));
    } finally {
      database.close();
    }
  });

  test('filters legacy multi-model sessions by observed models without inventing attribution', async () => {
    const legacyMultiModelRow: SerializedRow = {
      ...row('legacy-multi-model', 3, 6),
      model: 'gpt-5.4',
      models: ['gpt-5.4', 'claude-opus-4-6'],
    };
    const fixtureRows = [legacyMultiModelRow];
    const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-focused-observed-models-'));
    temporaryDirectories.add(revisionDirectory);
    const database = openServedFixture(
      await publishFixture(revisionDirectory, fixtureRows, support, 'revision-legacy-models'),
      'revision-legacy-models',
    );
    try {
      for (const model of ['gpt-5.4', 'claude-opus-4-6']) {
        const breakdownRequest = {
          query: {
            filters: { fields: { model }, harness: [], machine: [], query: '' },
            range: { from: null, to: null },
            revision: 'revision-legacy-models',
          },
        };
        const breakdown = executeFocusedReportQuery(database, 'breakdown', breakdownRequest);
        expect(breakdown).toEqual(projectFocusedBreakdown(fixtureRows, support, breakdownRequest));
        if (!('groups' in breakdown)) {
          throw new Error('The legacy multi-model query must return Breakdown groups');
        }
        expect(breakdown.groups.models.map(({ key, sessions }) => ({ key, sessions }))).toEqual([
          { key: '(multi-model, unsegmented)', sessions: 1 },
        ]);
      }
    } finally {
      database.close();
    }
  });

  test('reports exact support omissions while enforcing the frozen bootstrap byte budget', async () => {
    const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-focused-support-'));
    temporaryDirectories.add(revisionDirectory);
    const scopedRows = Array.from({ length: 205 }, (_, index) => {
      const base = row(`scope-${index}`, (index % 4) + 1, 1);
      return {
        ...base,
        harness: `Harness ${index}`,
        provider: `Provider ${index}`,
        source: {
          harnessKey: `harness-${index}`,
          machineId: `machine-${index}`,
          machineLabel: `Machine ${index}`,
          rootSourceSessionId: `scope-${index}`,
          sourceSessionId: `scope-${index}`,
        },
      };
    });
    const oversizedText = 'x'.repeat(8000);
    const oversizedSupport: FocusedReportSupport = {
      ...support,
      datasets: {
        providerStatus: {
          generatedAt: support.generatedAt,
          providers: Array.from({ length: 150 }, (_, index) => ({
            generatedAt: support.generatedAt,
            key: `provider-${index}`,
            label: `Provider ${index}`,
            source: 'manual' as const,
            state: 'ok' as const,
            warnings: [oversizedText],
            windows: [],
          })),
          schemaVersion: 1,
        },
      },
      filters: { ...support.filters, project: oversizedText },
      warnings: Array.from({ length: 150 }, (_, index) => ({ message: `${index}:${oversizedText}` })),
    };
    const database = openServedFixture(
      await publishFixture(revisionDirectory, scopedRows, oversizedSupport),
      'revision-a',
    );
    try {
      const trace: string[] = [];
      const result = executeFocusedReportQuery(database, 'support', { revision: 'revision-a' }, ({ sql }) =>
        trace.push(sql),
      );
      if (!('truncation' in result)) {
        throw new Error('The focused support query must return support truncation metadata');
      }
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(512 * 1024);
      expect(result.filterOptions.truncated).toBe(true);
      expect(result.truncation.filterProjectOmitted).toBe(1);
      expect(result.truncation.harnessOptionsOmitted).toBe(105);
      expect(result.truncation.machineOptionsOmitted).toBe(105);
      expect(result.truncation.providerRowsOmitted).toBe(105);
      expect(result.truncation.providerStatusesOmitted).toBeGreaterThan(0);
      expect(result.truncation.warningsOmitted).toBeGreaterThan(0);
      expect(trace.some((sql) => sql.includes('source_row_json'))).toBe(false);
      expect(trace.filter((sql) => sql.includes('row_json')).every((sql) => sql.includes('LIMIT 100'))).toBe(true);
    } finally {
      database.close();
    }
  });

  test('keeps 50,000-row date-filtered focused reads column-driven and inside frozen result budgets', async () => {
    const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-focused-maximum-'));
    temporaryDirectories.add(revisionDirectory);
    const maximumRows = Array.from({ length: 50_000 }, (_, index) => ({
      ...row(`audit-${REPORT_AUDIT_FIXTURE_SEED}-${index}`, (index % 4) + 1, (index % 1000) / 100),
      project: `project-${index}`,
      projectGroupId: `group:project-${index}`,
    }));
    const maximumSupport = {
      ...support,
      analytics: { ...support.analytics, sessionCount: maximumRows.length },
    };
    const database = openServedFixture(
      await publishFixture(revisionDirectory, maximumRows, maximumSupport, 'audit-revision'),
      'audit-revision',
    );
    try {
      const request: FocusedOverviewRequest = {
        includeAdvanced: false,
        query: {
          filters: { fields: {}, harness: [], machine: [], query: '' },
          range: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-04T23:59:59.999Z' },
          revision: 'audit-revision',
        },
        timeline: { dimension: 'harness', granularity: 'day' },
      };
      const overviewTrace: string[] = [];
      const overview = executeFocusedReportQuery(database, 'overview', request, ({ sql }) => overviewTrace.push(sql));
      expect(overviewTrace.some((sql) => sql.includes('source_row_json'))).toBe(false);
      expect(overviewTrace.some((sql) => sql.includes('LIMIT 50001'))).toBe(false);
      expect(Buffer.byteLength(JSON.stringify(overview))).toBeLessThanOrEqual(MAX_OVERVIEW_REFRESH_BYTES);
      if (!('summary' in overview)) {
        throw new Error('The maximum focused query fixture must return an Overview result');
      }
      expect(overview.summary.sessionCount).toBe(maximumRows.length);
      expect(overview.view.executive.harnesses.length).toBeLessThanOrEqual(5);
      expect(overview.view.executive.models.length).toBeLessThanOrEqual(5);

      const breakdownTrace: string[] = [];
      const breakdown = executeFocusedReportQuery(database, 'breakdown', { query: request.query }, ({ sql }) =>
        breakdownTrace.push(sql),
      );
      expect(breakdownTrace.some((sql) => sql.includes('source_row_json') || sql.includes('row_json'))).toBe(false);
      expect(Buffer.byteLength(JSON.stringify(breakdown))).toBeLessThanOrEqual(MAX_BREAKDOWN_REFRESH_BYTES);
      if (!('groups' in breakdown)) {
        throw new Error('The maximum focused query fixture must return a Breakdown result');
      }
      expect(breakdown.groups.projects).toHaveLength(maximumRows.length);
    } finally {
      database.close();
    }
  }, 180_000);

  test('runs through the revision-keyed durable query and strict result parser', async () => {
    const { database } = await fixture();
    const result = executeFocusedReportQuery(database, 'overview', overviewRequest);
    database.close();

    expect(parseFocusedReportQueryResult('overview', result, overviewRequest)).toEqual(
      projectFocusedOverview(rows, support, overviewRequest),
    );
  });
});
