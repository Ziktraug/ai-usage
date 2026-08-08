#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import type { SessionPageResult, SessionQueryRequest } from '@ai-usage/report-core/session-query';
import {
  readSessionQueryPerformanceCapture,
  resetSessionQueryPerformanceCapture,
  resetSessionQueryTotalsCacheForTests,
  type SessionQueryPerfSnapshot,
} from '@ai-usage/usage-store/performance-testing';
import {
  assertSessionQueryDatabase,
  createServedRevisionQueryDatabase,
  executeMaterializedSessionQuery,
  publishServedReportRevision,
  type SessionQuerySqliteDatabase,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_OUTPUT = path.join(ROOT, 'docs/performance/artifacts/plan072-keyset-a1.json');
const FIXTURE_SIZES = [5000, 20_000] as const;
const PAGE_SIZE = 200;
const RECORDED_SAMPLE_COUNT = 3;
const REVISION_A = 'plan072-revision-a';
const REVISION_B = 'plan072-revision-b';

type FixtureSize = (typeof FIXTURE_SIZES)[number];

interface BenchmarkDatabase extends SessionQuerySqliteDatabase {
  close(): void;
}

interface TraversalMeasurement {
  readonly duplicateIdentityCount: number;
  readonly firstIdentity: string | null;
  readonly lastIdentity: string | null;
  readonly missingIdentityCount: number;
  readonly pageCount: number;
  readonly serializationMs: number;
  readonly sqlite: SessionQueryPerfSnapshot;
  readonly totalMs: number;
  readonly transferBytes: number;
  readonly uniqueIdentityCount: number;
}

interface ScenarioDefinition {
  readonly label: string;
  readonly request: Omit<SessionQueryRequest, 'cursor' | 'revision'>;
}

interface ScenarioMeasurement {
  readonly fixtureSize: FixtureSize;
  readonly label: string;
  readonly median: TraversalMeasurement;
  readonly samples: readonly TraversalMeasurement[];
}

export interface ProbeOutput {
  readonly configuration: {
    readonly fixtureSizes: readonly FixtureSize[];
    readonly pageSize: number;
    readonly recordedSampleCount: number;
    readonly warmupCount: number;
  };
  readonly decision: {
    readonly keysetRejected: boolean;
    readonly reason: string;
    readonly sliceGrowthRatio: number;
    readonly sliceShareAtFiveThousand: number;
    readonly sliceShareAtTwentyThousand: number;
    readonly superlinearGrowthObserved: boolean;
  };
  readonly revisionTransition: {
    readonly firstRevisionProjectionMisses: number;
    readonly identitiesOverlap: number;
    readonly secondRevisionProjectionMisses: number;
  };
  readonly scenarios: readonly ScenarioMeasurement[];
  readonly tool: 'plan072-keyset-a1';
  readonly version: 2;
}

const baseFilters = (): SessionQueryRequest['filters'] => ({
  fields: {},
  harness: [],
  machine: [],
  origin: [],
  query: '',
});

const requestFor = (
  sort: SessionQueryRequest['sort'],
  filters: SessionQueryRequest['filters'] = baseFilters(),
): Omit<SessionQueryRequest, 'cursor' | 'revision'> => ({
  filters,
  pageSize: PAGE_SIZE,
  range: { from: null, to: null },
  sort,
});

const SCENARIOS: readonly ScenarioDefinition[] = [
  { label: 'date-desc', request: requestFor([{ desc: true, id: 'date' }]) },
  { label: 'date-asc', request: requestFor([{ desc: false, id: 'date' }]) },
  { label: 'project-rank-ties', request: requestFor([{ desc: false, id: 'project' }]) },
  {
    label: 'zero-matches',
    request: requestFor([{ desc: true, id: 'date' }], { ...baseFilters(), query: 'no-such-plan072-session' }),
  },
  {
    label: 'harness-codex',
    request: requestFor([{ desc: true, id: 'date' }], { ...baseFilters(), harness: ['Codex'] }),
  },
  {
    label: 'origin-classifier',
    request: requestFor([{ desc: true, id: 'date' }], { ...baseFilters(), origin: ['classifier'] }),
  },
];

const supportFor = (sessionCount: number): FocusedReportSupport => ({
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
    pricedCount: sessionCount,
    recentSessions: sessionCount,
    sessionCount,
    tools: 0,
    totalCost: sessionCount,
    turns: sessionCount,
    unpricedCount: 0,
  },
  filters: { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
  generatedAt: '2026-08-01T00:00:00.000Z',
  omittedRows: 0,
  timeZone: 'UTC',
});

const fixtureRow = (index: number, revision: string): SerializedRow => {
  const sourceSessionId = `${revision}-session-${index}`;
  const classifier = index % 4 === 3;
  const rootIndex = classifier ? index - 1 : index;
  const rootSourceSessionId = `${revision}-session-${rootIndex}`;
  const harness = rootIndex % 5 === 0 ? 'Codex' : 'Claude Code';
  const harnessKey = rootIndex % 5 === 0 ? 'codex' : 'claude';
  const date = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
  const tokenUnit = (index % 1000) + 1;
  return {
    activeDate: date,
    calls: tokenUnit,
    costActual: tokenUnit / 100,
    costApprox: tokenUnit / 100,
    costKnown: true,
    costQuota: tokenUnit / 100,
    date,
    durationMs: tokenUnit * 10,
    endDate: date,
    freshTokens: tokenUnit * 3,
    harness,
    lineDelta: 1,
    linesAdded: 1,
    linesDeleted: 0,
    model: index % 2 === 0 ? 'gpt-5.4' : 'claude-opus-4-6',
    name: sourceSessionId,
    origin: classifier ? 'classifier' : 'human',
    partial: false,
    project: `project-${index % 40}`,
    provider: index % 2 === 0 ? 'Codex API' : 'Anthropic',
    rtkCommandCount: 0,
    rtkInputTokens: 0,
    rtkOutputTokens: 0,
    rtkSavedTokens: 0,
    sessionLabel: sourceSessionId,
    source: {
      harnessKey,
      machineId: 'plan072-machine',
      machineLabel: 'Plan 072 machine',
      ...(classifier ? { parentSourceSessionId: rootSourceSessionId } : {}),
      rootSourceSessionId,
      sourceSessionId,
    },
    subagent: classifier,
    tokCr: 0,
    tokCw: tokenUnit,
    tokIn: tokenUnit,
    tokOut: tokenUnit,
    tokenTotal: tokenUnit * 3,
    tools: tokenUnit,
    turns: tokenUnit,
  };
};

const publishFixture = async (dbPath: string, size: FixtureSize, revision: string): Promise<void> => {
  const rows = Array.from({ length: size }, (_, index) => fixtureRow(index, revision));
  await Effect.runPromise(
    publishServedReportRevision({
      assemble: () => ({
        configFingerprint: revision === REVISION_A ? 'a'.repeat(64) : 'b'.repeat(64),
        generatedAt: '2026-08-01T00:00:00.000Z',
        projectAliases: [],
        projectGroupConfigs: [],
        rows,
        sourceAuthorities: rows.map(() => 'local-observed' as const),
        support: supportFor(rows.length),
      }),
      dbPath,
      now: revision === REVISION_A ? 1000 : 2000,
      revision,
      ttlMs: 600_000,
    }),
  );
};

const openDatabase = (dbPath: string, revision: string): BenchmarkDatabase => {
  const rawDatabase = new Database(dbPath, { readonly: true, strict: true });
  const scopedDatabase = createServedRevisionQueryDatabase(rawDatabase, revision);
  const database: BenchmarkDatabase = {
    close: () => rawDatabase.close(),
    query: (sql) => scopedDatabase.query(sql),
  };
  assertSessionQueryDatabase(database);
  return database;
};

const traverse = (open: () => BenchmarkDatabase, definition: ScenarioDefinition, revision: string) => {
  resetSessionQueryPerformanceCapture();
  resetSessionQueryTotalsCacheForTests();
  let cursor: string | null = null;
  let pageCount = 0;
  let serializationMs = 0;
  let transferBytes = 0;
  let expectedIdentityCount: number | undefined;
  const identities: string[] = [];
  const startedAt = performance.now();
  do {
    const database = open();
    let result: SessionPageResult;
    try {
      result = executeMaterializedSessionQuery(database, 'sessions', {
        ...definition.request,
        cursor,
        revision,
      });
    } finally {
      database.close();
    }
    const serializationStartedAt = performance.now();
    const serialized = JSON.stringify(result);
    serializationMs += performance.now() - serializationStartedAt;
    transferBytes += Buffer.byteLength(serialized);
    expectedIdentityCount ??= result.itemCount;
    for (const item of result.items) {
      identities.push(item.row.rowId);
    }
    cursor = result.nextCursor;
    pageCount += 1;
  } while (cursor !== null);
  const totalMs = performance.now() - startedAt;
  const uniqueIdentities = new Set(identities);
  return {
    duplicateIdentityCount: identities.length - uniqueIdentities.size,
    firstIdentity: identities[0] ?? null,
    lastIdentity: identities.at(-1) ?? null,
    missingIdentityCount: Math.max(0, (expectedIdentityCount ?? 0) - uniqueIdentities.size),
    pageCount,
    serializationMs: Number(serializationMs.toFixed(3)),
    sqlite: readSessionQueryPerformanceCapture(),
    totalMs: Number(totalMs.toFixed(3)),
    transferBytes,
    uniqueIdentityCount: uniqueIdentities.size,
  } satisfies TraversalMeasurement;
};

const medianNumber = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const medianMeasurement = (samples: readonly TraversalMeasurement[]): TraversalMeasurement => {
  const middle = [...samples].sort((left, right) => left.totalMs - right.totalMs)[Math.floor(samples.length / 2)];
  if (!middle) {
    throw new Error('At least one traversal sample is required');
  }
  return {
    ...middle,
    serializationMs: medianNumber(samples.map((sample) => sample.serializationMs)),
    totalMs: medianNumber(samples.map((sample) => sample.totalMs)),
    transferBytes: medianNumber(samples.map((sample) => sample.transferBytes)),
  };
};

const sliceShare = (measurement: TraversalMeasurement): number => {
  const phases = measurement.sqlite.phases;
  const residual = Object.values(phases).reduce((total, phase) => total + phase.totalMs, 0);
  return residual === 0 ? 0 : phases.slice.totalMs / residual;
};

const measureScenario = (
  dbPath: string,
  fixtureSize: FixtureSize,
  definition: ScenarioDefinition,
): ScenarioMeasurement => {
  const open = () => openDatabase(dbPath, REVISION_A);
  traverse(open, definition, REVISION_A);
  const samples = Array.from({ length: RECORDED_SAMPLE_COUNT }, () => traverse(open, definition, REVISION_A));
  return { fixtureSize, label: definition.label, median: medianMeasurement(samples), samples };
};

const measureRevisionTransition = (dbPath: string) => {
  const definition = SCENARIOS[0];
  if (!definition) {
    throw new Error('Expected a date-desc scenario');
  }
  const first = traverse(() => openDatabase(dbPath, REVISION_A), definition, REVISION_A);
  const second = traverse(() => openDatabase(dbPath, REVISION_B), definition, REVISION_B);
  const firstIds = new Set([first.firstIdentity, first.lastIdentity].filter((identity) => identity !== null));
  const secondIds = new Set([second.firstIdentity, second.lastIdentity].filter((identity) => identity !== null));
  let identitiesOverlap = 0;
  for (const identity of firstIds) {
    if (secondIds.has(identity)) {
      identitiesOverlap += 1;
    }
  }
  return {
    firstRevisionProjectionMisses: first.sqlite.counters.projectionCacheMisses,
    identitiesOverlap,
    secondRevisionProjectionMisses: second.sqlite.counters.projectionCacheMisses,
  };
};

export const runProbe = async (outputPath = DEFAULT_OUTPUT): Promise<ProbeOutput> => {
  const previousPerfFlag = process.env.AI_USAGE_PERF;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-plan072-a1-'));
  process.env.AI_USAGE_PERF = '1';
  try {
    const scenarios: ScenarioMeasurement[] = [];
    let revisionTransition: ProbeOutput['revisionTransition'] | undefined;
    for (const fixtureSize of FIXTURE_SIZES) {
      const dbPath = path.join(temporaryDirectory, `usage-${fixtureSize}.sqlite`);
      await Effect.runPromise(
        updateUsageMachineLabel({
          dbPath,
          machine: { id: 'plan072-machine', label: 'Plan 072 machine' },
          updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        }),
      );
      await publishFixture(dbPath, fixtureSize, REVISION_A);
      if (fixtureSize === 5000) {
        await publishFixture(dbPath, fixtureSize, REVISION_B);
        revisionTransition = measureRevisionTransition(dbPath);
      }
      for (const definition of SCENARIOS) {
        scenarios.push(measureScenario(dbPath, fixtureSize, definition));
      }
    }
    if (!revisionTransition) {
      throw new Error('The 5,000-row revision transition was not measured');
    }
    const dateFiveThousand = scenarios.find(
      (scenario) => scenario.fixtureSize === 5000 && scenario.label === 'date-desc',
    );
    const dateTwentyThousand = scenarios.find(
      (scenario) => scenario.fixtureSize === 20_000 && scenario.label === 'date-desc',
    );
    if (!(dateFiveThousand && dateTwentyThousand)) {
      throw new Error('Both date-desc fixture sizes must be measured');
    }
    const shareAtFiveThousand = sliceShare(dateFiveThousand.median);
    const shareAtTwentyThousand = sliceShare(dateTwentyThousand.median);
    const sliceAtFiveThousand = dateFiveThousand.median.sqlite.phases.slice.totalMs;
    const sliceAtTwentyThousand = dateTwentyThousand.median.sqlite.phases.slice.totalMs;
    const sliceGrowthRatio = sliceAtFiveThousand === 0 ? 0 : sliceAtTwentyThousand / sliceAtFiveThousand;
    const superlinearGrowthObserved = sliceGrowthRatio > 4.4;
    const keysetRejected = shareAtFiveThousand < 0.1 && !superlinearGrowthObserved;
    const output: ProbeOutput = {
      configuration: {
        fixtureSizes: FIXTURE_SIZES,
        pageSize: PAGE_SIZE,
        recordedSampleCount: RECORDED_SAMPLE_COUNT,
        warmupCount: 1,
      },
      decision: {
        keysetRejected,
        reason: keysetRejected
          ? 'STOP A1: JavaScript projection slicing is below 10% of residual SQLite cost at 5k and 20k does not grow superlinearly.'
          : 'STOP A1 did not apply; a cursor prototype would require an ADR before implementation.',
        sliceGrowthRatio,
        sliceShareAtFiveThousand: shareAtFiveThousand,
        sliceShareAtTwentyThousand: shareAtTwentyThousand,
        superlinearGrowthObserved,
      },
      revisionTransition,
      scenarios,
      tool: 'plan072-keyset-a1',
      version: 2,
    };
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    return output;
  } finally {
    resetSessionQueryPerformanceCapture();
    resetSessionQueryTotalsCacheForTests();
    if (previousPerfFlag === undefined) {
      delete process.env.AI_USAGE_PERF;
    } else {
      process.env.AI_USAGE_PERF = previousPerfFlag;
    }
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
};

if (import.meta.main) {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: benchmark-only output override
  const output = await runProbe(process.env.AI_USAGE_PLAN072_OUTPUT ?? DEFAULT_OUTPUT);
  process.stdout.write(`${output.decision.reason}\n`);
}
