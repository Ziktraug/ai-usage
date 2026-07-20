import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readClaudeSessionAnalysis } from '@ai-usage/local-collectors/claude-history';
import { readCodexSessionAnalysis } from '@ai-usage/local-collectors/codex-history';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-collectors/local-history';
import { writeMachineConfig } from '@ai-usage/local-collectors/machine-config';
import { readOpenCodeSessionAnalysis } from '@ai-usage/local-collectors/opencode-history';
import {
  appendCodexRootUsage,
  HARNESS_FIXTURE_CREDENTIAL_REMOTE_SENTINEL,
  HARNESS_FIXTURE_DANGEROUS_URL_SENTINEL,
  HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL,
  HARNESS_FIXTURE_PROVIDER_STDERR_SENTINEL,
  seedHarnessHome,
} from '@ai-usage/local-collectors/test-fixtures/harness-home';
import {
  createUsageMergeBundle,
  parseUsageMergeBundle,
  serializeUsageMergeBundle,
} from '@ai-usage/report-core/merge-bundle';
import { compareSessionProjectionFacts } from '@ai-usage/report-core/session-detail';
import { projectSessionPage, type SessionQueryRequest } from '@ai-usage/report-core/session-query';
import { parseUsageSnapshot, serializeUsageSnapshot } from '@ai-usage/report-core/snapshot';
import type { CollectedUsageRow } from '@ai-usage/report-core/types';
import { queryReportRows, usageStorePath } from '@ai-usage/usage-store';
import { Effect } from 'effect';
import { createMergedUsageReport, createStoredReportCapture, createStoredUsageSnapshot } from './index';
import { materializeSessionQueryDatabase, SESSION_QUERY_DATABASE_NAME } from './session-query-materialization';
import { assertSessionQueryDatabase, executeMaterializedSessionQuery } from './session-query-sqlite';
import { createScheduledSourceRegistry, type SourceRunContext } from './source-adapters';

const FIXED_MACHINE = { id: 'machine-fixture-025', label: 'Fixture machine' } as const;
const GENERATED_AT = new Date('2026-07-10T12:00:00.000Z');
const EPHEMERAL_GH_RESULT_SENTINEL = 'https://github.com/fixture/ai-usage/pull/270027';
const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

const sourceContext: SourceRunContext = { reportProgress: () => Effect.void };

const request = (overrides: Partial<SessionQueryRequest> = {}): SessionQueryRequest => ({
  campaigns: true,
  cursor: null,
  filters: { fields: {}, harness: [], machine: [], query: '' },
  pageSize: 20,
  range: { from: null, to: null },
  revision: 'fixture-revision-025',
  sort: [{ desc: true, id: 'date' }],
  ...overrides,
});

const compactRow = (row: CollectedUsageRow) => ({
  sourceSessionId: row.source?.sourceSessionId,
  parentSourceSessionId: row.source?.parentSourceSessionId ?? null,
  rootSourceSessionId: row.source?.rootSourceSessionId ?? null,
  date: row.date?.toISOString() ?? null,
  endDate: row.endDate?.toISOString() ?? null,
  durationMs: row.durationMs ?? null,
  tokIn: row.tokIn,
  tokOut: row.tokOut,
  tokCr: row.tokCr,
  tokCw: row.tokCw,
  tokenTotal: row.tokIn + row.tokOut + row.tokCr + row.tokCw,
  models: row.models ?? [],
  modelSegments: (row.modelSegments ?? []).map(({ costKnown, model, tokCr, tokCw, tokIn, tokOut }) => ({
    costKnown,
    model,
    tokCr,
    tokCw,
    tokIn,
    tokOut,
  })),
  costKnown: row.costKnown,
  costActual: row.costActual,
  calls: row.calls,
  turns: row.turns,
  tools: row.tools,
  partial: row.partial ?? false,
  usageUnavailable: row.usageUnavailable ?? false,
});

const reportOptions = { limit: null, minTokens: 0, project: null, since: null, sort: 'date' as const };

const readFilesUnder = async (directory: string): Promise<Buffer[]> => {
  const files: Buffer[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        files.push(await fs.readFile(entryPath));
      }
    }
  };
  await visit(directory);
  return files;
};

describe('session report pipeline', () => {
  test('keeps literal multi-harness facts through source, store, payload, and materialized SQLite', async () => {
    const home = await makeTemporaryDirectory('ai-usage-session-pipeline-home-');
    const revisionDirectory = await makeTemporaryDirectory('ai-usage-session-pipeline-revision-');
    const portableRevisionDirectory = await makeTemporaryDirectory('ai-usage-session-pipeline-portable-');
    await fs.chmod(revisionDirectory, 0o700);
    await fs.chmod(portableRevisionDirectory, 0o700);
    const storage = createLocalHistoryStorage(home);
    await Effect.runPromise(
      writeMachineConfig(FIXED_MACHINE).pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    const fixture = await seedHarnessHome(home);
    const registry = await Effect.runPromise(
      createScheduledSourceRegistry({ codexLiveAvailable: () => false, machine: FIXED_MACHINE }).pipe(
        Effect.provideService(LocalHistoryStorage, storage),
      ),
    );
    for (const sourceId of ['claude.sessions', 'codex.sessions', 'opencode.sessions', 'cursor.sessions'] as const) {
      const source = registry.get(sourceId);
      if (!source) {
        throw new Error(`Missing fixture source ${sourceId}`);
      }
      await Effect.runPromise(source.run(sourceContext));
    }

    const stored = await Effect.runPromise(queryReportRows({ dbPath: usageStorePath(home) }));
    const capture = await Effect.runPromise(
      createStoredReportCapture({
        generatedAt: GENERATED_AT,
        harness: null,
        includeCursor: true,
        options: reportOptions,
      }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    const { payload } = capture;
    await materializeSessionQueryDatabase(revisionDirectory, payload.rows, undefined, capture.rowSourceAuthorities);
    const database = new Database(path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME), {
      readonly: true,
      strict: true,
    });
    try {
      assertSessionQueryDatabase(database);
      const materializedPage = executeMaterializedSessionQuery(database, 'sessions', request());
      expect(materializedPage).toEqual(projectSessionPage(payload.rows, request()));
      const materializedOpenCode = materializedPage.items.find(
        ({ row: materializedRow }) => materializedRow.source?.sourceSessionId === fixture.ids.opencode,
      )?.row;
      expect(materializedOpenCode).toMatchObject({
        calls: 3,
        durationMs: 90_000,
        modelSegments: [
          { model: 'openai/gpt-5', tokCr: 23, tokCw: 4, tokIn: 60, tokOut: 18 },
          { model: 'anthropic/claude-sonnet-4-6', tokCr: 6, tokCw: 1, tokIn: 30, tokOut: 10 },
        ],
        tokCr: 29,
        tokCw: 5,
        tokIn: 90,
        tokOut: 28,
        tools: 1,
        turns: 1,
      });
      if (!materializedOpenCode) {
        throw new Error('Missing materialized OpenCode fixture row');
      }
      const openCodeAnchor = executeMaterializedSessionQuery(database, 'session-detail-anchor', {
        revision: request().revision,
        rowId: materializedOpenCode.rowId,
      }).anchor;
      const openCodeAnalysis = await Effect.runPromise(
        readOpenCodeSessionAnalysis(fixture.ids.opencode).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      if (!(openCodeAnchor && openCodeAnalysis)) {
        throw new Error('Missing OpenCode report anchor or local analysis');
      }
      expect(openCodeAnchor.sourceAuthority).toBe('local-observed');
      expect(compareSessionProjectionFacts(openCodeAnchor.projection, openCodeAnalysis.projection)).toEqual({
        checkedFields: ['calls', 'duration', 'model-attribution', 'coverage', 'tokens', 'tools', 'turns'],
        status: 'matches-report',
      });

      const materializedClaude = materializedPage.items.find(
        ({ row: materializedRow }) => materializedRow.source?.sourceSessionId === fixture.ids.claude,
      )?.row;
      const materializedCodex = materializedPage.items.find(
        ({ row: materializedRow }) => materializedRow.source?.sourceSessionId === fixture.ids.codexRoot,
      )?.row;
      if (!(materializedClaude && materializedCodex)) {
        throw new Error('Missing materialized Claude or Codex fixture row');
      }
      expect(materializedClaude.source?.vcs).toMatchObject({
        branches: [{ name: 'fixture/main' }, { name: 'fixture/topic' }],
        headCommit: null,
        pullRequests: [{ number: 27, url: 'https://github.com/fixture/ai-usage/pull/27' }],
        repository: { ownerPath: 'fixture/ai-usage', provenance: 'local-derived' },
      });
      expect(materializedCodex.source?.vcs).toMatchObject({
        branches: [{ name: 'fixture/main', provenance: 'harness-recorded' }],
        headCommit: { hash: '0123456789abcdef0123456789abcdef01234567' },
        pullRequests: [],
        repository: { ownerPath: 'fixture/ai-usage', provenance: 'harness-recorded' },
      });
      expect(materializedOpenCode.source?.vcs).toMatchObject({
        branches: [],
        headCommit: null,
        pullRequests: [],
        repository: { ownerPath: 'fixture/ai-usage', provenance: 'local-derived' },
      });

      const claudeAnchor = executeMaterializedSessionQuery(database, 'session-detail-anchor', {
        revision: request().revision,
        rowId: materializedClaude.rowId,
      }).anchor;
      const claudeAnalysis = await Effect.runPromise(
        readClaudeSessionAnalysis(fixture.ids.claude).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      if (!(claudeAnchor && claudeAnalysis)) {
        throw new Error('Missing Claude report anchor or local analysis');
      }
      expect(claudeAnchor.sourceAuthority).toBe('local-observed');
      expect(compareSessionProjectionFacts(claudeAnchor.projection, claudeAnalysis.projection)).toEqual({
        checkedFields: ['calls', 'duration', 'model-attribution', 'coverage', 'tokens', 'tools', 'turns'],
        status: 'matches-report',
      });
      expect(claudeAnalysis.detail.prompts.map(({ text }) => text)).toContain(HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL);

      const byHarness = new Map<string, CollectedUsageRow[]>();
      for (const row of stored.rows) {
        const harness = row.source?.harnessKey ?? 'missing';
        const rows = byHarness.get(harness) ?? [];
        rows.push(row);
        byHarness.set(harness, rows);
      }
      const compactByHarness = Object.fromEntries(
        [...byHarness].map(([harness, rows]) => [
          harness,
          rows
            .map(compactRow)
            .sort((left, right) => (left.sourceSessionId ?? '').localeCompare(right.sourceSessionId ?? '')),
        ]),
      );
      expect(compactByHarness).toEqual({
        claude: [
          {
            calls: 1,
            costActual: 0,
            costKnown: true,
            date: '2026-07-01T08:00:30.000Z',
            durationMs: null,
            endDate: '2026-07-01T08:00:40.000Z',
            modelSegments: [{ costKnown: true, model: 'claude-sonnet-4-6', tokCr: 0, tokCw: 0, tokIn: 5, tokOut: 3 }],
            models: ['claude-sonnet-4-6'],
            parentSourceSessionId: 'claude-fixture-025',
            partial: false,
            rootSourceSessionId: null,
            sourceSessionId: 'agent-claude-fixture-027',
            tokCr: 0,
            tokCw: 0,
            tokIn: 5,
            tokOut: 3,
            tokenTotal: 8,
            tools: 0,
            turns: 1,
            usageUnavailable: false,
          },
          {
            calls: 2,
            costActual: 0,
            costKnown: true,
            date: '2026-07-01T08:00:00.000Z',
            durationMs: 60_000,
            endDate: '2026-07-01T08:04:30.000Z',
            modelSegments: [
              { costKnown: true, model: 'claude-sonnet-4-6', tokCr: 30, tokCw: 10, tokIn: 100, tokOut: 20 },
              { costKnown: true, model: 'claude-opus-4-1', tokCr: 5, tokCw: 2, tokIn: 40, tokOut: 15 },
            ],
            models: ['claude-sonnet-4-6', 'claude-opus-4-1'],
            parentSourceSessionId: null,
            partial: true,
            rootSourceSessionId: null,
            sourceSessionId: 'claude-fixture-025',
            tokCr: 35,
            tokCw: 12,
            tokIn: 140,
            tokOut: 35,
            tokenTotal: 222,
            tools: 1,
            turns: 2,
            usageUnavailable: false,
          },
        ],
        codex: [
          {
            calls: 1,
            costActual: 0.000_66,
            costKnown: true,
            date: '2026-07-02T09:10:10.000Z',
            durationMs: 120_000,
            endDate: '2026-07-02T09:13:00.000Z',
            modelSegments: [{ costKnown: true, model: 'gpt-5.6-terra', tokCr: 40, tokCw: 0, tokIn: 80, tokOut: 30 }],
            models: ['gpt-5.6-terra'],
            parentSourceSessionId: 'codex-root-025',
            partial: false,
            rootSourceSessionId: null,
            sourceSessionId: 'codex-child-025',
            tokCr: 40,
            tokCw: 0,
            tokIn: 80,
            tokOut: 30,
            tokenTotal: 150,
            tools: 1,
            turns: 2,
            usageUnavailable: false,
          },
          {
            calls: 1,
            costActual: 0.001_092_5,
            costKnown: true,
            date: '2026-07-02T09:00:10.000Z',
            durationMs: 120_010,
            endDate: '2026-07-02T09:03:00.000Z',
            modelSegments: [
              { costKnown: true, model: 'gpt-5.6-sol', tokCr: 30, tokCw: 0, tokIn: 50, tokOut: 20 },
              { costKnown: true, model: 'gpt-5.6-terra', tokCr: 10, tokCw: 0, tokIn: 30, tokOut: 10 },
            ],
            models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
            parentSourceSessionId: null,
            partial: true,
            rootSourceSessionId: null,
            sourceSessionId: 'codex-root-025',
            tokCr: 40,
            tokCw: 0,
            tokIn: 80,
            tokOut: 30,
            tokenTotal: 150,
            tools: 1,
            turns: 3,
            usageUnavailable: false,
          },
        ],
        cursor: [
          {
            calls: 1,
            costActual: 0,
            costKnown: false,
            date: '2026-07-05T11:00:00.000Z',
            durationMs: null,
            endDate: null,
            modelSegments: [],
            models: [],
            parentSourceSessionId: null,
            partial: true,
            rootSourceSessionId: null,
            sourceSessionId: 'cursor-fixture-025',
            tokCr: 5,
            tokCw: 0,
            tokIn: 25,
            tokOut: 7,
            tokenTotal: 37,
            tools: 0,
            turns: 1,
            usageUnavailable: false,
          },
        ],
        opencode: [
          {
            calls: 3,
            costActual: 0.85,
            costKnown: true,
            date: '2026-07-04T10:00:10.000Z',
            durationMs: 90_000,
            endDate: '2026-07-04T10:02:00.000Z',
            modelSegments: [
              { costKnown: true, model: 'openai/gpt-5', tokCr: 23, tokCw: 4, tokIn: 60, tokOut: 18 },
              { costKnown: true, model: 'anthropic/claude-sonnet-4-6', tokCr: 6, tokCw: 1, tokIn: 30, tokOut: 10 },
            ],
            models: ['openai/gpt-5', 'anthropic/claude-sonnet-4-6'],
            parentSourceSessionId: 'opencode-human-parent-025',
            partial: true,
            rootSourceSessionId: null,
            sourceSessionId: 'opencode-fixture-025',
            tokCr: 29,
            tokCw: 5,
            tokIn: 90,
            tokOut: 28,
            tokenTotal: 152,
            tools: 1,
            turns: 1,
            usageUnavailable: false,
          },
        ],
      });

      const expectedCosts = new Map([
        ['agent-claude-fixture-027', 0.000_06],
        ['claude-fixture-025', 0.002_416_5],
        ['codex-child-025', 0.000_66],
        ['codex-root-025', 0.001_092_5],
        ['cursor-fixture-025', 0],
        ['opencode-fixture-025', 0.000_508_425],
      ]);
      for (const row of stored.rows) {
        expect(row.costApprox).toBeCloseTo(expectedCosts.get(row.source?.sourceSessionId ?? '') ?? -1, 12);
      }
      const expectedSegmentCosts = new Map<string, readonly number[]>([
        ['agent-claude-fixture-027', [0.000_06]],
        ['claude-fixture-025', [0.000_646_5, 0.001_77]],
        ['codex-child-025', [0.000_66]],
        ['codex-root-025', [0.000_865, 0.000_227_5]],
        ['cursor-fixture-025', []],
        ['opencode-fixture-025', [0.000_262_875, 0.000_245_55]],
      ]);
      for (const row of stored.rows) {
        const expected = expectedSegmentCosts.get(row.source?.sourceSessionId ?? '') ?? [];
        expect(row.modelSegments ?? []).toHaveLength(expected.length);
        for (const [index, expectedCost] of expected.entries()) {
          expect(row.modelSegments?.[index]?.costApprox).toBeCloseTo(expectedCost, 12);
        }
      }

      for (const row of stored.rows) {
        if (!row.modelSegments?.length) {
          continue;
        }
        const segmentTotals = (row.modelSegments ?? []).reduce(
          (totals, segment) => ({
            cr: totals.cr + segment.tokCr,
            cw: totals.cw + segment.tokCw,
            in: totals.in + segment.tokIn,
            out: totals.out + segment.tokOut,
          }),
          { cr: 0, cw: 0, in: 0, out: 0 },
        );
        expect(segmentTotals).toEqual({ cr: row.tokCr, cw: row.tokCw, in: row.tokIn, out: row.tokOut });
      }

      const secondaryModelPage = projectSessionPage(
        payload.rows,
        request({ filters: { fields: { model: 'gpt-5.6-terra' }, harness: [], machine: [], query: '' } }),
      );
      expect(JSON.stringify(secondaryModelPage)).toContain(fixture.ids.codexRoot);

      const campaign = projectSessionPage(payload.rows, request()).items.find(
        (item) => item.kind === 'campaign' && item.row.source?.sourceSessionId === fixture.ids.codexRoot,
      );
      expect(campaign?.row).toMatchObject({
        calls: 2,
        campaignTotalCount: 2,
        campaignVisibleCount: 2,
        durationMs: 120_010,
        source: { rootSourceSessionId: fixture.ids.codexRoot },
        tokCr: 80,
        tokCw: 0,
        tokIn: 160,
        tokOut: 60,
        tokenTotal: 300,
        tools: 2,
        partial: true,
        turns: 5,
      });

      const snapshot = await Effect.runPromise(
        createStoredUsageSnapshot({
          generatedAt: GENERATED_AT,
          harness: null,
          includeCursor: true,
          machine: FIXED_MACHINE,
        }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      const snapshotText = serializeUsageSnapshot(snapshot);
      const parsedSnapshot = parseUsageSnapshot(snapshotText);
      expect(parsedSnapshot.schemaVersion).toBe(3);
      expect(
        parsedSnapshot.rows.find(({ source }) => source.sourceSessionId === fixture.ids.claude)?.source.vcs,
      ).toEqual(materializedClaude.source?.vcs);

      const mergeBundleText = serializeUsageMergeBundle(
        createUsageMergeBundle({ generatedAt: GENERATED_AT, machine: FIXED_MACHINE, rows: stored.rows }),
      );
      const parsedBundle = parseUsageMergeBundle(mergeBundleText);
      expect(parsedBundle.version).toBe(3);
      expect(
        parsedBundle.rows.find(({ source }) => source.sourceSessionId === fixture.ids.codexRoot)?.source.vcs,
      ).toEqual(materializedCodex.source?.vcs);

      const mergedPortable = await Effect.runPromise(
        createMergedUsageReport({
          configCwd: home,
          generatedAt: GENERATED_AT,
          harness: null,
          includeCursor: true,
          options: reportOptions,
          snapshots: [parsedSnapshot],
        }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      await materializeSessionQueryDatabase(
        portableRevisionDirectory,
        mergedPortable.payload.rows,
        undefined,
        mergedPortable.payload.rows.map(() => 'portable-opaque' as const),
      );
      const portableDatabase = new Database(path.join(portableRevisionDirectory, SESSION_QUERY_DATABASE_NAME), {
        readonly: true,
        strict: true,
      });
      try {
        const portablePage = executeMaterializedSessionQuery(portableDatabase, 'sessions', request());
        const portableClaude = portablePage.items.find(
          ({ row: portableRow }) => portableRow.source?.sourceSessionId === fixture.ids.claude,
        )?.row;
        if (!portableClaude) {
          throw new Error('Missing portable Claude fixture row');
        }
        expect(portableClaude.source?.vcs).toEqual(materializedClaude.source?.vcs);
        const portableAnchor = executeMaterializedSessionQuery(portableDatabase, 'session-detail-anchor', {
          revision: request().revision,
          rowId: portableClaude.rowId,
        }).anchor;
        expect(portableAnchor).toMatchObject({
          sourceAuthority: 'portable-opaque',
          vcs: materializedClaude.source?.vcs,
        });
      } finally {
        portableDatabase.close();
      }

      const serializedPayload = JSON.stringify(payload);
      const sourceRows = database
        .query<{ source_row_json: string }, []>('SELECT source_row_json FROM session_rows')
        .all();
      const serializedSourceRows = JSON.stringify(sourceRows);
      const serializedArtifacts = [serializedPayload, serializedSourceRows, snapshotText, mergeBundleText];
      const privateSentinels = [
        HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL,
        HARNESS_FIXTURE_CREDENTIAL_REMOTE_SENTINEL,
        HARNESS_FIXTURE_DANGEROUS_URL_SENTINEL,
        HARNESS_FIXTURE_PROVIDER_STDERR_SENTINEL,
        EPHEMERAL_GH_RESULT_SENTINEL,
      ];
      for (const sentinel of privateSentinels) {
        for (const artifact of serializedArtifacts) {
          expect(artifact).not.toContain(sentinel);
        }
      }
      const privateFiles = [
        ...(await readFilesUnder(path.join(home, '.config', 'ai-usage'))),
        await fs.readFile(path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME)),
        await fs.readFile(path.join(portableRevisionDirectory, SESSION_QUERY_DATABASE_NAME)),
      ];
      for (const sentinel of privateSentinels) {
        const bytes = Buffer.from(sentinel);
        expect(privateFiles.every((file) => !file.includes(bytes))).toBe(true);
      }
    } finally {
      database.close();
    }
  });

  test('compares a published Codex projection before and after local source mutation and recollection', async () => {
    const home = await makeTemporaryDirectory('ai-usage-session-freshness-home-');
    const firstRevisionDirectory = await makeTemporaryDirectory('ai-usage-session-freshness-first-');
    const secondRevisionDirectory = await makeTemporaryDirectory('ai-usage-session-freshness-second-');
    await fs.chmod(firstRevisionDirectory, 0o700);
    await fs.chmod(secondRevisionDirectory, 0o700);
    const storage = createLocalHistoryStorage(home);
    await Effect.runPromise(
      writeMachineConfig(FIXED_MACHINE).pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    const fixture = await seedHarnessHome(home, { harnesses: ['codex'] });
    const registry = await Effect.runPromise(
      createScheduledSourceRegistry({ codexLiveAvailable: () => false, machine: FIXED_MACHINE }).pipe(
        Effect.provideService(LocalHistoryStorage, storage),
      ),
    );
    const codexSource = registry.get('codex.sessions');
    if (!codexSource) {
      throw new Error('Missing fixture source codex.sessions');
    }

    await Effect.runPromise(codexSource.run(sourceContext));
    const firstCapture = await Effect.runPromise(
      createStoredReportCapture({
        generatedAt: GENERATED_AT,
        harness: null,
        includeCursor: false,
        options: { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
      }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    const firstPayload = firstCapture.payload;
    const firstPage = projectSessionPage(firstPayload.rows, request());
    const rootItem = firstPage.items.find((item) => item.row.source?.sourceSessionId === fixture.ids.codexRoot);
    if (!rootItem) {
      throw new Error('Missing Codex root row in the first published projection');
    }
    await materializeSessionQueryDatabase(
      firstRevisionDirectory,
      firstPayload.rows,
      undefined,
      firstCapture.rowSourceAuthorities,
    );
    const firstDatabase = new Database(path.join(firstRevisionDirectory, SESSION_QUERY_DATABASE_NAME), {
      readonly: true,
      strict: true,
    });
    const firstAnchorResult = executeMaterializedSessionQuery(firstDatabase, 'session-detail-anchor', {
      revision: request().revision,
      rowId: rootItem.row.rowId,
    });
    firstDatabase.close();
    if (!firstAnchorResult.anchor) {
      throw new Error('Missing Codex root anchor in the first report revision');
    }
    expect(firstAnchorResult.anchor.sourceAuthority).toBe('local-observed');

    const initialAnalysis = await Effect.runPromise(
      readCodexSessionAnalysis(fixture.ids.codexRoot).pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    if (!initialAnalysis) {
      throw new Error('Missing initial local Codex root analysis');
    }
    expect(compareSessionProjectionFacts(firstAnchorResult.anchor.projection, initialAnalysis.projection)).toEqual({
      checkedFields: ['calls', 'duration', 'model-attribution', 'coverage', 'tokens', 'tools', 'turns'],
      status: 'matches-report',
    });

    await appendCodexRootUsage(fixture);
    const mutatedAnalysis = await Effect.runPromise(
      readCodexSessionAnalysis(fixture.ids.codexRoot).pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    if (!mutatedAnalysis) {
      throw new Error('Missing mutated local Codex root analysis');
    }
    expect(compareSessionProjectionFacts(firstAnchorResult.anchor.projection, mutatedAnalysis.projection)).toEqual({
      checkedFields: ['calls', 'duration', 'model-attribution', 'coverage', 'tokens', 'tools', 'turns'],
      differingFields: ['duration', 'model-attribution', 'tokens'],
      status: 'differs-from-report',
    });

    await Effect.runPromise(codexSource.run(sourceContext));
    const secondCapture = await Effect.runPromise(
      createStoredReportCapture({
        generatedAt: GENERATED_AT,
        harness: null,
        includeCursor: false,
        options: { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
      }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    const secondPayload = secondCapture.payload;
    const secondPage = projectSessionPage(secondPayload.rows, request());
    const republishedRootItem = secondPage.items.find(
      (item) => item.row.source?.sourceSessionId === fixture.ids.codexRoot,
    );
    if (!republishedRootItem) {
      throw new Error('Missing Codex root row in the republished projection');
    }
    await materializeSessionQueryDatabase(
      secondRevisionDirectory,
      secondPayload.rows,
      undefined,
      secondCapture.rowSourceAuthorities,
    );
    const secondDatabase = new Database(path.join(secondRevisionDirectory, SESSION_QUERY_DATABASE_NAME), {
      readonly: true,
      strict: true,
    });
    const secondAnchorResult = executeMaterializedSessionQuery(secondDatabase, 'session-detail-anchor', {
      revision: request().revision,
      rowId: republishedRootItem.row.rowId,
    });
    secondDatabase.close();
    if (!secondAnchorResult.anchor) {
      throw new Error('Missing Codex root anchor in the republished revision');
    }
    expect(secondAnchorResult.anchor.sourceAuthority).toBe('local-observed');
    expect(compareSessionProjectionFacts(secondAnchorResult.anchor.projection, mutatedAnalysis.projection)).toEqual({
      checkedFields: ['calls', 'duration', 'model-attribution', 'coverage', 'tokens', 'tools', 'turns'],
      status: 'matches-report',
    });
  });

  test('keeps Claude match, exact divergence, and match tied to immutable report revisions', async () => {
    const home = await makeTemporaryDirectory('ai-usage-claude-vertical-home-');
    const firstRevisionDirectory = await makeTemporaryDirectory('ai-usage-claude-vertical-first-');
    const secondRevisionDirectory = await makeTemporaryDirectory('ai-usage-claude-vertical-second-');
    await fs.chmod(firstRevisionDirectory, 0o700);
    await fs.chmod(secondRevisionDirectory, 0o700);
    const storage = createLocalHistoryStorage(home);
    await Effect.runPromise(
      writeMachineConfig(FIXED_MACHINE).pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    const fixture = await seedHarnessHome(home, { harnesses: ['claude'] });
    const registry = await Effect.runPromise(
      createScheduledSourceRegistry({ codexLiveAvailable: () => false, machine: FIXED_MACHINE }).pipe(
        Effect.provideService(LocalHistoryStorage, storage),
      ),
    );
    const claudeSource = registry.get('claude.sessions');
    if (!claudeSource) {
      throw new Error('Missing fixture source claude.sessions');
    }

    const captureAnchor = async (revisionDirectory: string) => {
      const capture = await Effect.runPromise(
        createStoredReportCapture({
          generatedAt: GENERATED_AT,
          harness: 'claude',
          includeCursor: false,
          options: reportOptions,
        }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      const row = projectSessionPage(capture.payload.rows, request()).items.find(
        (item) => item.row.source?.sourceSessionId === fixture.ids.claude,
      )?.row;
      if (!row) {
        throw new Error('Missing Claude row in the published projection');
      }
      await materializeSessionQueryDatabase(
        revisionDirectory,
        capture.payload.rows,
        undefined,
        capture.rowSourceAuthorities,
      );
      const database = new Database(path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME), {
        readonly: true,
        strict: true,
      });
      try {
        const anchor = executeMaterializedSessionQuery(database, 'session-detail-anchor', {
          revision: request().revision,
          rowId: row.rowId,
        }).anchor;
        if (!anchor) {
          throw new Error('Missing Claude anchor in the published revision');
        }
        return anchor;
      } finally {
        database.close();
      }
    };
    const analyze = () =>
      Effect.runPromise(
        readClaudeSessionAnalysis(fixture.ids.claude).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );

    await Effect.runPromise(claudeSource.run(sourceContext));
    const firstAnchor = await captureAnchor(firstRevisionDirectory);
    const initialAnalysis = await analyze();
    if (!initialAnalysis) {
      throw new Error('Missing initial Claude analysis');
    }
    expect(firstAnchor.sourceAuthority).toBe('local-observed');
    expect(compareSessionProjectionFacts(firstAnchor.projection, initialAnalysis.projection)).toEqual({
      checkedFields: ['calls', 'duration', 'model-attribution', 'coverage', 'tokens', 'tools', 'turns'],
      status: 'matches-report',
    });

    await fs.appendFile(
      fixture.paths.claudeRootTranscript,
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-01T08:04:40.000Z',
        uuid: 'claude-assistant-after-published-revision',
        parentUuid: 'claude-user-2',
        requestId: 'claude-request-after-published-revision',
        message: {
          id: 'claude-message-after-published-revision',
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      })}\n`,
    );
    const changedAnalysis = await analyze();
    if (!changedAnalysis) {
      throw new Error('Missing changed Claude analysis');
    }
    expect(compareSessionProjectionFacts(firstAnchor.projection, changedAnalysis.projection)).toEqual({
      checkedFields: ['calls', 'duration', 'model-attribution', 'coverage', 'tokens', 'tools', 'turns'],
      differingFields: ['calls', 'model-attribution', 'tokens'],
      status: 'differs-from-report',
    });

    await Effect.runPromise(claudeSource.run(sourceContext));
    const secondAnchor = await captureAnchor(secondRevisionDirectory);
    expect(compareSessionProjectionFacts(secondAnchor.projection, changedAnalysis.projection)).toEqual({
      checkedFields: ['calls', 'duration', 'model-attribution', 'coverage', 'tokens', 'tools', 'turns'],
      status: 'matches-report',
    });
  });
});
