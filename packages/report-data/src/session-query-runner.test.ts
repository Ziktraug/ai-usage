import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_SESSION_QUERY_DATABASE_BYTES } from '@ai-usage/report-core/report-budgets';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import {
  projectSessionCampaignChildren,
  projectSessionNeighbors,
  projectSessionPage,
  type SessionQueryRequest,
  sessionSortFields,
  sessionTextSortFields,
} from '@ai-usage/report-core/session-query';
import { materializeSessionQueryDatabase, SESSION_QUERY_DATABASE_NAME } from './session-query-materialization';
import {
  assertSessionQueryDatabase,
  executeMaterializedSessionQuery,
  type SessionQuerySqliteTrace,
} from './session-query-sqlite';

const runnerPath = path.join(import.meta.dir, 'revision-query-runner.ts');
const materializeRunnerPath = path.join(import.meta.dir, 'session-query-materialize-runner.ts');
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { force: true, recursive: true })));
  temporaryDirectories.clear();
});

const row = (
  sourceSessionId: string,
  tokenTotal: number,
  campaign?: { parent?: string; root: string },
): SerializedRow => ({
  activeDate: `2026-07-0${Math.min(tokenTotal, 9)}T10:00:00.000Z`,
  calls: tokenTotal,
  costActual: tokenTotal / 100,
  costApprox: tokenTotal / 10,
  costKnown: sourceSessionId !== 'unknown-cost',
  costQuota: tokenTotal / 100,
  date: '2026-07-01T10:00:00.000Z',
  durationMs: tokenTotal * 1000,
  endDate: '2026-07-01T10:01:00.000Z',
  freshTokens: tokenTotal,
  harness: sourceSessionId === 'standalone-a' ? 'Claude Code' : 'Codex',
  lineDelta: tokenTotal,
  linesAdded: tokenTotal + 1,
  linesDeleted: 1,
  model: sourceSessionId === 'standalone-a' ? 'claude-opus-4-6' : 'gpt-5.4',
  name: sourceSessionId,
  partial: sourceSessionId === 'campaign-child-b',
  project: sourceSessionId === 'standalone-b' ? 'side-project' : 'ai-usage',
  provider: sourceSessionId === 'standalone-a' ? 'Anthropic' : 'Codex API',
  rtkCommandCount: tokenTotal,
  rtkInputTokens: tokenTotal * 2,
  rtkOutputTokens: tokenTotal,
  rtkSavedTokens: tokenTotal,
  sessionLabel: sourceSessionId,
  source: {
    harnessKey: 'codex',
    machineId: 'machine-a',
    machineLabel: 'Machine A',
    ...(campaign?.parent === undefined ? {} : { parentSourceSessionId: campaign.parent }),
    rootSourceSessionId: campaign?.root ?? sourceSessionId,
    sourceSessionId,
  },
  subagent: campaign?.parent !== undefined,
  tokCr: tokenTotal,
  tokCw: tokenTotal,
  tokIn: tokenTotal,
  tokOut: tokenTotal,
  tokenTotal,
  tools: tokenTotal,
  turns: tokenTotal,
});

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
  campaigns: true,
  cursor: null,
  filters: { fields: {}, harness: [], machine: [], query: '' },
  pageSize: 2,
  range: { from: null, to: null },
  revision: 'revision-a',
  sort: [{ desc: true, id: 'total' }],
  ...overrides,
});

const createRevision = async (): Promise<string> => {
  const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-session-revision-'));
  temporaryDirectories.add(revisionDirectory);
  await chmod(revisionDirectory, 0o700);
  await materializeSessionQueryDatabase(revisionDirectory, rows);
  return revisionDirectory;
};

const openFixtureDatabase = async (): Promise<{ database: Database; revisionDirectory: string }> => {
  const revisionDirectory = await createRevision();
  const database = new Database(path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME), {
    readonly: true,
    strict: true,
  });
  assertSessionQueryDatabase(database);
  return { database, revisionDirectory };
};

const openRowsDatabase = async (
  fixtureRows: SerializedRow[],
): Promise<{ database: Database; revisionDirectory: string }> => {
  const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-session-parity-'));
  temporaryDirectories.add(revisionDirectory);
  await chmod(revisionDirectory, 0o700);
  await materializeSessionQueryDatabase(revisionDirectory, fixtureRows);
  const database = new Database(path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME), {
    readonly: true,
    strict: true,
  });
  assertSessionQueryDatabase(database);
  return { database, revisionDirectory };
};

const runFixture = async (request: unknown, kind = 'sessions') => {
  const revisionDirectory = await createRevision();
  const outputDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-session-result-'));
  temporaryDirectories.add(outputDirectory);
  await chmod(outputDirectory, 0o700);
  const outputPath = path.join(outputDirectory, 'result.json');
  const output = await open(outputPath, 'wx', 0o600);
  await output.close();
  const child = Bun.spawn(['bun', runnerPath, revisionDirectory, kind, JSON.stringify(request), outputPath], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  const serializedResult = await readFile(outputPath, 'utf8');
  return { exitCode, revisionDirectory, serializedResult, stderr, stdout };
};

describe('session query SQLite materialization', () => {
  test('materializes from rows.json once in a silent Bun publication job', async () => {
    const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-session-publication-'));
    temporaryDirectories.add(revisionDirectory);
    await chmod(revisionDirectory, 0o700);
    await writeFile(path.join(revisionDirectory, 'rows.json'), JSON.stringify(rows), { mode: 0o600 });
    await writeFile(
      path.join(revisionDirectory, 'support.json'),
      JSON.stringify({
        analytics: {},
        filters: { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
        generatedAt: '2026-07-13T00:00:00.000Z',
        omittedRows: 0,
      }),
      { mode: 0o600 },
    );

    const child = Bun.spawn(['bun', materializeRunnerPath, revisionDirectory], { stderr: 'pipe', stdout: 'pipe' });
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toBe('');
    const database = new Database(path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME), { readonly: true });
    try {
      assertSessionQueryDatabase(database);
      expect(executeMaterializedSessionQuery(database, 'sessions', queryRequest())).toEqual(
        projectSessionPage(rows, queryRequest()),
      );
    } finally {
      database.close();
    }
  });

  test('materializes every derived sort field and preserves pure projection parity', async () => {
    const { database } = await openFixtureDatabase();
    try {
      for (const field of sessionSortFields) {
        for (const desc of [false, true]) {
          const request = queryRequest({ pageSize: 200, sort: [{ desc, id: field }] });
          expect(executeMaterializedSessionQuery(database, 'sessions', request)).toEqual(
            projectSessionPage(rows, request),
          );
        }
      }
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
      const identityRequest = queryRequest({ campaigns: false, pageSize: 200, sort: [{ desc: false, id: 'cost' }] });

      for (const field of sessionTextSortFields) {
        const textRequest = queryRequest({ campaigns: false, pageSize: 200, sort: [{ desc: false, id: field }] });
        expect(executeMaterializedSessionQuery(database, 'sessions', textRequest)).toEqual(
          projectSessionPage(fixtureRows, textRequest),
        );
      }
      expect(
        executeMaterializedSessionQuery(database, 'sessions', identityRequest)
          .items.filter(({ row: itemRow }) => itemRow.sessionLabel.startsWith('identity-'))
          .map(({ row: itemRow }) => itemRow.sessionLabel),
      ).toEqual(['identity-A', 'identity-a']);
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
        sessionLabel: 'partial-root',
      });

      const ascendingRequest = queryRequest({ pageSize: 200, sort: [{ desc: false, id: 'cost' }] });
      const ascending = executeMaterializedSessionQuery(database, 'sessions', ascendingRequest);
      expect(ascending).toEqual(projectSessionPage(fixtureRows, ascendingRequest));
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
    const request = queryRequest({ campaigns: false, pageSize: 1 });
    const rowId = projectSessionPage(rows, request).items[0]?.row.rowId;
    if (!rowId) {
      throw new Error('Expected a projected session row');
    }
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

  test('applies filters before campaign aggregation without reading rows.json', async () => {
    const { database, revisionDirectory } = await openFixtureDatabase();
    await rm(path.join(revisionDirectory, 'rows.json'), { force: true });
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

  test('creates an owner-only database artifact', async () => {
    const revisionDirectory = await createRevision();
    const databaseStat = await stat(path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME));
    // biome-ignore lint/suspicious/noBitwiseOperators: Unix permission bits are a documented bitmask API.
    expect(databaseStat.mode & 0o777).toBe(0o600);
    expect(databaseStat.isFile()).toBe(true);
  });

  test('keeps the supported 50,000-row database inside its explicit artifact ceiling', async () => {
    const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-session-maximum-'));
    temporaryDirectories.add(revisionDirectory);
    await chmod(revisionDirectory, 0o700);
    const maximumRows = Array.from({ length: 50_000 }, (_, index) =>
      row(`maximum-session-${index}`, (index % 1000) + 1),
    );

    await materializeSessionQueryDatabase(revisionDirectory, maximumRows);

    const databaseStat = await stat(path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME));
    expect(databaseStat.size).toBeLessThanOrEqual(MAX_SESSION_QUERY_DATABASE_BYTES);
  }, 30_000);
});

describe('session query runner', () => {
  test('returns a bounded exact-revision page without stdout or rows.json transport', async () => {
    const request = queryRequest();
    const run = await runFixture(request);
    const result = JSON.parse(run.serializedResult) as {
      items: unknown[];
      nextCursor: string | null;
      requestFingerprint: string;
      revision: string;
      sessionCount: number;
    };

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
    expect(result).toEqual(projectSessionPage(rows, request));
    expect(result.revision).toBe('revision-a');
    expect(result.requestFingerprint).toStartWith('session-query-v1:');
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).not.toBeNull();
    expect(result.sessionCount).toBe(rows.length);
    expect(Buffer.byteLength(run.serializedResult)).toBeLessThan(2 * 1024 * 1024);
  });

  test('rejects a page beyond the shared 200-item ceiling', async () => {
    const run = await runFixture(queryRequest({ pageSize: 201 }));

    expect(run.exitCode).not.toBe(0);
    expect(run.serializedResult).toBe('');
    expect(run.stderr).toContain('pageSize must be between 1 and 200');
  });

  test('rejects a database artifact with group-readable permissions', async () => {
    const revisionDirectory = await createRevision();
    await chmod(path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME), 0o640);
    const outputDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-session-result-'));
    temporaryDirectories.add(outputDirectory);
    await chmod(outputDirectory, 0o700);
    const outputPath = path.join(outputDirectory, 'result.json');
    const output = await open(outputPath, 'wx', 0o600);
    await output.close();
    const child = Bun.spawn(
      ['bun', runnerPath, revisionDirectory, 'sessions', JSON.stringify(queryRequest()), outputPath],
      { stderr: 'pipe', stdout: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('must be private, owned by the current user, and not a symlink');
    expect(await readFile(outputPath, 'utf8')).toBe('');
  });
});
