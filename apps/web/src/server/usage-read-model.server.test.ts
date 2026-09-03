import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FIXTURE_SKILL_NAMES, FIXTURE_SKILL_ROOT } from '@ai-usage/local-machine/testing/harness-home';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import { completeSkillObservationCollection, type SkillObservation } from '@ai-usage/report-core/skill-observation';
import { SKILL_OBSERVATION_OBSERVABLE_HARNESS_KEYS } from '@ai-usage/report-core/skill-observation-evidence';
import {
  importLocalRows,
  importSkillObservations,
  publishServedReportRevision,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import { joinSkillObservations } from './skill-observation-join';
import { createLiveUsageReadModel, createSqliteUsageReadModel } from './usage-read-model.server';

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
  timeZone: 'UTC',
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

/**
 * The skill vocabulary of the shared synthetic home (`seedHarnessHome`), so this fixture and the
 * collectors that populate a real store name the same skills. `improve` is declared and resolved,
 * `artifact-design` is declared by Claude Code and resolves to nothing (a harness-bundled skill),
 * and Codex contributes an `exposed` catalogue entry plus an `inferred` read of the same skill.
 */
const skillObservation = (
  overrides: Pick<SkillObservation, 'harnessKey' | 'observationKey' | 'skillName' | 'tier'> & Partial<SkillObservation>,
): SkillObservation => ({
  argsPresent: null,
  observedAt: '2026-08-01T09:00:00.000Z',
  projectPath: '/home/alex/Projects/report',
  resolvedPath: null,
  sessionId: 'session-1',
  success: null,
  ...overrides,
});

const seededHomeObservations: readonly SkillObservation[] = [
  skillObservation({
    argsPresent: true,
    harnessKey: 'claude',
    observationKey: 'toolu_managed',
    resolvedPath: `${FIXTURE_SKILL_ROOT}/${FIXTURE_SKILL_NAMES.claudeDeclared}`,
    skillName: FIXTURE_SKILL_NAMES.claudeDeclared,
    success: true,
    tier: 'declared',
  }),
  skillObservation({
    harnessKey: 'claude',
    observationKey: 'toolu_bundled',
    observedAt: '2026-08-01T09:05:00.000Z',
    skillName: FIXTURE_SKILL_NAMES.claudeUnresolved,
    tier: 'declared',
  }),
  skillObservation({
    harnessKey: 'opencode',
    observationKey: 'call_resolved',
    observedAt: '2026-08-02T09:00:00.000Z',
    skillName: FIXTURE_SKILL_NAMES.openCodeDeclared,
    tier: 'declared',
  }),
  skillObservation({
    harnessKey: 'codex',
    observationKey: 'catalogue-pr-review',
    observedAt: '2026-08-03T09:00:00.000Z',
    skillName: FIXTURE_SKILL_NAMES.codexExposed,
    tier: 'exposed',
  }),
  skillObservation({
    harnessKey: 'codex',
    observationKey: 'catalogue-imagegen',
    observedAt: '2026-08-03T09:00:00.000Z',
    skillName: FIXTURE_SKILL_NAMES.codexUnread,
    tier: 'exposed',
  }),
  skillObservation({
    harnessKey: 'codex',
    observationKey: 'exec-pr-review',
    observedAt: '2026-08-03T09:01:00.000Z',
    skillName: FIXTURE_SKILL_NAMES.codexExposed,
    tier: 'inferred',
  }),
];

const storeWithSeededHomeObservations = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'plan111-web-skill-observations-'));
  roots.push(root);
  const dbPath = path.join(root, 'usage.sqlite');
  for (const harnessKey of [...new Set(seededHomeObservations.map((observation) => observation.harnessKey))]) {
    await Effect.runPromise(
      importSkillObservations({
        collection: { completeness: completeSkillObservationCollection(), harnessKey },
        dbPath,
        machineId: 'machine-a',
        observations: seededHomeObservations.filter((observation) => observation.harnessKey === harnessKey),
      }),
    );
  }
  return dbPath;
};

describe('SQLite usage read model skill observations', () => {
  test('keeps absence verdicts provisional until every expected producer completed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plan111-web-partial-producer-roster-'));
    roots.push(root);
    const dbPath = path.join(root, 'usage.sqlite');
    await Effect.runPromise(importLocalRows({ dbPath, machine: { id: 'machine-a', label: 'Machine A' }, rows: [] }));
    await Effect.runPromise(
      importSkillObservations({
        collection: { completeness: completeSkillObservationCollection(), harnessKey: 'claude' },
        dbPath,
        machineId: 'machine-a',
        observations: [],
      }),
    );
    const readModel = createSqliteUsageReadModel({ dbPath });
    const scope = {
      expectedProducerHarnessKeys: SKILL_OBSERVATION_OBSERVABLE_HARNESS_KEYS,
      machineId: 'machine-a',
      minimumProducerCollectedAt: '2026-08-01T09:56:00.000Z',
    } as const;

    const partial = await readModel.readSkillObservations(scope);
    const partialPresentation = joinSkillObservations({
      observations: partial,
      projections: [{ skillName: 'unused', state: 'linked', targetId: 'claude' }],
      skills: [{ enabled: true, name: 'unused', validationStatus: 'valid' }],
      targets: [{ enabled: true, id: 'claude' }],
    });

    expect(partial).toMatchObject({
      invocationLowerBound: true,
      lowerBound: true,
      producerCompletenessMissing: true,
      producerProofValidUntil: '2026-08-01T10:01:00.000Z',
    });
    expect(partialPresentation.skills[0]).toMatchObject({
      deletionCandidate: true,
      verdict: 'never-observed',
      verdictProvisional: true,
    });

    for (const harnessKey of ['codex', 'opencode'] as const) {
      await Effect.runPromise(
        importSkillObservations({
          collection: { completeness: completeSkillObservationCollection(), harnessKey },
          dbPath,
          machineId: 'machine-a',
          observations: [],
        }),
      );
    }
    const complete = await readModel.readSkillObservations(scope);
    const completePresentation = joinSkillObservations({
      observations: complete,
      projections: [{ skillName: 'unused', state: 'linked', targetId: 'claude' }],
      skills: [{ enabled: true, name: 'unused', validationStatus: 'valid' }],
      targets: [{ enabled: true, id: 'claude' }],
    });

    expect(complete).toMatchObject({
      invocationLowerBound: false,
      lowerBound: false,
      producerCompletenessMissing: false,
      producerProofValidUntil: '2026-08-01T10:01:00.000Z',
    });
    expect(completePresentation.skills[0]?.verdictProvisional).toBe(false);
  });

  test('reads every tier and keeps Cursor not observable rather than zero', async () => {
    const dbPath = await storeWithSeededHomeObservations();

    const dataset = await createSqliteUsageReadModel({ dbPath }).readSkillObservations();

    expect(dataset.harnesses).toEqual([
      { harnessKey: 'claude', label: 'Claude Code', observability: 'observable' },
      { harnessKey: 'codex', label: 'Codex', observability: 'observable' },
      { harnessKey: 'opencode', label: 'OpenCode', observability: 'observable' },
      { harnessKey: 'cursor', label: 'Cursor', observability: 'not-observable' },
    ]);
    expect(dataset.lowerBound).toBe(false);
    expect(dataset.skipped).toBe(0);
    expect(
      dataset.skills.flatMap(({ skillName, tallies }) =>
        tallies.map(({ count, harnessKey, tier }) => `${skillName} ${harnessKey} ${tier} ${count}`),
      ),
    ).toEqual([
      `${FIXTURE_SKILL_NAMES.claudeUnresolved} claude declared 1`,
      `${FIXTURE_SKILL_NAMES.codexUnread} codex exposed 1`,
      `${FIXTURE_SKILL_NAMES.claudeDeclared} claude declared 1`,
      `${FIXTURE_SKILL_NAMES.codexExposed} codex inferred 1`,
      `${FIXTURE_SKILL_NAMES.codexExposed} codex exposed 1`,
      `${FIXTURE_SKILL_NAMES.openCodeDeclared} opencode declared 1`,
    ]);
  });

  test('retains an observation that resolves to nothing instead of dropping it', async () => {
    const dbPath = await storeWithSeededHomeObservations();

    const dataset = await createSqliteUsageReadModel({ dbPath }).readSkillObservations();
    const bundled = dataset.skills.find(({ skillName }) => skillName === FIXTURE_SKILL_NAMES.claudeUnresolved);
    const managed = dataset.skills.find(({ skillName }) => skillName === FIXTURE_SKILL_NAMES.claudeDeclared);

    expect(bundled?.resolvedPaths).toEqual([]);
    expect(bundled?.tallies).toHaveLength(1);
    expect(managed?.resolvedPaths).toEqual([`${FIXTURE_SKILL_ROOT}/${FIXTURE_SKILL_NAMES.claudeDeclared}`]);
  });

  test('answers without a published report revision, so it cannot expire with one', async () => {
    const dbPath = await storeWithSeededHomeObservations();
    const readModel = createSqliteUsageReadModel({ dbPath, now: () => 10_000_000 });

    // The same store, at the same instant: no revision exists to read, and the observation read is
    // unaffected by that. This is the property that keeps `/skills` answerable before any report
    // publication and after every revision has expired.
    await expect(readModel.readCurrentBootstrap()).rejects.toMatchObject({ reason: 'revision-unavailable' });
    await expect(readModel.readSkillObservations()).resolves.toMatchObject({ lowerBound: false });
    expect((await readModel.readSkillObservations()).skills).toHaveLength(5);
  });

  test('the live read model reads the same store the runtime paths resolve', async () => {
    const dbPath = await storeWithSeededHomeObservations();
    const previous = process.env.AI_USAGE_DATABASE_PATH;
    process.env.AI_USAGE_DATABASE_PATH = dbPath;
    try {
      const dataset = await createLiveUsageReadModel().readSkillObservations();
      expect(dataset.skills.map(({ skillName }) => skillName)).toEqual(
        [...new Set(seededHomeObservations.map(({ skillName }) => skillName))].sort((left, right) =>
          left.localeCompare(right),
        ),
      );
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, 'AI_USAGE_DATABASE_PATH');
      } else {
        process.env.AI_USAGE_DATABASE_PATH = previous;
      }
    }
  });

  test('does not create a missing store to answer an observation read', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plan111-web-skill-observations-missing-'));
    roots.push(root);
    const dbPath = path.join(root, 'missing', 'usage.sqlite');

    await expect(createSqliteUsageReadModel({ dbPath }).readSkillObservations()).rejects.toMatchObject({
      reason: 'store-missing',
    });
    await expect(Bun.file(dbPath).exists()).resolves.toBe(false);
  });
});

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

  test('rejects an aborted read before opening the local store', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wave4-web-read-model-aborted-'));
    roots.push(root);
    const dbPath = path.join(root, 'missing', 'usage.sqlite');
    const readModel = createSqliteUsageReadModel({ dbPath });
    const controller = new AbortController();
    controller.abort();

    await expect(readModel.readCurrentBootstrap({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(Bun.file(dbPath).exists()).resolves.toBe(false);
  });
});
