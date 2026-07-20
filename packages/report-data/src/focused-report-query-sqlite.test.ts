import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import { executeFocusedReportQuery } from './focused-report-query-sqlite';
import { materializeSessionQueryDatabase, SESSION_QUERY_DATABASE_NAME } from './session-query-materialization';
import { assertSessionQueryDatabase } from './session-query-sqlite';

const runnerPath = path.join(import.meta.dir, 'revision-query-runner.ts');
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
  project: 'ai-usage',
  provider: day % 2 ? 'Codex API' : 'Anthropic',
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

const rows = [row('one', 1, 1), { ...row('two', 2, 2), costKnown: false }, row('three', 3, 3), row('four', 4, 4)];
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

const fixture = async (): Promise<{ database: Database; revisionDirectory: string }> => {
  const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-focused-query-'));
  temporaryDirectories.add(revisionDirectory);
  await chmod(revisionDirectory, 0o700);
  await materializeSessionQueryDatabase(revisionDirectory, rows, support);
  const database = new Database(path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME), { readonly: true });
  assertSessionQueryDatabase(database);
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
      expect(overview.view.topSessions.find(({ kind }) => kind === 'campaign')).toMatchObject({
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
      expect(basicOverview).toEqual(projectFocusedOverview(rows, support, basicOverviewRequest));
      expect(basicOverviewTrace.some((sql) => sql.includes('source_row_json'))).toBe(false);
      expect(basicOverviewTrace.some((sql) => UNBOUNDED_PRESENTATION_SCAN_PATTERN.test(sql))).toBe(false);
      expect(basicOverviewTrace.every((sql) => !sql.includes('SELECT * FROM session_rows'))).toBe(true);
      if (!('view' in basicOverview)) {
        throw new Error('The focused Overview query must return an Overview result');
      }
      expect(basicOverview.view.advancedSummary).toBeNull();
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

  test('serves pruned bootstrap support with bounded metadata', async () => {
    const { database } = await fixture();
    try {
      const revisionRequest = { revision: 'revision-a' };
      const supportResult = executeFocusedReportQuery(database, 'support', revisionRequest);
      expect(supportResult).toEqual(
        projectFocusedSupport(
          support,
          { harness: ['Claude Code', 'Codex'], machine: ['Machine A'], truncated: false },
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
    await chmod(revisionDirectory, 0o700);
    const undatedRows = rows.map((sourceRow) => ({ ...sourceRow, activeDate: null, date: null }));
    await materializeSessionQueryDatabase(revisionDirectory, undatedRows, support);
    const database = new Database(path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME), { readonly: true });
    assertSessionQueryDatabase(database);
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
    await chmod(revisionDirectory, 0o700);
    await materializeSessionQueryDatabase(revisionDirectory, fixtureRows, support);
    const database = new Database(path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME), { readonly: true });
    assertSessionQueryDatabase(database);
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
      expect(overview).toEqual(projectFocusedOverview(fixtureRows, support, request));
      if (!('timeline' in overview) || overview.timeline === null) {
        throw new Error('The segmented focused query must return an Overview timeline');
      }
      expect(overview.summary.sessionCount).toBe(1);
      expect(overview.timeline.series).toEqual([
        { key: 'claude-opus-4-6', label: 'claude-opus-4-6', sessions: 0, total: 4 },
        { key: 'gpt-5.4', label: 'gpt-5.4', sessions: 1, total: 2 },
      ]);
      expect(overview.timeline.grandSessions).toBe(1);
      expect(overview.timeline.buckets[0]?.sessions).toBe(1);

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
    await chmod(revisionDirectory, 0o700);
    await materializeSessionQueryDatabase(revisionDirectory, [partialRow], support);
    const database = new Database(path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME), { readonly: true });
    assertSessionQueryDatabase(database);
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

      expect(modelOverview).toEqual(projectFocusedOverview([partialRow], support, modelRequest));
      expect(providerOverview).toEqual(projectFocusedOverview([partialRow], support, providerRequest));
      expect(breakdown).toEqual(projectFocusedBreakdown([partialRow], support, breakdownRequest));
      expect('timeline' in modelOverview ? modelOverview.timeline?.grandTotal : null).toBe(0);
      expect('timeline' in providerOverview ? providerOverview.timeline?.grandTotal : null).toBe(0);
      expect('groups' in breakdown ? breakdown.groups.models[0] : null).toMatchObject({
        costPerSession: null,
        costSum: 2,
        key: 'gpt-5.4',
        priced: 0,
        unpriced: 1,
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
    await chmod(revisionDirectory, 0o700);
    await materializeSessionQueryDatabase(revisionDirectory, tieRows, support);
    const database = new Database(path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME), { readonly: true });
    assertSessionQueryDatabase(database);
    const request: FocusedOverviewRequest = {
      includeAdvanced: false,
      query: { ...overviewRequest.query, range: { from: null, to: null } },
      timeline: { dimension: 'model', granularity: 'day' },
    };
    const breakdownRequest = { query: request.query };
    try {
      const overview = executeFocusedReportQuery(database, 'overview', request);
      const breakdown = executeFocusedReportQuery(database, 'breakdown', breakdownRequest);

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

  test('filters legacy multi-model sessions by observed models without inventing attribution', async () => {
    const legacyMultiModelRow: SerializedRow = {
      ...row('legacy-multi-model', 3, 6),
      model: 'gpt-5.4',
      models: ['gpt-5.4', 'claude-opus-4-6'],
    };
    const fixtureRows = [legacyMultiModelRow];
    const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-focused-observed-models-'));
    temporaryDirectories.add(revisionDirectory);
    await chmod(revisionDirectory, 0o700);
    await materializeSessionQueryDatabase(revisionDirectory, fixtureRows, support);
    const database = new Database(path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME), { readonly: true });
    assertSessionQueryDatabase(database);
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
    await chmod(revisionDirectory, 0o700);
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
    await materializeSessionQueryDatabase(revisionDirectory, scopedRows, oversizedSupport);
    const database = new Database(path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME), { readonly: true });
    assertSessionQueryDatabase(database);
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

  test('keeps 50,000-row focused reads column-driven and inside frozen result budgets', async () => {
    const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-focused-maximum-'));
    temporaryDirectories.add(revisionDirectory);
    await chmod(revisionDirectory, 0o700);
    const maximumRows = Array.from({ length: 50_000 }, (_, index) => ({
      ...row(`audit-${REPORT_AUDIT_FIXTURE_SEED}-${index}`, (index % 4) + 1, (index % 1000) / 100),
      project: `project-${index}`,
    }));
    const maximumSupport = {
      ...support,
      analytics: { ...support.analytics, sessionCount: maximumRows.length },
    };
    await materializeSessionQueryDatabase(revisionDirectory, maximumRows, maximumSupport);
    const database = new Database(path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME), { readonly: true });
    assertSessionQueryDatabase(database);
    try {
      const request: FocusedOverviewRequest = {
        includeAdvanced: false,
        query: {
          filters: { fields: {}, harness: [], machine: [], query: '' },
          range: { from: null, to: null },
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
  }, 30_000);

  test('runs through the immutable artifact protocol and strict result parser', async () => {
    const { database, revisionDirectory } = await fixture();
    database.close();
    const outputDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-focused-result-'));
    temporaryDirectories.add(outputDirectory);
    await chmod(outputDirectory, 0o700);
    const outputPath = path.join(outputDirectory, 'result.json');
    const output = await open(outputPath, 'wx', 0o600);
    await output.close();
    const child = Bun.spawn(
      ['bun', runnerPath, revisionDirectory, 'overview', JSON.stringify(overviewRequest), outputPath],
      { env: { ...process.env, TZ: 'UTC' }, stderr: 'pipe', stdout: 'pipe' },
    );
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    const result: unknown = JSON.parse(await readFile(outputPath, 'utf8'));

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toBe('');
    expect(parseFocusedReportQueryResult('overview', result, overviewRequest)).toEqual(
      projectFocusedOverview(rows, support, overviewRequest),
    );
  });
});
