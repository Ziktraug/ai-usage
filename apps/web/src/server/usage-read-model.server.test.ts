import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import { importLocalRows, publishServedReportRevision, updateUsageMachineLabel } from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import { createSqliteUsageReadModel } from './usage-read-model.server';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
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
  generatedAt: '2026-07-30T08:00:00.000Z',
  omittedRows: 0,
});

const row = (name: string): SerializedRow => ({
  activeDate: '2026-07-30T08:01:00.000Z',
  calls: 1,
  costActual: 1,
  costApprox: 1,
  costKnown: true,
  costQuota: 0,
  date: '2026-07-30T08:00:00.000Z',
  durationMs: 1000,
  endDate: '2026-07-30T08:01:00.000Z',
  freshTokens: 10,
  harness: 'Codex',
  lineDelta: 1,
  linesAdded: 1,
  linesDeleted: 0,
  model: 'gpt-5',
  name,
  project: 'ai-usage',
  provider: 'OpenAI',
  sessionLabel: name,
  source: {
    harnessKey: 'codex',
    machineId: 'machine-a',
    machineLabel: 'Machine A',
    rootSourceSessionId: name,
    sourceSessionId: name,
    sourcePath: '/private/ai-usage',
  },
  tokCr: 0,
  tokCw: 0,
  tokIn: 10,
  tokOut: 0,
  tokenTotal: 10,
  tools: 0,
  turns: 1,
});

const publish = async (dbPath: string, revision: string, rows: readonly SerializedRow[], now: number) => {
  await Effect.runPromise(
    publishServedReportRevision({
      assemble: () => ({
        configFingerprint: 'c'.repeat(64),
        generatedAt: '2026-07-30T08:00:00.000Z',
        projectAliases: [],
        projectGroupConfigs: [],
        rows,
        sourceAuthorities: rows.map(() => 'local-observed' as const),
        support: support(rows.length),
      }),
      dbPath,
      now,
      revision,
      ttlMs: 100_000,
    }),
  );
};

const fixture = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'wave4-web-read-model-'));
  roots.push(root);
  const dbPath = path.join(root, 'usage.sqlite');
  await Effect.runPromise(
    updateUsageMachineLabel({
      dbPath,
      machine: { id: 'machine-a', label: 'Machine A' },
      updatedAt: new Date('2026-07-30T07:59:00.000Z'),
    }),
  );
  await Effect.runPromise(importLocalRows({ dbPath, machine: { id: 'machine-a', label: 'Machine A' }, rows: [] }));
  await publish(dbPath, 'revision-a', [row('A')], 1000);
  await publish(dbPath, 'revision-b', [row('B')], 2000);
  return dbPath;
};

describe('SQLite usage read model', () => {
  test('reads the current bootstrap and exact older revisions without an engine', async () => {
    const dbPath = await fixture();
    const readModel = createSqliteUsageReadModel({ dbPath, now: () => 3000 });

    const bootstrap = await readModel.readCurrentBootstrap();
    const localMachine = await readModel.readLocalMachine();
    const fleet = await readModel.readSyncFleet();
    const mergeBundle = await readModel.readLocalMergeBundle();
    const localProjects = await readModel.readCurrentLocalProjectSources();
    const supportA = await readModel.queryRevision({
      kind: 'support',
      request: { revision: 'revision-a' },
      revision: 'revision-a',
    });

    expect(bootstrap).toMatchObject({
      manifest: { revision: 'revision-b' },
      support: { revision: 'revision-b', support: { analytics: { sessionCount: 1 } } },
    });
    expect(supportA).toMatchObject({ revision: 'revision-a' });
    expect(fleet).toMatchObject({ currentMachine: { id: 'machine-a', label: 'Machine A' } });
    expect(localMachine).toEqual({ id: 'machine-a', label: 'Machine A' });
    expect(mergeBundle).toMatchObject({
      generatedAt: '1970-01-01T00:00:03.000Z',
      machine: { id: 'machine-a', label: 'Machine A' },
      rows: [],
    });
    expect(localProjects).toEqual({
      revision: 'revision-b',
      sources: [
        {
          label: 'ai-usage',
          machineId: 'machine-a',
          machineLabel: 'Machine A',
          project: 'ai-usage',
          sessions: 1,
          sourcePath: '/private/ai-usage',
        },
      ],
    });
  });

  test('keeps the current revision readable at and beyond its TTL without an engine', async () => {
    const dbPath = await fixture();
    const readModel = createSqliteUsageReadModel({ dbPath, now: () => 102_000 });

    const bootstrap = await readModel.readCurrentBootstrap();
    const currentSupport = await readModel.queryRevision({
      kind: 'support',
      request: { revision: 'revision-b' },
      revision: 'revision-b',
    });

    expect(bootstrap).toMatchObject({ manifest: { expiresAt: 102_000, revision: 'revision-b' } });
    expect(currentSupport).toMatchObject({ revision: 'revision-b' });
    await expect(
      readModel.queryRevision({
        kind: 'support',
        request: { revision: 'revision-a' },
        revision: 'revision-a',
      }),
    ).rejects.toMatchObject({ reason: 'revision-expired' });
  });

  test('does not create a missing store while reporting the typed reader failure', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wave4-web-read-model-missing-'));
    roots.push(root);
    const dbPath = path.join(root, 'missing', 'usage.sqlite');
    const readModel = createSqliteUsageReadModel({ dbPath });

    await expect(readModel.readCurrentBootstrap()).rejects.toMatchObject({ reason: 'store-missing' });
    await expect(Bun.file(dbPath).exists()).resolves.toBe(false);
  });
});
