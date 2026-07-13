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
  projectFocusedHtmlPayload,
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

const runnerPath = path.join(import.meta.dir, 'focused-report-query-runner.ts');
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
  freshTokens: day * 10,
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

const rows = [row('one', 1, 1), row('two', 2, 2), row('three', 3, 3), row('four', 4, 4)];
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

  test('serves pruned bootstrap support and complete HTML exports', async () => {
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

      expect(executeFocusedReportQuery(database, 'html-payload', revisionRequest)).toEqual(
        projectFocusedHtmlPayload(rows, support, revisionRequest),
      );
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
