import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import {
  enrichSessionPresentationRow,
  type SessionQueryRequest,
  sessionCampaignIdentityForRow,
  sessionRowIdentity,
} from '@ai-usage/report-core/session-query';
import type { ServedRevisionQueryTrace } from '@ai-usage/usage-store/reader';
import { importLocalRows, publishServedReportRevision } from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import {
  queryServedRevisionData,
  type ServedRevisionQueryError,
  type ServedRevisionQueryKind,
} from './served-revision-query';

const temporaryRoots: string[] = [];
const SERVED_TABLE_SCAN_PATTERN = /^SCAN served_/u;
const USED_INDEX_PATTERN = /USING (?:COVERING )?INDEX ([^ ]+)/u;
const WITH_RECURSIVE_PATTERN = /WITH RECURSIVE\b/u;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const row = (
  marker: string,
  sourceSessionId: string,
  day: number,
  campaign?: { parent?: string; root: string },
): SerializedRow => ({
  activeDate: `2026-07-0${day}T10:00:00.000Z`,
  calls: day,
  costActual: day / 2,
  costApprox: day,
  costKnown: true,
  costQuota: 0,
  date: `2026-07-0${day}T09:00:00.000Z`,
  durationMs: day * 60_000,
  endDate: `2026-07-0${day}T10:00:00.000Z`,
  freshTokens: day * 3,
  harness: 'Codex',
  lineDelta: day,
  linesAdded: day,
  linesDeleted: 0,
  model: 'gpt-5.4',
  name: `${marker}-${sourceSessionId}`,
  project: 'ai-usage',
  provider: 'Codex API',
  sessionLabel: `${marker}-${sourceSessionId}`,
  source: {
    harnessKey: 'codex',
    machineId: 'machine-a',
    machineLabel: 'Machine A',
    ...(campaign?.parent === undefined ? {} : { parentSourceSessionId: campaign.parent }),
    rootSourceSessionId: campaign?.root ?? sourceSessionId,
    sourceSessionId,
  },
  subagent: campaign?.parent !== undefined,
  tokCr: day,
  tokCw: day,
  tokIn: day,
  tokOut: day,
  tokenTotal: day * 4,
  tools: day,
  turns: day,
});

const rows = (marker: string): readonly SerializedRow[] => [
  row(marker, 'campaign-root', 1, { root: 'campaign-root' }),
  row(marker, 'campaign-child', 2, { parent: 'campaign-root', root: 'campaign-root' }),
  row(marker, 'standalone', 3),
  row(marker, 'extra', 4),
];

const support = (rowCount: number): FocusedReportSupport => ({
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
    sessionCount: rowCount,
    tools: 0,
    totalCost: 0,
    turns: 0,
    unpricedCount: 0,
  },
  filters: { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
  generatedAt: '2026-07-29T12:00:00.000Z',
  omittedRows: 0,
});

const sessionRequest = (revision: string, overrides: Partial<SessionQueryRequest> = {}): SessionQueryRequest => ({
  cursor: null,
  filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
  pageSize: 10,
  range: { from: null, to: null },
  revision,
  sort: [{ desc: true, id: 'date' }],
  ...overrides,
});

const publish = async (dbPath: string, revision: string, revisionRows: readonly SerializedRow[], now: number) => {
  const reportSupport = support(revisionRows.length);
  const sourceAuthorities = revisionRows.map(() => 'local-observed' as const);
  await Effect.runPromise(
    publishServedReportRevision({
      assemble: () => ({
        configFingerprint: 'c'.repeat(64),
        generatedAt: reportSupport.generatedAt,
        rows: revisionRows,
        sourceAuthorities,
        support: reportSupport,
      }),
      dbPath,
      now,
      revision,
      ttlMs: 100_000,
    }),
  );
};

const fixture = async (): Promise<{ dbPath: string; revisionARows: readonly SerializedRow[] }> => {
  const root = await mkdtemp(path.join(tmpdir(), 'report-data-served-revision-'));
  temporaryRoots.push(root);
  const dbPath = path.join(root, 'usage-store.sqlite');
  await Effect.runPromise(importLocalRows({ dbPath, machine: { id: 'machine-a', label: 'Machine A' }, rows: [] }));
  const revisionARows = rows('A');
  await publish(dbPath, 'revision-a', revisionARows, 1000);
  await publish(dbPath, 'revision-b', rows('B'), 2000);
  return { dbPath, revisionARows };
};

const query = async (
  dbPath: string,
  kind: ServedRevisionQueryKind,
  revision: string,
  request: unknown,
  trace?: (query: ServedRevisionQueryTrace) => void,
) =>
  await Effect.runPromise(
    queryServedRevisionData({
      dbPath,
      kind,
      now: 3000,
      request,
      revision,
      ...(trace === undefined ? {} : { trace }),
    }),
  );

const sqliteBindings = (values: readonly unknown[]): Array<bigint | boolean | null | number | string> =>
  values.map((value) => {
    if (
      value === null ||
      typeof value === 'bigint' ||
      typeof value === 'boolean' ||
      typeof value === 'number' ||
      typeof value === 'string'
    ) {
      return value;
    }
    throw new Error('Query-plan trace contained a non-SQLite scalar binding');
  });

describe('durable served revision query dispatcher', () => {
  test('executes all seven query kinds without cross-revision fallthrough', async () => {
    const { dbPath, revisionARows } = await fixture();
    const baseRequest = sessionRequest('revision-a');
    const rootRow = revisionARows[0];
    if (!rootRow) {
      throw new Error('Expected a root fixture row');
    }
    const campaignKey = sessionCampaignIdentityForRow(enrichSessionPresentationRow(rootRow)).campaignKey;
    const rowId = sessionRowIdentity(rootRow);
    const requests: ReadonlyArray<{ kind: ServedRevisionQueryKind; request: unknown }> = [
      { kind: 'sessions', request: baseRequest },
      {
        kind: 'sessions',
        request: {
          ...baseRequest,
          filters: { ...baseRequest.filters, fields: { model: 'gpt-5.4' } },
        },
      },
      { kind: 'campaign-children', request: { campaignKey, query: baseRequest } },
      { kind: 'neighbors', request: { query: baseRequest, rowId } },
      { kind: 'session-detail-anchor', request: { revision: 'revision-a', rowId } },
      {
        kind: 'overview',
        request: {
          includeAdvanced: true,
          query: { filters: baseRequest.filters, range: baseRequest.range, revision: 'revision-a' },
          timeline: { dimension: 'model', granularity: 'day' },
        },
      },
      {
        kind: 'breakdown',
        request: { query: { filters: baseRequest.filters, range: baseRequest.range, revision: 'revision-a' } },
      },
      { kind: 'support', request: { revision: 'revision-a' } },
    ];

    for (const request of requests) {
      const result = await query(dbPath, request.kind, 'revision-a', request.request);
      expect(JSON.stringify(result)).not.toContain('B-');
      expect(result.revision).toBe('revision-a');
    }
    const revisionB = await query(dbPath, 'sessions', 'revision-b', sessionRequest('revision-b'));
    expect(JSON.stringify(revisionB)).toContain('B-');
    expect(JSON.stringify(revisionB)).not.toContain('A-');
  });

  test('scopes every SQL statement and rejects mismatched revisions and cursors before reading', async () => {
    const { dbPath } = await fixture();
    const trace: Array<{ params: readonly unknown[]; sql: string }> = [];
    const first = await Effect.runPromise(
      queryServedRevisionData({
        dbPath,
        kind: 'sessions',
        now: 3000,
        request: sessionRequest('revision-a', { pageSize: 1 }),
        revision: 'revision-a',
        trace: (entry) => trace.push(entry),
      }),
    );
    if (!('nextCursor' in first) || first.nextCursor === null) {
      throw new Error('Expected a revision-scoped page cursor');
    }
    expect(trace.length).toBeGreaterThan(0);
    for (const statement of trace) {
      expect(statement.sql).toContain('served_report_rows WHERE revision = ?');
      expect(statement.sql).toContain('served_session_model_segments WHERE revision = ?');
      expect(statement.sql).toContain('served_session_model_filter_keys WHERE revision = ?');
      expect(statement.sql).toContain('WHERE revisions.revision = ?');
      expect(statement.params.slice(0, 4)).toEqual(['revision-a', 'revision-a', 'revision-a', 'revision-a']);
    }

    const mismatchedRevision = await Effect.runPromise(
      Effect.either(
        queryServedRevisionData({
          dbPath,
          kind: 'sessions',
          request: sessionRequest('revision-a'),
          revision: 'revision-b',
        }),
      ),
    );
    expect(mismatchedRevision._tag).toBe('Left');
    expect((mismatchedRevision as { left: ServedRevisionQueryError }).left.reason).toBe('revision-mismatch');

    const mismatchedCursor = await Effect.runPromise(
      Effect.either(
        queryServedRevisionData({
          dbPath,
          kind: 'sessions',
          request: sessionRequest('revision-b', { cursor: first.nextCursor, pageSize: 1 }),
          revision: 'revision-b',
        }),
      ),
    );
    expect(mismatchedCursor._tag).toBe('Left');
    expect((mismatchedCursor as { left: ServedRevisionQueryError }).left.reason).toBe('invalid-request');
  });

  test('executes the fixed recursive campaign-cost sorts inside the closed catalog', async () => {
    const { dbPath } = await fixture();
    const recursiveSortFields = ['actual', 'cost', 'quota'] as const;

    for (const sortField of recursiveSortFields) {
      const trace: ServedRevisionQueryTrace[] = [];
      const result = await query(
        dbPath,
        'sessions',
        'revision-a',
        sessionRequest('revision-a', { sort: [{ desc: true, id: sortField }] }),
        (entry) => trace.push(entry),
      );

      expect(result.revision).toBe('revision-a');
      expect(trace.some(({ sql }) => WITH_RECURSIVE_PATTERN.test(sql))).toBe(true);
    }
  });

  test('publishes and queries a bounded projection with at least 5,000 sessions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'report-data-served-scale-'));
    temporaryRoots.push(root);
    const dbPath = path.join(root, 'usage-store.sqlite');
    await Effect.runPromise(importLocalRows({ dbPath, machine: { id: 'machine-a', label: 'Machine A' }, rows: [] }));
    const scaleRows = Array.from({ length: 5000 }, (_, index) =>
      row('S', `scale-${String(index).padStart(4, '0')}`, (index % 9) + 1),
    );
    await publish(dbPath, 'revision-scale', scaleRows, 1000);

    const sessions = await query(
      dbPath,
      'sessions',
      'revision-scale',
      sessionRequest('revision-scale', { pageSize: 50 }),
    );
    const overview = await query(dbPath, 'overview', 'revision-scale', {
      includeAdvanced: false,
      query: {
        filters: { fields: {}, harness: [], machine: [], query: '' },
        range: { from: null, to: null },
        revision: 'revision-scale',
      },
      timeline: { dimension: 'model', granularity: 'day' },
    });

    expect(sessions).toMatchObject({ itemCount: 5000, revision: 'revision-scale', sessionCount: 5000 });
    expect('items' in sessions ? sessions.items : []).toHaveLength(50);
    expect(overview.revision).toBe('revision-scale');
    expect(Buffer.byteLength(JSON.stringify(sessions))).toBeLessThan(8 * 1024 * 1024);
  }, 30_000);

  test('uses revision-keyed plans for every current query kind', async () => {
    const { dbPath, revisionARows } = await fixture();
    const baseRequest = sessionRequest('revision-a');
    const rootRow = revisionARows[0];
    if (!rootRow) {
      throw new Error('Expected a root fixture row');
    }
    const campaignKey = sessionCampaignIdentityForRow(enrichSessionPresentationRow(rootRow)).campaignKey;
    const rowId = sessionRowIdentity(rootRow);
    const requests: ReadonlyArray<{ kind: ServedRevisionQueryKind; request: unknown }> = [
      { kind: 'sessions', request: baseRequest },
      { kind: 'campaign-children', request: { campaignKey, query: baseRequest } },
      { kind: 'neighbors', request: { query: baseRequest, rowId } },
      { kind: 'session-detail-anchor', request: { revision: 'revision-a', rowId } },
      {
        kind: 'overview',
        request: {
          includeAdvanced: true,
          query: { filters: baseRequest.filters, range: baseRequest.range, revision: 'revision-a' },
          timeline: { dimension: 'model', granularity: 'day' },
        },
      },
      {
        kind: 'breakdown',
        request: { query: { filters: baseRequest.filters, range: baseRequest.range, revision: 'revision-a' } },
      },
      { kind: 'support', request: { revision: 'revision-a' } },
    ];
    const traces: ServedRevisionQueryTrace[] = [];
    for (const request of requests) {
      await query(dbPath, request.kind, 'revision-a', request.request, (entry) => traces.push(entry));
    }

    const database = new Database(dbPath, { create: false, readonly: true });
    const usedIndexes = new Set<string>();
    try {
      for (const entry of traces) {
        const plan = database.query(`EXPLAIN QUERY PLAN ${entry.sql}`).all(...sqliteBindings(entry.params)) as Array<{
          detail?: unknown;
        }>;
        const details = plan.flatMap(({ detail }) => (typeof detail === 'string' ? [detail] : []));
        expect(details.filter((detail) => SERVED_TABLE_SCAN_PATTERN.test(detail))).toEqual([]);
        for (const detail of details) {
          const index = USED_INDEX_PATTERN.exec(detail)?.[1];
          if (index?.startsWith('idx_served_')) {
            usedIndexes.add(index);
          }
        }
      }
    } finally {
      database.close(true);
    }
    expect(traces.length).toBeGreaterThan(7);
    expect([...usedIndexes].sort()).toEqual([
      'idx_served_report_rows_active_time',
      'idx_served_report_rows_campaign',
      'idx_served_report_rows_facets',
      'idx_served_report_rows_provider_scope',
      'idx_served_session_model_segments_model',
    ]);
  });
});
