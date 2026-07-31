import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import {
  type SessionDetailSourceAuthority,
  sessionDetailRequestFingerprint,
} from '@ai-usage/report-core/session-detail';
import {
  compareSessionIdentityValues,
  enrichSessionPresentationRow,
  projectSessionCampaignChildren,
  projectSessionNeighbors,
  projectSessionPage,
  type SessionQueryRequest,
  sessionCampaignIdentityForRow,
  sessionRowIdentity,
  sessionSortFields,
  sessionTextSortFields,
} from '@ai-usage/report-core/session-query';
import { Effect } from 'effect';
import { queryServedRevisionData } from './reader';
import { createServedRevisionQueryDatabase } from './served-revision';
import {
  assertSessionQueryDatabase,
  executeMaterializedSessionQuery,
  type SessionQuerySqliteDatabase,
  type SessionQuerySqliteTrace,
} from './session-query-sqlite';
import { publishServedReportRevision, updateUsageMachineLabel } from './writer';

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { force: true, recursive: true })));
  temporaryDirectories.clear();
});

const row = (
  sourceSessionId: string,
  tokenUnit: number,
  campaign?: { parent?: string; root: string },
): SerializedRow => {
  const partial = sourceSessionId === 'campaign-child-b';
  const subagent = campaign?.parent !== undefined;
  return {
    activeDate: '2026-07-01T10:01:00.000Z',
    calls: tokenUnit,
    costActual: tokenUnit / 100,
    costApprox: tokenUnit / 10,
    costKnown: sourceSessionId !== 'unknown-cost',
    costQuota: tokenUnit / 100,
    date: '2026-07-01T10:00:00.000Z',
    durationMs: tokenUnit * 1000,
    endDate: '2026-07-01T10:01:00.000Z',
    freshTokens: tokenUnit * 3,
    harness: sourceSessionId === 'standalone-a' ? 'Claude Code' : 'Codex',
    lineDelta: tokenUnit + 2,
    linesAdded: tokenUnit + 1,
    linesDeleted: 1,
    model: sourceSessionId === 'standalone-a' ? 'claude-opus-4-6' : 'gpt-5.4',
    name: sourceSessionId,
    partial,
    project: sourceSessionId === 'standalone-b' ? 'side-project' : 'ai-usage',
    provider: sourceSessionId === 'standalone-a' ? 'Anthropic' : 'Codex API',
    rtkCommandCount: tokenUnit,
    rtkInputTokens: tokenUnit * 2,
    rtkOutputTokens: tokenUnit,
    rtkSavedTokens: tokenUnit,
    sessionLabel: `${sourceSessionId}${partial ? ' ~' : ''}${subagent ? ' ↳' : ''}`,
    source: {
      harnessKey: 'codex',
      machineId: 'machine-a',
      machineLabel: 'Machine A',
      ...(campaign?.parent === undefined ? {} : { parentSourceSessionId: campaign.parent }),
      rootSourceSessionId: campaign?.root ?? sourceSessionId,
      sourceSessionId,
    },
    subagent,
    tokCr: tokenUnit,
    tokCw: tokenUnit,
    tokIn: tokenUnit,
    tokOut: tokenUnit,
    tokenTotal: tokenUnit * 4,
    tools: tokenUnit,
    turns: tokenUnit,
  };
};

const textRow = (value: string, index: number): SerializedRow => {
  const fixture = row(`text-${index}`, 10);
  if (!fixture.source) {
    throw new Error('Text sort fixture requires source identity');
  }
  return {
    ...fixture,
    harness: value,
    model: value,
    name: value,
    project: value,
    provider: value,
    sessionLabel: value,
    source: { ...fixture.source, machineLabel: value },
  };
};

const campaignCostRow = (
  sourceSessionId: string,
  costApprox: number,
  campaign: { parent?: string; root: string },
  costKnown = true,
): SerializedRow => ({
  ...row(sourceSessionId, 1, campaign),
  costActual: costApprox,
  costApprox,
  costKnown,
  costQuota: costApprox,
});

const rows: SerializedRow[] = [
  row('standalone-a', 5),
  row('campaign-root', 10, { root: 'campaign-root' }),
  row('campaign-child-a', 30, { parent: 'campaign-root', root: 'campaign-root' }),
  row('campaign-child-b', 20, { parent: 'campaign-root', root: 'campaign-root' }),
  row('standalone-b', 40),
  row('unknown-cost', 15),
];

const queryRequest = (overrides: Partial<SessionQueryRequest> = {}): SessionQueryRequest => ({
  cursor: null,
  filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
  pageSize: 2,
  range: { from: null, to: null },
  revision: 'revision-a',
  sort: [{ desc: true, id: 'total' }],
  ...overrides,
});

const support = (sessionCount: number): FocusedReportSupport => ({
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
    sessionCount,
    tools: 0,
    totalCost: 0,
    turns: 0,
    unpricedCount: 0,
  },
  filters: { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
  generatedAt: '2026-07-13T00:00:00.000Z',
  omittedRows: 0,
});

type TestQueryDatabase = SessionQuerySqliteDatabase & { readonly close: () => void };

const openServedDatabase = (dbPath: string, revision: string): TestQueryDatabase => {
  const rawDatabase = new Database(dbPath, { readonly: true, strict: true });
  const scopedDatabase = createServedRevisionQueryDatabase(rawDatabase, revision) as SessionQuerySqliteDatabase;
  const database = { close: () => rawDatabase.close(), query: (sql: string) => scopedDatabase.query(sql) };
  assertSessionQueryDatabase(database);
  return database;
};

const openRowsDatabase = async (
  fixtureRows: SerializedRow[],
  sourceAuthorities: SessionDetailSourceAuthority[] = fixtureRows.map(() => 'local-observed'),
  revision = 'revision-a',
): Promise<{ database: TestQueryDatabase; dbPath: string }> => {
  const storeDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-session-query-'));
  temporaryDirectories.add(storeDirectory);
  const dbPath = path.join(storeDirectory, 'usage.sqlite');
  await Effect.runPromise(
    updateUsageMachineLabel({
      dbPath,
      machine: { id: 'machine-a', label: 'Machine A' },
      updatedAt: new Date('2026-07-13T00:00:00.000Z'),
    }),
  );
  await Effect.runPromise(
    publishServedReportRevision({
      assemble: () => ({
        configFingerprint: 'c'.repeat(64),
        generatedAt: '2026-07-13T00:00:00.000Z',
        projectAliases: [],
        projectGroupConfigs: [],
        rows: fixtureRows,
        sourceAuthorities,
        support: support(fixtureRows.length),
      }),
      dbPath,
      now: 1000,
      revision,
      ttlMs: 300_000,
    }),
  );
  return { database: openServedDatabase(dbPath, revision), dbPath };
};

const openFixtureDatabase = async (): Promise<{ database: TestQueryDatabase; dbPath: string }> =>
  openRowsDatabase(rows);

describe('durable session query SQLite projections', () => {
  test('rejects duplicate report row identities during publication', async () => {
    const duplicate = row('duplicate-source', 10);

    await expect(openRowsDatabase([duplicate, { ...duplicate }])).rejects.toThrow();
  });

  test('resolves exact session detail anchors and preserves nullable provenance', async () => {
    const anchorVcs = {
      branches: [
        {
          firstObservedAt: '2026-07-01T10:00:00.000Z',
          lastObservedAt: '2026-07-01T10:01:00.000Z',
          name: 'main',
          provenance: 'harness-recorded' as const,
          webUrl: 'https://github.com/fixture/project/tree/main',
        },
      ],
      headCommit: null,
      partial: false,
      pullRequests: [],
      repository: {
        host: 'github.com',
        ownerPath: 'fixture/project',
        provenance: 'harness-recorded' as const,
        webUrl: 'https://github.com/fixture/project',
      },
    };
    const baseAnchorFixture = row('anchor-session', 10);
    if (!baseAnchorFixture.source) {
      throw new Error('Anchor fixture requires source provenance');
    }
    const anchorFixture = {
      ...baseAnchorFixture,
      activeDate: '2026-07-01T10:01:00.000Z',
      freshTokens: 30,
      lineDelta: 12,
      source: { ...baseAnchorFixture.source, vcs: anchorVcs },
      tokenTotal: 40,
    };
    const { source: _source, ...rowWithoutProvenance } = row('without-provenance', 7);
    const provenanceFreeRow: SerializedRow = {
      ...rowWithoutProvenance,
      activeDate: '2026-07-01T10:01:00.000Z',
      freshTokens: 21,
      lineDelta: 9,
      tokenTotal: 28,
    };
    const anchorRows = [...rows, anchorFixture, provenanceFreeRow];
    const { database } = await openRowsDatabase(anchorRows);
    try {
      const foundRequest = { revision: 'revision-a', rowId: sessionRowIdentity(anchorFixture) };
      expect(executeMaterializedSessionQuery(database, 'session-detail-anchor', foundRequest)).toEqual({
        anchor: {
          harnessKey: 'codex',
          machineId: 'machine-a',
          projection: {
            calls: 10,
            durationMs: 10_000,
            modelSegments: [
              {
                model: 'gpt-5.4',
                tokens: { cacheRead: 10, cacheWrite: 10, input: 10, output: 10, total: 40 },
              },
            ],
            partial: false,
            tokens: { cacheRead: 10, cacheWrite: 10, input: 10, output: 10, total: 40 },
            tools: 10,
            turns: 10,
          },
          sourceAuthority: 'local-observed',
          sourceSessionId: 'anchor-session',
          vcs: anchorVcs,
        },
        requestFingerprint: sessionDetailRequestFingerprint(foundRequest),
        revision: 'revision-a',
      });
      const missingRequest = { revision: 'revision-a', rowId: 'missing-row' };
      expect(executeMaterializedSessionQuery(database, 'session-detail-anchor', missingRequest)).toEqual({
        anchor: null,
        requestFingerprint: sessionDetailRequestFingerprint(missingRequest),
        revision: 'revision-a',
      });

      const noSourceRowId = sessionRowIdentity(provenanceFreeRow);
      expect(
        executeMaterializedSessionQuery(database, 'session-detail-anchor', {
          revision: 'revision-a',
          rowId: noSourceRowId,
        }),
      ).toMatchObject({
        anchor: {
          harnessKey: null,
          machineId: null,
          sourceAuthority: 'local-observed',
          sourceSessionId: null,
        },
      });

      const portable = await openRowsDatabase([anchorFixture], ['portable-opaque']);
      try {
        const portableRowId = sessionRowIdentity(anchorFixture);
        expect(
          executeMaterializedSessionQuery(portable.database, 'session-detail-anchor', {
            revision: 'revision-a',
            rowId: portableRowId,
          }),
        ).toMatchObject({ anchor: { sourceAuthority: 'portable-opaque' } });
      } finally {
        portable.database.close();
      }
    } finally {
      database.close();
    }
  });

  test('rejects invalid source JSON in a detail anchor', async () => {
    const published = await openFixtureDatabase();
    published.database.close();
    const writerDatabase = new Database(published.dbPath);
    try {
      const target = rows.find((candidate) => candidate.source?.sourceSessionId === 'standalone-a');
      if (!target) {
        throw new Error('Missing invalid JSON target row');
      }
      const targetRowId = sessionRowIdentity(target);
      writerDatabase
        .query('UPDATE served_report_rows SET source_row_json = ? WHERE revision = ? AND row_id = ?')
        .run('{invalid', 'revision-a', targetRowId);
    } finally {
      writerDatabase.close();
    }
    const database = openServedDatabase(published.dbPath, 'revision-a');
    try {
      const target = rows.find((candidate) => candidate.source?.sourceSessionId === 'standalone-a');
      if (!target) {
        throw new Error('Missing invalid JSON target row');
      }
      const targetRowId = sessionRowIdentity(target);
      expect(() =>
        executeMaterializedSessionQuery(database, 'session-detail-anchor', {
          revision: 'revision-a',
          rowId: targetRowId,
        }),
      ).toThrow('invalid JSON');
    } finally {
      database.close();
    }
  });

  test('projects every derived sort field with pure projection parity', async () => {
    const { database: initialDatabase, dbPath } = await openFixtureDatabase();
    initialDatabase.close();
    for (const field of sessionSortFields) {
      for (const desc of [false, true]) {
        const request = queryRequest({ pageSize: 200, sort: [{ desc, id: field }] });
        const database = openServedDatabase(dbPath, request.revision);
        try {
          try {
            expect(executeMaterializedSessionQuery(database, 'sessions', request)).toEqual(
              projectSessionPage(rows, request),
            );
          } catch (cause) {
            throw new Error(`Session query failed for ${field} ${desc ? 'descending' : 'ascending'}`, { cause });
          }
        } finally {
          database.close();
        }
      }
    }
  });

  test('filters sessions by machine ID when display labels collide', async () => {
    const first = row('machine-a-row', 10);
    const second = row('machine-b-row', 20);
    if (!(first.source && second.source)) {
      throw new Error('Machine filter fixtures require source identity');
    }
    const fixtureRows = [
      { ...first, source: { ...first.source, machineId: 'machine-a', machineLabel: 'Shared machine' } },
      { ...second, source: { ...second.source, machineId: 'machine-b', machineLabel: 'Shared machine' } },
    ];
    const { database } = await openRowsDatabase(fixtureRows);
    const request = queryRequest({
      filters: {
        ...queryRequest().filters,
        machine: ['machine-b'],
      },
      pageSize: 200,
    });
    try {
      const actual = executeMaterializedSessionQuery(database, 'sessions', request);
      expect(actual).toEqual(projectSessionPage(fixtureRows, request));
      expect(actual.items.map(({ row: itemRow }) => itemRow.sessionLabel)).toEqual(['machine-b-row']);
    } finally {
      database.close();
    }
  });

  test('preserves locale-sensitive text ordering and the exact identity tie-breaker', async () => {
    const textRows = ['a', 'A', 'ä', 'z', 'É', 'e', '_', '-', '10', '2'].map(textRow);
    const identityRows = [row('identity-a', 20), row('identity-A', 20)];
    const fixtureRows = [...textRows, ...identityRows];
    const { database } = await openRowsDatabase(fixtureRows);
    try {
      const identityRequest = queryRequest({ pageSize: 200, sort: [{ desc: false, id: 'cost' }] });

      for (const field of sessionTextSortFields) {
        const textRequest = queryRequest({ pageSize: 200, sort: [{ desc: false, id: field }] });
        expect(executeMaterializedSessionQuery(database, 'sessions', textRequest)).toEqual(
          projectSessionPage(fixtureRows, textRequest),
        );
      }
      expect(
        executeMaterializedSessionQuery(database, 'sessions', identityRequest)
          .items.filter(({ row: itemRow }) => itemRow.sessionLabel.startsWith('identity-'))
          .map(({ row: itemRow }) => itemRow.sessionLabel),
      ).toEqual(
        identityRows
          .toSorted((left, right) =>
            compareSessionIdentityValues(
              `campaign:${sessionCampaignIdentityForRow(enrichSessionPresentationRow(left)).campaignKey}`,
              `campaign:${sessionCampaignIdentityForRow(enrichSessionPresentationRow(right)).campaignKey}`,
            ),
          )
          .map(({ sessionLabel }) => sessionLabel),
      );
    } finally {
      database.close();
    }
  });

  test('orders campaign cost near-ties with JavaScript left-to-right addition before paging', async () => {
    const fixtureRows = [
      campaignCostRow('z-near-child-a', 0.3, { parent: 'z-near-root', root: 'z-near-root' }),
      campaignCostRow('z-near-root', 0.1, { root: 'z-near-root' }),
      campaignCostRow('z-near-child-b', 0.2, { parent: 'z-near-root', root: 'z-near-root' }),
      campaignCostRow('a-exact-root', 0.6, { root: 'a-exact-root' }),
      campaignCostRow('a-exact-child', 0, { parent: 'a-exact-root', root: 'a-exact-root' }),
    ];
    const { database } = await openRowsDatabase(fixtureRows);
    try {
      for (const field of ['cost', 'actual', 'quota'] as const) {
        const request = queryRequest({ pageSize: 200, sort: [{ desc: true, id: field }] });
        const expected = projectSessionPage(fixtureRows, request);
        const actual = executeMaterializedSessionQuery(database, 'sessions', request);

        expect(actual).toEqual(expected);
        expect(actual.items.map(({ row: itemRow }) => itemRow.sessionLabel)).toEqual(['z-near-root', 'a-exact-root']);
      }
    } finally {
      database.close();
    }
  });

  test('keeps and pages campaign lower bounds by their known subtotal', async () => {
    const fixtureRows = [
      campaignCostRow('exact-high-root', 70, { root: 'exact-high-root' }),
      campaignCostRow('partial-root', 68.09, { root: 'partial-root' }),
      campaignCostRow('partial-child', 1.21, { parent: 'partial-root', root: 'partial-root' }, false),
      campaignCostRow('exact-low-root', 69.2, { root: 'exact-low-root' }),
      campaignCostRow('unknown-root', 0, { root: 'unknown-root' }, false),
    ];
    const { database } = await openRowsDatabase(fixtureRows);
    try {
      const firstRequest = queryRequest({ pageSize: 1, sort: [{ desc: true, id: 'cost' }] });
      const first = executeMaterializedSessionQuery(database, 'sessions', firstRequest);
      expect(first).toEqual(projectSessionPage(fixtureRows, firstRequest));
      expect(first.items[0]?.row.sessionLabel).toBe('exact-high-root');
      expect(first.nextCursor).not.toBeNull();

      const secondRequest = { ...firstRequest, cursor: first.nextCursor };
      const second = executeMaterializedSessionQuery(database, 'sessions', secondRequest);
      expect(second).toEqual(projectSessionPage(fixtureRows, secondRequest));
      expect(second.items[0]?.row).toMatchObject({
        costApprox: 69.3,
        costKnown: false,
        priceMeasurement: {
          knownCost: 69.3,
          state: 'partially measured',
          unpricedFreshTokens: 3,
        },
        sessionLabel: 'partial-root',
      });

      const ascendingRequest = queryRequest({ pageSize: 200, sort: [{ desc: false, id: 'cost' }] });
      const ascending = executeMaterializedSessionQuery(database, 'sessions', ascendingRequest);
      expect(ascending).toEqual(projectSessionPage(fixtureRows, ascendingRequest));
      const unknownCampaign = ascending.items.find(({ row: itemRow }) => itemRow.sessionLabel === 'unknown-root');
      expect(unknownCampaign?.row.priceMeasurement).toEqual({
        knownCost: 0,
        state: 'partially measured',
        unpricedFreshTokens: 3,
      });
      expect(ascending.items.map(({ row: itemRow }) => itemRow.sessionLabel)).toEqual([
        'unknown-root',
        'exact-low-root',
        'partial-root',
        'exact-high-root',
      ]);
    } finally {
      database.close();
    }
  });

  test('pages top-level items and campaign children in SQLite with a single sentinel row', async () => {
    const { database } = await openFixtureDatabase();
    const traces: { params: readonly unknown[]; sql: string }[] = [];
    const trace: SessionQuerySqliteTrace = (query) => traces.push(query);
    try {
      const request = queryRequest();
      const first = executeMaterializedSessionQuery(database, 'sessions', request, trace);
      expect(first).toEqual(projectSessionPage(rows, request));
      expect(traces).toHaveLength(3);
      expect(traces[1]?.sql).toContain('LIMIT ? OFFSET ?');
      expect(traces[1]?.params.slice(-2)).toEqual([request.pageSize + 1, 0]);
      expect(traces[2]?.sql).toContain('campaign_root DESC, ordinal');

      const campaign = first.items.find((item) => item.kind === 'campaign');
      expect(campaign?.kind).toBe('campaign');
      if (campaign?.kind !== 'campaign') {
        throw new Error('Expected a campaign page item');
      }
      traces.length = 0;
      const childRequest = { campaignKey: campaign.campaignKey, query: { ...request, pageSize: 1 } };
      expect(executeMaterializedSessionQuery(database, 'campaign-children', childRequest, trace)).toEqual(
        projectSessionCampaignChildren(rows, childRequest),
      );
      expect(traces).toHaveLength(2);
      expect(traces[1]?.sql).toContain('LIMIT ? OFFSET ?');
      expect(traces[1]?.params.slice(-2)).toEqual([2, 0]);
    } finally {
      database.close();
    }
  });

  test('finds neighbors through the full filtered and sorted SQL sequence', async () => {
    const { database } = await openFixtureDatabase();
    const request = queryRequest({ pageSize: 1 });
    const target = rows.find((candidate) => candidate.source?.sourceSessionId === 'campaign-root');
    if (!target) {
      throw new Error('Expected an atomic neighbor target');
    }
    const rowId = sessionRowIdentity(target);
    const neighborRequest = { query: request, rowId };
    const traces: { params: readonly unknown[]; sql: string }[] = [];
    try {
      expect(
        executeMaterializedSessionQuery(database, 'neighbors', neighborRequest, (query) => traces.push(query)),
      ).toEqual(projectSessionNeighbors(rows, neighborRequest));
      expect(traces).toHaveLength(1);
      expect(traces[0]?.sql).toContain('LAG(row_json)');
      expect(traces[0]?.sql).toContain('LEAD(row_json)');
    } finally {
      database.close();
    }
  });

  test('applies filters before campaign aggregation from the durable projection', async () => {
    const { database } = await openFixtureDatabase();
    const request = queryRequest({
      filters: { fields: {}, harness: [], machine: [], query: 'child-a' },
      pageSize: 200,
    });
    try {
      expect(executeMaterializedSessionQuery(database, 'sessions', request)).toEqual(projectSessionPage(rows, request));
    } finally {
      database.close();
    }
  });

  test('keeps undeclared-origin sessions under a narrowed origin filter in pure and SQLite parity', async () => {
    const fixtureRows = [
      { ...row('human', 10), origin: 'human' as const },
      { ...row('delegated', 20), origin: 'subagent' as const },
      { ...row('undeclared', 30), originProvenance: 'origin-unsupported' as const },
    ];
    const { database } = await openRowsDatabase(fixtureRows);
    const request = queryRequest({
      filters: {
        fields: {},
        harness: [],
        machine: [],
        origin: ['human'],
        query: '',
      },
      pageSize: 200,
    });
    try {
      const expectedPage = projectSessionPage(fixtureRows, request);
      const page = executeMaterializedSessionQuery(database, 'sessions', request);

      expect(expectedPage.sessionCount).toBe(2);
      expect(page).toEqual(expectedPage);
    } finally {
      database.close();
    }
  });

  test('keeps classifier rollups and active campaign counts in pure and SQLite parity', async () => {
    const fixtureRows = [
      { ...row('campaign-root', 10, { root: 'campaign-root' }), origin: 'human' as const },
      {
        ...row('campaign-child', 20, { parent: 'campaign-root', root: 'campaign-root' }),
        origin: 'subagent' as const,
      },
      {
        ...row('classifier-review', 5, { parent: 'campaign-root', root: 'campaign-root' }),
        origin: 'classifier' as const,
      },
    ];
    const { database } = await openRowsDatabase(fixtureRows);
    const request = queryRequest({
      filters: {
        fields: {},
        harness: [],
        machine: [],
        origin: ['human', 'subagent'],
        query: '',
      },
      pageSize: 200,
      sort: [{ desc: true, id: 'cost' }],
    });
    try {
      const expectedPage = projectSessionPage(fixtureRows, request);
      const page = executeMaterializedSessionQuery(database, 'sessions', request);
      expect(page).toEqual(expectedPage);
      if (!('items' in page) || page.items[0]?.kind !== 'campaign') {
        throw new Error('Expected a campaign page fixture');
      }
      expect(page.items[0].row).toMatchObject({
        campaignClassifierCount: 1,
        campaignClassifierFreshTokens: 15,
        campaignTotalCount: 3,
        campaignVisibleCount: 2,
        freshTokens: 105,
      });

      const childrenRequest = { campaignKey: page.items[0].campaignKey, query: request };
      expect(executeMaterializedSessionQuery(database, 'campaign-children', childrenRequest)).toEqual(
        projectSessionCampaignChildren(fixtureRows, childrenRequest),
      );
    } finally {
      database.close();
    }
  });

  test('filters sessions by every attributed model segment', async () => {
    const segmentedRow: SerializedRow = {
      ...row('multi-model', 10),
      costApprox: 6,
      freshTokens: 77,
      model: 'gpt-5.4',
      modelSegments: [
        {
          costApprox: 2,
          costKnown: true,
          model: 'gpt-5.4',
          tokCr: 3,
          tokCw: 4,
          tokIn: 1,
          tokOut: 2,
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
      models: ['gpt-5.4', 'claude-opus-4-6'],
      tokCr: 33,
      tokCw: 44,
      tokIn: 11,
      tokOut: 22,
      tokenTotal: 110,
    };
    const fixtureRows = [segmentedRow, row('single-model', 20)];
    const { database } = await openRowsDatabase(fixtureRows);
    const request = queryRequest({
      filters: {
        fields: { model: 'claude-opus-4-6' },
        harness: [],
        machine: [],
        query: '',
      },
      pageSize: 200,
    });
    try {
      expect(executeMaterializedSessionQuery(database, 'sessions', request)).toEqual(
        projectSessionPage(fixtureRows, request),
      );
    } finally {
      database.close();
    }
  });

  test('pages 5,000 singleton campaigns within the production query budget', async () => {
    const fixtureRows = Array.from({ length: 5000 }, (_, index) => row(`scale-session-${index}`, (index % 1000) + 1));
    const { database } = await openRowsDatabase(fixtureRows);
    const request = queryRequest({
      pageSize: 100,
      sort: [{ desc: true, id: 'date' }],
    });
    try {
      const startedAt = performance.now();
      const actual = executeMaterializedSessionQuery(database, 'sessions', request);
      const durationMs = performance.now() - startedAt;

      expect(actual).toEqual(projectSessionPage(fixtureRows, request));
      expect(actual.itemCount).toBe(5000);
      expect(actual.sessionCount).toBe(5000);
      expect(durationMs).toBeLessThan(5000);
    } finally {
      database.close();
    }
  }, 30_000);

  test('returns a bounded page through the exact-revision read API', async () => {
    const request = queryRequest();
    const { database, dbPath } = await openFixtureDatabase();
    database.close();
    const result = await Effect.runPromise(
      queryServedRevisionData({ dbPath, kind: 'sessions', now: 1001, request, revision: 'revision-a' }),
    );

    expect(result).toEqual(projectSessionPage(rows, request));
    if (!('items' in result)) {
      throw new Error('The exact-revision sessions query must return a page');
    }
    expect(result.revision).toBe('revision-a');
    expect(result.requestFingerprint).toStartWith('session-query-v1:');
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).not.toBeNull();
    expect(result.sessionCount).toBe(rows.length);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2 * 1024 * 1024);
  });
});
