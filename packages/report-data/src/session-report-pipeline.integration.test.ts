import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCodexSessionAnalysis } from '@ai-usage/local-collectors/codex-history';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-collectors/local-history';
import { writeMachineConfig } from '@ai-usage/local-collectors/machine-config';
import {
  appendCodexRootUsage,
  HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL,
  seedHarnessHome,
} from '@ai-usage/local-collectors/test-fixtures/harness-home';
import { compareSessionProjectionFacts } from '@ai-usage/report-core/session-detail';
import { projectSessionPage, type SessionQueryRequest } from '@ai-usage/report-core/session-query';
import type { CollectedUsageRow } from '@ai-usage/report-core/types';
import { queryReportRows, usageStorePath } from '@ai-usage/usage-store';
import { Effect } from 'effect';
import { createStoredReportPayload } from './index';
import { materializeSessionQueryDatabase, SESSION_QUERY_DATABASE_NAME } from './session-query-materialization';
import { assertSessionQueryDatabase, executeMaterializedSessionQuery } from './session-query-sqlite';
import { createScheduledSourceRegistry, type SourceRunContext } from './source-adapters';

const FIXED_MACHINE = { id: 'machine-fixture-025', label: 'Fixture machine' } as const;
const GENERATED_AT = new Date('2026-07-10T12:00:00.000Z');
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

describe('session report pipeline', () => {
  test('keeps literal multi-harness facts through source, store, payload, and materialized SQLite', async () => {
    const home = await makeTemporaryDirectory('ai-usage-session-pipeline-home-');
    const revisionDirectory = await makeTemporaryDirectory('ai-usage-session-pipeline-revision-');
    await fs.chmod(revisionDirectory, 0o700);
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
    const payload = await Effect.runPromise(
      createStoredReportPayload({
        generatedAt: GENERATED_AT,
        harness: null,
        includeCursor: true,
        options: { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
      }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    await materializeSessionQueryDatabase(revisionDirectory, payload.rows);
    const database = new Database(path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME), {
      readonly: true,
      strict: true,
    });
    try {
      assertSessionQueryDatabase(database);
      expect(executeMaterializedSessionQuery(database, 'sessions', request())).toEqual(
        projectSessionPage(payload.rows, request()),
      );

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
            calls: 2,
            costActual: 0,
            costKnown: true,
            date: '2026-07-01T08:00:00.000Z',
            durationMs: 240_000,
            endDate: '2026-07-01T08:04:00.000Z',
            modelSegments: [
              { costKnown: true, model: 'claude-sonnet-4-6', tokCr: 30, tokCw: 10, tokIn: 100, tokOut: 20 },
              { costKnown: true, model: 'claude-opus-4-1', tokCr: 5, tokCw: 2, tokIn: 40, tokOut: 15 },
            ],
            models: ['claude-sonnet-4-6', 'claude-opus-4-1'],
            parentSourceSessionId: null,
            partial: false,
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

      const serializedPayload = JSON.stringify(payload);
      expect(serializedPayload).not.toContain(HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL);
      const sourceRows = database
        .query<{ source_row_json: string }, []>('SELECT source_row_json FROM session_rows')
        .all();
      expect(JSON.stringify(sourceRows)).not.toContain(HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL);
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
    const firstPayload = await Effect.runPromise(
      createStoredReportPayload({
        generatedAt: GENERATED_AT,
        harness: null,
        includeCursor: false,
        options: { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
      }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    const firstPage = projectSessionPage(firstPayload.rows, request());
    const rootItem = firstPage.items.find((item) => item.row.source?.sourceSessionId === fixture.ids.codexRoot);
    if (!rootItem) {
      throw new Error('Missing Codex root row in the first published projection');
    }
    await materializeSessionQueryDatabase(firstRevisionDirectory, firstPayload.rows);
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
    const secondPayload = await Effect.runPromise(
      createStoredReportPayload({
        generatedAt: GENERATED_AT,
        harness: null,
        includeCursor: false,
        options: { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
      }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    const secondPage = projectSessionPage(secondPayload.rows, request());
    const republishedRootItem = secondPage.items.find(
      (item) => item.row.source?.sourceSessionId === fixture.ids.codexRoot,
    );
    if (!republishedRootItem) {
      throw new Error('Missing Codex root row in the republished projection');
    }
    await materializeSessionQueryDatabase(secondRevisionDirectory, secondPayload.rows);
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
    expect(compareSessionProjectionFacts(secondAnchorResult.anchor.projection, mutatedAnalysis.projection)).toEqual({
      checkedFields: ['calls', 'duration', 'model-attribution', 'coverage', 'tokens', 'tools', 'turns'],
      status: 'matches-report',
    });
  });
});
