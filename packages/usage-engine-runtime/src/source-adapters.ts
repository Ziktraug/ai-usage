import path from 'node:path';
import { createClaudeAgentSdkBatchSource, normalizeCursorCommitAttributionItems } from '@ai-usage/local-collectors';
import { observeCheckoutStatus } from '@ai-usage/local-collectors/checkout-status';
import { collectClaudeDesktopSessions } from '@ai-usage/local-collectors/claude-desktop-sessions';
import {
  collectClaudeRetentionWarnings,
  type HarnessAdapter,
  selectedHarnessAdapters,
} from '@ai-usage/local-collectors/collectors';
import { type BoundedRun, observeExecutors } from '@ai-usage/local-collectors/executor-observations';
import { collectCursorCommitAttributionResult } from '@ai-usage/local-collectors/facets';
import {
  GITHUB_PULL_REQUEST_DEFAULTS,
  observePullRequests,
  type PullRequestLink,
} from '@ai-usage/local-collectors/github-pull-requests';
import {
  JIRA_ISSUE_DEFAULTS,
  JIRA_NOT_INSTALLED_MESSAGE,
  observeJiraIssues,
} from '@ai-usage/local-collectors/jira-issues';
import {
  type CollectorRow,
  enrichCollectorRowsWithRtkSavingsResult,
  stripProjectPath,
} from '@ai-usage/local-collectors/rtk-enrichment';
import type { BoundedProcessRunner } from '@ai-usage/local-machine/bounded-process';
import type { LocalHistoryError } from '@ai-usage/local-machine/errors';
import {
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-machine/local-history';
import { ensureMachineConfig, readMergedAiUsageConfigFrom } from '@ai-usage/local-machine/machine-config';
import { firstExisting, resolvePathCandidates } from '@ai-usage/local-machine/platform-paths';
import type { AiUsageGitHubConfig } from '@ai-usage/report-core/project-alias';
import { projectSourcePathFromId } from '@ai-usage/report-core/project-group';
import {
  MAX_SKILL_OBSERVATION_BATCH,
  parseSkillObservation,
  SKILL_OBSERVATION_EXPOSURE_RETENTION_MS,
  type SkillObservation,
  type SkillObservationCollectionCompleteness,
} from '@ai-usage/report-core/skill-observation';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type {
  CollectionSourceId,
  SourceDetectionResult,
  SourceProgress,
  SourceRunResult,
} from '@ai-usage/report-core/source-control';
import {
  collectionSourceDefinitions,
  getCollectionSourceDefinition,
  sourceControlBounds,
} from '@ai-usage/report-core/source-control';
import type { PullRequestObservation } from '@ai-usage/report-core/work-attention';
import { explicitJiraKeys } from '@ai-usage/report-core/work-attention-facts';
import {
  importCheckoutStatusObservations,
  importClaudeDesktopSessions,
  importExecutorObservations,
  importJiraIssueObservations,
  importLocalRows,
  importNormalizedDatasetItems,
  importPullRequestObservations,
  importSkillObservations,
  MAX_CLAUDE_DESKTOP_SESSION_READ,
  queryClaudeDesktopSessions,
  queryCurrentServedLocalProjectSources,
  queryEnrichableUsageRows,
  queryServedSessionPullRequestLinks,
  queryUsageStoreGeneration,
  type RtkSavingsContribution,
  recordWorkFactRun,
  type ServedLocalProjectSource,
  type UsageStoreError,
  upsertRtkSavingsContributions,
  usageStorePath,
  type WorkFactSourceId,
} from '@ai-usage/usage-store/writer';
import { Data, Duration, Effect, Exit } from 'effect';
import { listManagedCursorUsageExportPaths } from './input-file';
import type { ProviderQuotaRuntimeOptions } from './provider-quota';
import { refreshLocalProviderQuotas } from './provider-quota';
import { CLAUDE_QUOTA_SOURCE_IDENTITY } from './provider-quota-refresh';
import { type SanitizableSourceWarning, sanitizeSourceWarnings } from './source-warnings';

export interface SourceRunContext {
  readonly reportProgress: (progress: SourceProgress) => Effect.Effect<void>;
  readonly signal?: AbortSignal;
}

export interface ScheduledSource {
  readonly cadence: Duration.Duration;
  readonly detect: Effect.Effect<SourceDetectionResult>;
  readonly id: CollectionSourceId;
  readonly run: (context: SourceRunContext) => Effect.Effect<SourceRunResult, SourceRunError>;
}

export class SourceRunError extends Data.TaggedError('SourceRunError')<{
  readonly cause: unknown;
  readonly message: string;
  readonly sourceId: CollectionSourceId;
}> {}

/**
 * Seams for the Work view's fact producers (ADR 0051). The served local Project sources and the
 * pull requests local Sessions recorded are always consulted; these add candidates from inputs
 * this package does not read itself (Claude Desktop session metadata, for one).
 */
export interface WorkFactInputs {
  /** Extra absolute checkout paths to observe beside the served local Project sources. */
  readonly candidateCheckoutPaths?: () => Effect.Effect<readonly string[]>;
  /** Extra explicitly linked pull requests beside those local Sessions recorded. */
  readonly linkedPullRequests?: () => Effect.Effect<readonly PullRequestLink[]>;
}

export interface SourceAdapterOptions {
  /** Defaults to `acli` being on PATH; the Jira issue source is not detected without it. */
  readonly acliAvailable?: () => boolean;
  readonly claudeLiveAvailable?: () => boolean;
  readonly codexLiveAvailable?: () => boolean;
  readonly configCwd?: string;
  readonly dbPath?: string;
  /** Seams for the executor capabilities source: binary lookup and bounded process execution. */
  readonly executorObservation?: {
    readonly run?: BoundedRun;
    readonly which?: (command: string) => string | null;
  };
  /** Defaults to `gh` being on PATH; the pull request source is not detected without it. */
  readonly ghAvailable?: () => boolean;
  /** Defaults to `git` being on PATH; the checkout status source is not detected without it. */
  readonly gitAvailable?: () => boolean;
  readonly machine?: UsageMachine;
  readonly now?: () => Date;
  readonly providerQuotaOptions?: ProviderQuotaRuntimeOptions;
  readonly workFactInputs?: WorkFactInputs;
  /** The bounded runner for `git` and `gh`; tests inject a fake. */
  readonly workFactProcessRunner?: BoundedProcessRunner;
}

const detected = (): SourceDetectionResult => ({
  availability: 'detected',
  reason: { code: 'none' },
});

const notDetected = (message = 'No supported local input was found.'): SourceDetectionResult => ({
  availability: 'not-detected',
  reason: { code: 'input-missing', message },
});

const misconfigured = (): SourceDetectionResult => ({
  availability: 'misconfigured',
  reason: { code: 'misconfigured', message: 'The source configuration is invalid.' },
});

const sourceUnavailableResult = (): SourceRunResult => ({
  changed: false,
  inputCount: 0,
  outputCount: 0,
  unavailable: { code: 'run-unavailable', message: 'The supported local input is no longer available.' },
  warnings: [],
});

const sourceFailure = (sourceId: CollectionSourceId, cause: unknown): SourceRunError =>
  new SourceRunError({
    cause,
    message: 'The source failed while reading or persisting local data.',
    sourceId,
  });

const persistCursorCommitAttribution = (input: {
  readonly dbPath: string;
  readonly machineId: string;
  readonly rows: Parameters<typeof normalizeCursorCommitAttributionItems>[1];
}) =>
  importNormalizedDatasetItems({
    dbPath: input.dbPath,
    items: normalizeCursorCommitAttributionItems(input.machineId, input.rows),
  });

const reportProgress = (context: SourceRunContext, progress: SourceProgress): Effect.Effect<void> =>
  context.reportProgress({
    ...progress,
    ...(progress.message === undefined
      ? {}
      : { message: progress.message.slice(0, sourceControlBounds.maxMessageLength) }),
  });

const abortIfRequested = (signal: AbortSignal | undefined): Effect.Effect<void, never> =>
  signal?.aborted ? Effect.interrupt : Effect.void;

const stripRtkContribution = (row: CollectorRow): CollectorRow => {
  const {
    rtkCommandCount: _rtkCommandCount,
    rtkInputTokens: _rtkInputTokens,
    rtkOutputTokens: _rtkOutputTokens,
    rtkSavedTokens: _rtkSavedTokens,
    ...base
  } = row;
  return base;
};

const rtkContributionFromRow = (row: CollectorRow): RtkSavingsContribution | undefined => {
  const { rtkCommandCount, rtkInputTokens, rtkOutputTokens, rtkSavedTokens } = row;
  if (
    rtkCommandCount === undefined ||
    rtkInputTokens === undefined ||
    rtkOutputTokens === undefined ||
    rtkSavedTokens === undefined
  ) {
    return;
  }
  return { rtkCommandCount, rtkInputTokens, rtkOutputTokens, rtkSavedTokens };
};

const resolveConfigPath = (configCwd: string | undefined, value: string): string =>
  configCwd && !path.isAbsolute(value) ? path.resolve(configCwd, value) : value;

type CursorInputOptions = NonNullable<Parameters<typeof selectedHarnessAdapters>[0]['cursorCsv']>;

const resolveCursorInputOptions = (
  storage: LocalHistoryStorageService,
  configCwd: string | undefined,
): Effect.Effect<CursorInputOptions | undefined, unknown> =>
  readMergedAiUsageConfigFrom(configCwd).pipe(
    Effect.provideService(LocalHistoryStorage, storage),
    Effect.flatMap((config) =>
      Effect.map(
        configCwd
          ? Effect.tryPromise(() => listManagedCursorUsageExportPaths(configCwd))
          : Effect.succeed<readonly string[]>([]),
        (managedPaths) => {
          const configured = config.cursor;
          const usageExportPaths = [
            ...(configured?.usageExportPaths ?? []).map((filePath) => resolveConfigPath(configCwd, filePath)),
            ...managedPaths,
          ].filter((filePath, index, paths) => paths.indexOf(filePath) === index);
          if (!(configured || usageExportPaths.length > 0)) {
            return;
          }
          return {
            ...configured,
            ...(configured?.usageExportDir
              ? { usageExportDir: resolveConfigPath(configCwd, configured.usageExportDir) }
              : {}),
            ...(usageExportPaths.length > 0 ? { usageExportPaths } : {}),
          };
        },
      ),
    ),
  );

const detectConfiguredCursorInputs = (
  storage: LocalHistoryStorageService,
  configCwd: string | undefined,
): Effect.Effect<SourceDetectionResult> =>
  resolveCursorInputOptions(storage, configCwd).pipe(
    Effect.flatMap((options) => {
      const configuredPaths = [
        ...(options?.usageExportPaths ?? []),
        ...(options?.usageExportDir ? [options.usageExportDir] : []),
      ];
      return Effect.map(
        firstExisting(storage, ...resolvePathCandidates(storage).cursor.stateVscdb, ...configuredPaths),
        (inputPath) => (inputPath ? detected() : notDetected()),
      );
    }),
    Effect.catchAll(() => Effect.succeed(misconfigured())),
  );

const detectPathCandidates = (
  storage: LocalHistoryStorageService,
  candidates: readonly string[],
): Effect.Effect<SourceDetectionResult> =>
  Effect.map(firstExisting(storage, ...candidates), (inputPath) => (inputPath ? detected() : notDetected()));

const cursorOptions = (
  storage: LocalHistoryStorageService,
  configCwd: string | undefined,
): Effect.Effect<Parameters<typeof selectedHarnessAdapters>[0]['cursorCsv'], SourceRunError> =>
  resolveCursorInputOptions(storage, configCwd).pipe(
    Effect.mapError((cause) => sourceFailure('cursor.sessions', cause)),
  );

const collectHarness = (
  adapter: HarnessAdapter,
): Effect.Effect<
  {
    // Optional, and deliberately so: a harness that cannot observe skills
    // (Cursor) omits this rather than reporting an empty list, which would be
    // indistinguishable from having observed nothing (ADR 0022).
    observationCompleteness?: SkillObservationCollectionCompleteness;
    observations?: readonly SkillObservation[];
    rows: CollectorRow[];
    warnings: readonly SanitizableSourceWarning[];
  },
  unknown,
  LocalHistoryStorageService
> => {
  if (adapter.collectResult) {
    return adapter.collectResult;
  }
  return adapter.collect.pipe(Effect.map((rows) => ({ rows, warnings: [] })));
};

interface SkillObservationImportCandidate {
  readonly index: number;
  readonly normalizedObservedAt: string | null;
  readonly observation: SkillObservation;
}

export interface PreparedSkillObservationImport {
  readonly completeness: SkillObservationCollectionCompleteness;
  readonly observations: readonly SkillObservation[];
}

/**
 * Applies the engine-owned exposure retention and write budgets before the
 * store sees a rescan. Actual invocations get the budget first: catalogue
 * exposure is both much larger and weaker evidence, so letting it compete in
 * one pooled slice can erase the exact observations the Skills surface exists
 * to report.
 */
export const prepareSkillObservationImport = (input: {
  readonly completeness: SkillObservationCollectionCompleteness;
  readonly maximumObservations?: number;
  readonly minimumExposureObservedAt: string;
  readonly observations: readonly SkillObservation[];
}): PreparedSkillObservationImport => {
  const maximumObservations = input.maximumObservations ?? MAX_SKILL_OBSERVATION_BATCH;
  if (
    !Number.isSafeInteger(maximumObservations) ||
    maximumObservations <= 0 ||
    maximumObservations > MAX_SKILL_OBSERVATION_BATCH
  ) {
    throw new RangeError('Skill observation import budget is invalid');
  }

  const retained: SkillObservationImportCandidate[] = input.observations.flatMap((observation, index) => {
    const parsed = parseSkillObservation(observation);
    if (parsed !== null && parsed.tier === 'exposed' && parsed.observedAt < input.minimumExposureObservedAt) {
      return [];
    }
    return [{ index, normalizedObservedAt: parsed?.observedAt ?? null, observation }];
  });
  const completeness: SkillObservationCollectionCompleteness = {
    exposure: { ...input.completeness.exposure },
    invocation: { ...input.completeness.invocation },
  };
  if (retained.length <= maximumObservations) {
    return { completeness, observations: retained.map(({ observation }) => observation) };
  }

  const byRecency = (left: SkillObservationImportCandidate, right: SkillObservationImportCandidate): number => {
    // Invalid internal candidates stay at the front so the store can reject and
    // count them instead of an engine-side bound silently hiding the defect.
    if (left.normalizedObservedAt === null || right.normalizedObservedAt === null) {
      if (left.normalizedObservedAt === right.normalizedObservedAt) {
        return left.index - right.index;
      }
      return left.normalizedObservedAt === null ? -1 : 1;
    }
    if (left.normalizedObservedAt !== right.normalizedObservedAt) {
      return left.normalizedObservedAt < right.normalizedObservedAt ? 1 : -1;
    }
    return left.index - right.index;
  };
  const invocation = retained.filter(({ observation }) => observation.tier !== 'exposed').sort(byRecency);
  const exposure = retained.filter(({ observation }) => observation.tier === 'exposed').sort(byRecency);
  const keptInvocation = invocation.slice(0, maximumObservations);
  const exposureBudget = maximumObservations - keptInvocation.length;
  const keptExposure = exposure.slice(0, exposureBudget);
  completeness.invocation.truncated ||= keptInvocation.length < invocation.length;
  completeness.exposure.truncated ||= keptExposure.length < exposure.length;
  return {
    completeness,
    observations: [...keptInvocation, ...keptExposure].map(({ observation }) => observation),
  };
};

const createSessionSource = (input: {
  adapter: () => Effect.Effect<HarnessAdapter, SourceRunError>;
  dbPath: string;
  detect: Effect.Effect<SourceDetectionResult>;
  id: 'claude.sessions' | 'codex.sessions' | 'cursor.sessions' | 'opencode.sessions';
  label: string;
  machine: UsageMachine;
  now: () => Date;
  storage: LocalHistoryStorageService;
}): ScheduledSource => ({
  cadence: Duration.millis(getCollectionSourceDefinition(input.id).cadenceMs),
  detect: input.detect,
  id: input.id,
  run: (context) =>
    Effect.gen(function* () {
      yield* reportProgress(context, { phase: 'reading' });
      const availability = yield* input.detect;
      if (availability.availability !== 'detected') {
        return sourceUnavailableResult();
      }
      const adapter = yield* input.adapter();
      const collection = yield* collectHarness(adapter).pipe(
        Effect.provideService(LocalHistoryStorage, input.storage),
        Effect.mapError((cause) => sourceFailure(input.id, cause)),
      );
      yield* abortIfRequested(context.signal);
      const retentionWarnings =
        input.id === 'claude.sessions'
          ? yield* collectClaudeRetentionWarnings.pipe(Effect.provideService(LocalHistoryStorage, input.storage))
          : [];
      yield* reportProgress(context, {
        completed: collection.rows.length,
        phase: 'normalizing',
        total: collection.rows.length,
      });
      const rows = collection.rows.map(stripRtkContribution).map(stripProjectPath);
      yield* reportProgress(context, {
        completed: 0,
        phase: 'importing',
        total: rows.length,
      });
      yield* abortIfRequested(context.signal);
      const imported = yield* importLocalRows({
        dbPath: input.dbPath,
        importedAt: input.now(),
        machine: input.machine,
        rows,
      }).pipe(Effect.mapError((cause) => sourceFailure(input.id, cause)));
      // Skill observations are an auxiliary fact family with their own table,
      // written on the same engine-owned pass as the rows they were parsed
      // beside. The engine is the only writer (ADR 0009), so this is the one
      // place they can reach the store.
      const minimumExposureObservedAt = new Date(
        input.now().getTime() - SKILL_OBSERVATION_EXPOSURE_RETENTION_MS,
      ).toISOString();
      const preparedObservations = prepareSkillObservationImport({
        completeness: collection.observationCompleteness ?? {
          exposure: { rejected: 0, truncated: true },
          invocation: { rejected: 0, truncated: true },
        },
        minimumExposureObservedAt,
        observations: collection.observations ?? [],
      });
      yield* abortIfRequested(context.signal);
      const importedObservations =
        collection.observations === undefined
          ? { inserted: 0, rejected: 0, stateChanged: false, unchanged: 0, updated: 0 }
          : yield* importSkillObservations({
              collection: {
                completeness: preparedObservations.completeness,
                harnessKey: adapter.metadata.key,
              },
              dbPath: input.dbPath,
              machineId: input.machine.id,
              minimumExposureObservedAt,
              observations: preparedObservations.observations,
            }).pipe(Effect.mapError((cause) => sourceFailure(input.id, cause)));
      const warnings = sanitizeSourceWarnings(input.label, [...collection.warnings, ...retentionWarnings]);
      return {
        changed:
          imported.inserted > 0 ||
          imported.updated > 0 ||
          importedObservations.inserted > 0 ||
          importedObservations.updated > 0 ||
          importedObservations.stateChanged,
        inputCount: collection.rows.length,
        outputCount: rows.length,
        servedProjectionChanged: imported.fleetChanged,
        warnings,
      };
    }),
});

const createRtkSource = (input: {
  dbPath: string;
  detect: Effect.Effect<SourceDetectionResult>;
  machine: UsageMachine;
  storage: LocalHistoryStorageService;
}): ScheduledSource => ({
  cadence: Duration.millis(getCollectionSourceDefinition('rtk.savings').cadenceMs),
  detect: input.detect,
  id: 'rtk.savings',
  run: (context) =>
    Effect.gen(function* () {
      yield* reportProgress(context, { phase: 'reading' });
      const availability = yield* input.detect;
      if (availability.availability !== 'detected') {
        return sourceUnavailableResult();
      }
      const stored = yield* queryEnrichableUsageRows({
        dbPath: input.dbPath,
        originMachineIds: [input.machine.id],
        sourceAuthorities: ['local-observed'],
      }).pipe(Effect.mapError((cause) => sourceFailure('rtk.savings', cause)));
      const collectorRows: CollectorRow[] = stored.rows.map(({ row }) => ({
        ...row,
        ...(row.source?.sourcePath ? { projectPath: row.source.sourcePath } : {}),
      }));
      yield* reportProgress(context, {
        completed: collectorRows.length,
        phase: 'normalizing',
        total: collectorRows.length,
      });
      const enriched = yield* enrichCollectorRowsWithRtkSavingsResult(collectorRows).pipe(
        Effect.provideService(LocalHistoryStorage, input.storage),
      );
      yield* abortIfRequested(context.signal);
      yield* reportProgress(context, {
        completed: 0,
        phase: 'importing',
        total: enriched.rows.length,
      });
      const imported = yield* upsertRtkSavingsContributions({
        contributions: enriched.rows.flatMap((row, index) => {
          const contribution = rtkContributionFromRow(row);
          const storedRow = stored.rows[index];
          return contribution && storedRow ? [{ contribution, rowKey: storedRow.rowKey }] : [];
        }),
        dbPath: input.dbPath,
      }).pipe(Effect.mapError((cause) => sourceFailure('rtk.savings', cause)));
      return {
        changed: imported.inserted > 0 || imported.updated > 0,
        inputCount: stored.rows.length,
        outputCount: imported.inserted + imported.updated + imported.unchanged,
        warnings: sanitizeSourceWarnings('RTK savings', enriched.warnings),
      };
    }),
});

const createCursorAttributionSource = (input: {
  dbPath: string;
  detect: Effect.Effect<SourceDetectionResult>;
  machine: UsageMachine;
  storage: LocalHistoryStorageService;
}): ScheduledSource => ({
  cadence: Duration.millis(getCollectionSourceDefinition('cursor.commit-attribution').cadenceMs),
  detect: input.detect,
  id: 'cursor.commit-attribution',
  run: (context) =>
    Effect.gen(function* () {
      yield* reportProgress(context, { phase: 'reading' });
      const availability = yield* input.detect;
      if (availability.availability !== 'detected') {
        return sourceUnavailableResult();
      }
      const collection = yield* collectCursorCommitAttributionResult.pipe(
        Effect.provideService(LocalHistoryStorage, input.storage),
        Effect.mapError((cause) => sourceFailure('cursor.commit-attribution', cause)),
      );
      yield* reportProgress(context, {
        completed: collection.rows.length,
        phase: 'normalizing',
        total: collection.rows.length,
      });
      yield* abortIfRequested(context.signal);
      const imported = yield* persistCursorCommitAttribution({
        dbPath: input.dbPath,
        machineId: input.machine.id,
        rows: collection.rows,
      }).pipe(Effect.mapError((cause) => sourceFailure('cursor.commit-attribution', cause)));
      return {
        changed: imported.inserted > 0 || imported.updated > 0,
        inputCount: collection.rows.length,
        outputCount: collection.rows.length,
        warnings: sanitizeSourceWarnings('Cursor commit attribution', collection.warnings),
      };
    }),
});

/**
 * Claude Desktop's session registry (ADR 0050). The rows land in their own tables, outside the
 * served revision, so `changed` is always `false` here: in `finishSourceJobTransition` a changed
 * run marks the served projection dirty and wakes a publication, and nothing this source writes
 * is read by that projection. A publication per Desktop turn would re-assemble the report for no
 * reader. `servedProjectionChanged` is likewise left unset. Consumers of this family poll the
 * table on their own cadence (the Work view's collection-SWR policy).
 */
const createClaudeDesktopSessionSource = (input: {
  dbPath: string;
  detect: Effect.Effect<SourceDetectionResult>;
  machine: UsageMachine;
  now: () => Date;
  storage: LocalHistoryStorageService;
}): ScheduledSource => ({
  cadence: Duration.millis(getCollectionSourceDefinition('claude.desktop-sessions').cadenceMs),
  detect: input.detect,
  id: 'claude.desktop-sessions',
  run: (context) =>
    Effect.gen(function* () {
      yield* reportProgress(context, { phase: 'reading' });
      const availability = yield* input.detect;
      if (availability.availability !== 'detected') {
        return sourceUnavailableResult();
      }
      const collection = yield* collectClaudeDesktopSessions({ machineId: input.machine.id, now: input.now }).pipe(
        Effect.provideService(LocalHistoryStorage, input.storage),
        Effect.mapError((cause) => sourceFailure('claude.desktop-sessions', cause)),
      );
      yield* reportProgress(context, {
        completed: collection.observations.length,
        phase: 'normalizing',
        total: collection.observations.length,
      });
      yield* abortIfRequested(context.signal);
      yield* reportProgress(context, {
        completed: 0,
        phase: 'importing',
        total: collection.observations.length,
      });
      const imported = yield* importClaudeDesktopSessions({
        collectedAt: input.now(),
        completeness: collection.completeness,
        dbPath: input.dbPath,
        machineId: input.machine.id,
        observations: collection.observations,
      }).pipe(Effect.mapError((cause) => sourceFailure('claude.desktop-sessions', cause)));
      // A candidate the store refused is a collector defect; it surfaces as a warning count rather
      // than disappearing between the sweep and the table.
      const storeWarnings: SanitizableSourceWarning[] =
        imported.skipped > 0
          ? [{ operation: 'claudeDesktopSessions.storeRefused', rejectedRecords: imported.skipped }]
          : [];
      return {
        changed: false,
        inputCount: collection.completeness.filesSeen,
        outputCount: imported.inserted + imported.updated + imported.unchanged,
        warnings: sanitizeSourceWarnings('Claude Desktop sessions', [...collection.warnings, ...storeWarnings]),
      };
    }),
});

const createExecutorCapabilitiesSource = (input: {
  dbPath: string;
  detect: Effect.Effect<SourceDetectionResult>;
  machine: UsageMachine;
  now: () => Date;
  observation: SourceAdapterOptions['executorObservation'];
}): ScheduledSource => ({
  cadence: Duration.millis(getCollectionSourceDefinition('executors.capabilities').cadenceMs),
  detect: input.detect,
  id: 'executors.capabilities',
  run: (context) =>
    Effect.gen(function* () {
      yield* reportProgress(context, { phase: 'reading' });
      const availability = yield* input.detect;
      if (availability.availability !== 'detected') {
        return sourceUnavailableResult();
      }
      const observations = yield* Effect.tryPromise({
        catch: (cause) => sourceFailure('executors.capabilities', cause),
        try: () =>
          observeExecutors({
            machineId: input.machine.id,
            now: input.now,
            ...(input.observation?.run === undefined ? {} : { run: input.observation.run }),
            ...(input.observation?.which === undefined ? {} : { which: input.observation.which }),
          }),
      });
      yield* abortIfRequested(context.signal);
      yield* reportProgress(context, { completed: 0, phase: 'importing', total: observations.length });
      const imported = yield* importExecutorObservations({ dbPath: input.dbPath, observations }).pipe(
        Effect.mapError((cause) => sourceFailure('executors.capabilities', cause)),
      );
      // Observations qualify review routing; they are not report data, so a new row never asks
      // for a served-revision publication. An absent binary is an observed fact, not a warning;
      // only a probe that could not conclude (timeout, unreadable output) is worth surfacing.
      return {
        changed: false,
        inputCount: observations.length,
        outputCount: imported.inserted,
        warnings: observations
          .filter((observation) => observation.outcome === 'timeout' || observation.outcome === 'invalid')
          .map((observation) => ({
            code: `executor-${observation.harness}-${observation.outcome}`,
            message: `${observation.harness}: ${observation.authEvidence}`.slice(
              0,
              sourceControlBounds.maxMessageLength,
            ),
          })),
      };
    }),
});

const createProviderQuotaSource = (input: {
  dbPath: string;
  detect: Effect.Effect<SourceDetectionResult>;
  /** Provider-specific refresh overrides: identity and sources. Codex passes none and keeps its defaults. */
  quotaOptions?: ProviderQuotaRuntimeOptions;
  id: 'codex.usage-limits' | 'claude.usage-limits';
  machine: UsageMachine;
  options: SourceAdapterOptions;
  storage: LocalHistoryStorageService;
}): ScheduledSource => ({
  cadence: Duration.millis(getCollectionSourceDefinition(input.id).cadenceMs),
  detect: input.detect,
  id: input.id,
  run: (context) =>
    Effect.gen(function* () {
      yield* reportProgress(context, { phase: 'reading' });
      const availability = yield* input.detect;
      if (availability.availability !== 'detected') {
        return sourceUnavailableResult();
      }
      const generationBefore = yield* queryUsageStoreGeneration({ dbPath: input.dbPath }).pipe(
        Effect.mapError((cause) => sourceFailure(input.id, cause)),
      );
      const result = yield* refreshLocalProviderQuotas({
        dbPath: input.dbPath,
        machine: input.machine,
        options: {
          // Per-source defaults first, caller injection second: a test that stubs a live source must
          // still win, while the provider identity this source was built with survives untouched.
          ...input.quotaOptions,
          ...input.options.providerQuotaOptions,
          liveCadenceMs: 0,
          ...(input.options.now === undefined ? {} : { now: input.options.now }),
        },
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      }).pipe(
        Effect.provideService(LocalHistoryStorage, input.storage),
        Effect.mapError((cause) => sourceFailure(input.id, cause)),
      );
      const generationAfter = yield* queryUsageStoreGeneration({ dbPath: input.dbPath }).pipe(
        Effect.mapError((cause) => sourceFailure(input.id, cause)),
      );
      const warnings = result.warnings
        .slice(0, sourceControlBounds.maxWarningsPerSource)
        .map((message) => ({ code: 'provider-warning', message }));
      return {
        changed: generationAfter !== generationBefore,
        inputCount: result.latest.length,
        outputCount: result.latest.length,
        warnings,
      };
    }),
});

const usableLocalPath = (value: string): boolean => path.isAbsolute(value) && !value.includes('\0');

/**
 * The checkouts a run observes: every canonical path the served local Project sources decode to,
 * then every linked worktree (the physical path of a source whose published id names another
 * path), as ADR 0044 observes them, then the injected candidates. Resolved so `/a/b/` and
 * `/a/b` are one checkout; a path appears once.
 */
export const candidateCheckoutPaths = (
  sources: readonly ServedLocalProjectSource[],
  machineId: string,
  injected: readonly string[] = [],
): string[] => {
  const canonical = new Set<string>();
  const worktrees = new Set<string>();
  for (const source of sources) {
    if (source.machineId !== machineId || !usableLocalPath(source.sourcePath)) {
      continue;
    }
    const localPath = path.resolve(source.sourcePath);
    const published =
      source.projectSourceId === null ? null : projectSourcePathFromId(source.projectSourceId, machineId);
    const canonicalPath = published !== null && usableLocalPath(published) ? path.resolve(published) : localPath;
    canonical.add(canonicalPath);
    if (localPath !== canonicalPath) {
      worktrees.add(localPath);
    }
  }
  const ordered = [...canonical];
  for (const worktree of worktrees) {
    if (!canonical.has(worktree)) {
      ordered.push(worktree);
    }
  }
  for (const candidate of injected) {
    if (!usableLocalPath(candidate)) {
      continue;
    }
    const resolved = path.resolve(candidate);
    if (!ordered.includes(resolved)) {
      ordered.push(resolved);
    }
  }
  return ordered;
};

/** A store or revision that does not exist yet means "no served inputs", not a failed run. */
const servedInputsOrEmpty = <Value>(
  sourceId: WorkFactSourceId,
  read: Effect.Effect<Value, UsageStoreError>,
  empty: Value,
): Effect.Effect<Value, SourceRunError> =>
  read.pipe(
    Effect.catchAll((error) =>
      error.reason === 'revision-unavailable' || error.reason === 'store-missing'
        ? Effect.succeed(empty)
        : Effect.fail(sourceFailure(sourceId, error)),
    ),
  );

const pullRequestLinkKey = (link: PullRequestLink): string => JSON.stringify([link.host, link.repository, link.number]);

/** Desktop sessions active within this window name the checkouts and pull requests to observe. */
const DESKTOP_WORK_FACT_WINDOW_MS = 14 * 86_400_000;

interface DesktopWorkFactInputs {
  /** Jira keys written in the sessions' branch names (ADR 0054), never read from titles or paths. */
  readonly jiraKeys: readonly string[];
  readonly links: readonly PullRequestLink[];
  readonly paths: readonly string[];
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

const NO_DESKTOP_WORK_FACT_INPUTS: DesktopWorkFactInputs = { jiraKeys: [], links: [], paths: [], warnings: [] };

/**
 * What the Claude Desktop sessions active in the last fourteen days named: `worktreePath ?? cwd`
 * as the checkout, `prs[]` as the pull requests, the Jira keys written in their branch names as
 * the issues, most recently active session first, each once.
 * The Work read attaches facts only to these families, so they lead the served inputs under the
 * per-run bounds. A store that does not exist yet means no candidates; a read that fails for any
 * other reason also yields none and is said in a warning, so the run goes on with the served and
 * injected inputs instead of failing because of a table it does not own.
 */
const desktopWorkFactInputs = (input: {
  readonly dbPath: string;
  readonly machineId: string;
  readonly now: () => Date;
}): Effect.Effect<DesktopWorkFactInputs> =>
  queryClaudeDesktopSessions({
    dbPath: input.dbPath,
    limit: MAX_CLAUDE_DESKTOP_SESSION_READ,
    machineId: input.machineId,
    sinceLastActivityAt: new Date(input.now().getTime() - DESKTOP_WORK_FACT_WINDOW_MS).toISOString(),
  }).pipe(
    Effect.map(({ observations }): DesktopWorkFactInputs => {
      const paths: string[] = [];
      const links: PullRequestLink[] = [];
      const jiraKeys: string[] = [];
      const seenLinks = new Set<string>();
      for (const observation of observations) {
        const checkoutPath = observation.worktreePath ?? observation.cwd;
        if (!paths.includes(checkoutPath)) {
          paths.push(checkoutPath);
        }
        for (const key of explicitJiraKeys(observation)) {
          if (!jiraKeys.includes(key)) {
            jiraKeys.push(key);
          }
        }
        for (const pullRequest of observation.declaredPullRequests) {
          const link: PullRequestLink = {
            host: pullRequest.host,
            number: pullRequest.number,
            repository: pullRequest.repository,
          };
          const key = pullRequestLinkKey(link);
          if (!seenLinks.has(key)) {
            seenLinks.add(key);
            links.push(link);
          }
        }
      }
      return { jiraKeys, links, paths, warnings: [] };
    }),
    Effect.catchAll((error) =>
      Effect.succeed<DesktopWorkFactInputs>(
        error.reason === 'store-missing'
          ? NO_DESKTOP_WORK_FACT_INPUTS
          : {
              ...NO_DESKTOP_WORK_FACT_INPUTS,
              warnings: [
                {
                  code: 'desktop-sessions-unread',
                  message:
                    'Claude Desktop sessions could not be read; only served and injected inputs were observed this run.',
                },
              ],
            },
      ),
    ),
  );

/** The configured `gh` login for a link's owner, or null for the CLI's active account. */
const accountFor = (github: AiUsageGitHubConfig | undefined, link: PullRequestLink): string | null => {
  const owner = link.repository.split('/')[0]?.toLowerCase() ?? '';
  return (
    github?.accounts?.find((account) => account.host === link.host && account.owner.toLowerCase() === owner)?.ghUser ??
    null
  );
};

/**
 * Named explicitly for `gh`: on Linux its tokens may live in the session keyring, which is reached
 * through the session bus. The address is a socket path, not a credential, and nothing else from
 * this process's environment is forwarded beyond the runner's allow-list.
 */
const ghEnvironment = (): Record<string, string> => {
  const busAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
  return busAddress ? { DBUS_SESSION_BUS_ADDRESS: busAddress } : {};
};

const createCheckoutStatusSource = (input: {
  dbPath: string;
  detect: Effect.Effect<SourceDetectionResult>;
  machine: UsageMachine;
  now: () => Date;
  options: SourceAdapterOptions;
}): ScheduledSource => ({
  cadence: Duration.millis(getCollectionSourceDefinition('checkouts.status').cadenceMs),
  detect: input.detect,
  id: 'checkouts.status',
  run: (context) =>
    Effect.gen(function* () {
      yield* reportProgress(context, { phase: 'discovering' });
      const availability = yield* input.detect;
      if (availability.availability !== 'detected') {
        return sourceUnavailableResult();
      }
      const served = yield* servedInputsOrEmpty(
        'checkouts.status',
        queryCurrentServedLocalProjectSources({ dbPath: input.dbPath }).pipe(Effect.map(({ sources }) => sources)),
        [] as readonly ServedLocalProjectSource[],
      );
      const desktop = yield* desktopWorkFactInputs({
        dbPath: input.dbPath,
        machineId: input.machine.id,
        now: input.now,
      });
      const injected = input.options.workFactInputs?.candidateCheckoutPaths
        ? yield* input.options.workFactInputs.candidateCheckoutPaths()
        : [];
      // Desktop checkouts first, then the served plan and the injected candidates, each path once.
      const paths = [
        ...new Set([
          ...candidateCheckoutPaths([], input.machine.id, desktop.paths),
          ...candidateCheckoutPaths(served, input.machine.id, injected),
        ]),
      ];
      yield* reportProgress(context, { completed: 0, phase: 'reading', total: paths.length });
      const batch = yield* observeCheckoutStatus({
        machineId: input.machine.id,
        now: input.now,
        paths,
        ...(input.options.workFactProcessRunner === undefined ? {} : { run: input.options.workFactProcessRunner }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      yield* abortIfRequested(context.signal);
      yield* reportProgress(context, { completed: 0, phase: 'importing', total: batch.observations.length });
      yield* importCheckoutStatusObservations({ dbPath: input.dbPath, observations: batch.observations }).pipe(
        Effect.mapError((cause) => sourceFailure('checkouts.status', cause)),
      );
      const observed = batch.observations.filter(({ outcome }) => outcome === 'observed').length;
      const message = batch.truncated
        ? `Observed the first ${String(batch.observations.length)} of ${String(paths.length)} candidate checkouts.`
        : null;
      yield* recordWorkFactRun({
        dbPath: input.dbPath,
        disabled: false,
        failed: batch.observations.length - observed,
        machineId: input.machine.id,
        message,
        observed,
        ranAt: input.now(),
        sourceId: 'checkouts.status',
      }).pipe(Effect.mapError((cause) => sourceFailure('checkouts.status', cause)));
      return {
        changed: false,
        inputCount: paths.length,
        outputCount: batch.observations.length,
        warnings: [...desktop.warnings, ...(message === null ? [] : [{ code: 'checkouts-truncated', message }])],
      };
    }),
});

const createPullRequestSource = (input: {
  dbPath: string;
  detect: Effect.Effect<SourceDetectionResult>;
  machine: UsageMachine;
  now: () => Date;
  options: SourceAdapterOptions;
  storage: LocalHistoryStorageService;
}): ScheduledSource => ({
  cadence: Duration.millis(getCollectionSourceDefinition('github.pull-requests').cadenceMs),
  detect: input.detect,
  id: 'github.pull-requests',
  run: (context) =>
    Effect.gen(function* () {
      yield* reportProgress(context, { phase: 'discovering' });
      const availability = yield* input.detect;
      if (availability.availability !== 'detected') {
        return sourceUnavailableResult();
      }
      const config = yield* readMergedAiUsageConfigFrom(input.options.configCwd).pipe(
        Effect.provideService(LocalHistoryStorage, input.storage),
        Effect.catchAllDefect((cause) => Effect.fail(cause)),
        Effect.mapError((cause) => sourceFailure('github.pull-requests', cause)),
      );
      if (config.github?.enabled === false) {
        const message = 'github.enabled is false in the local config.';
        yield* recordWorkFactRun({
          dbPath: input.dbPath,
          disabled: true,
          failed: 0,
          machineId: input.machine.id,
          message,
          observed: 0,
          ranAt: input.now(),
          sourceId: 'github.pull-requests',
        }).pipe(Effect.mapError((cause) => sourceFailure('github.pull-requests', cause)));
        return {
          changed: false,
          inputCount: 0,
          outputCount: 0,
          unavailable: { code: 'policy-disabled', message },
          warnings: [],
        };
      }
      const served = yield* servedInputsOrEmpty(
        'github.pull-requests',
        queryServedSessionPullRequestLinks({ dbPath: input.dbPath }).pipe(Effect.map(({ links }) => links)),
        [] as readonly PullRequestLink[],
      );
      const desktop = yield* desktopWorkFactInputs({
        dbPath: input.dbPath,
        machineId: input.machine.id,
        now: input.now,
      });
      const injected = input.options.workFactInputs?.linkedPullRequests
        ? yield* input.options.workFactInputs.linkedPullRequests()
        : [];
      // Desktop-declared pull requests first, then the served links and the injected ones, each once.
      const unique = new Map<string, PullRequestLink>();
      for (const link of [...desktop.links, ...served, ...injected]) {
        const candidate: PullRequestLink = { host: link.host, number: link.number, repository: link.repository };
        const key = pullRequestLinkKey(candidate);
        if (!unique.has(key)) {
          unique.set(key, candidate);
        }
      }
      const links = [...unique.values()].slice(0, GITHUB_PULL_REQUEST_DEFAULTS.maxLinks);
      const truncated = unique.size > links.length;
      yield* reportProgress(context, { completed: 0, phase: 'reading', total: links.length });
      // One batch per gh login: the active account for owners without a configured one.
      const byAccount = new Map<string | null, PullRequestLink[]>();
      for (const link of links) {
        const account = accountFor(config.github, link);
        byAccount.set(account, [...(byAccount.get(account) ?? []), link]);
      }
      const observations: PullRequestObservation[] = [];
      for (const [account, accountLinks] of byAccount) {
        yield* abortIfRequested(context.signal);
        const batch = yield* observePullRequests({
          environment: ghEnvironment(),
          links: accountLinks,
          machineId: input.machine.id,
          now: input.now,
          ...(account === null ? {} : { account: { ghUser: account } }),
          ...(input.options.workFactProcessRunner === undefined ? {} : { run: input.options.workFactProcessRunner }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
        observations.push(...batch.observations);
      }
      yield* abortIfRequested(context.signal);
      yield* reportProgress(context, { completed: 0, phase: 'importing', total: observations.length });
      yield* importPullRequestObservations({ dbPath: input.dbPath, observations }).pipe(
        Effect.mapError((cause) => sourceFailure('github.pull-requests', cause)),
      );
      const observed = observations.filter(({ outcome }) => outcome === 'observed').length;
      const failed = observations.filter(({ outcome }) => outcome !== 'observed' && outcome !== 'disabled').length;
      const message = truncated
        ? `Observed the first ${String(links.length)} of ${String(unique.size)} linked pull requests.`
        : null;
      yield* recordWorkFactRun({
        dbPath: input.dbPath,
        disabled: false,
        failed,
        machineId: input.machine.id,
        message,
        observed,
        ranAt: input.now(),
        sourceId: 'github.pull-requests',
      }).pipe(Effect.mapError((cause) => sourceFailure('github.pull-requests', cause)));
      return {
        changed: false,
        inputCount: links.length,
        outputCount: observations.length,
        warnings: [...desktop.warnings, ...(message === null ? [] : [{ code: 'pull-requests-truncated', message }])],
      };
    }),
});

/**
 * The Jira issue producer (ADR 0054): one bounded `acli` read per key the active Desktop sessions
 * wrote in a branch name, through the operator's own CLI session. The run records itself
 * `disabled` when `jira.enabled` is false, and also when every read found no `acli` (the binary
 * left between detection and the run), so the Work view can name the reason.
 */
const createJiraIssueSource = (input: {
  dbPath: string;
  detect: Effect.Effect<SourceDetectionResult>;
  machine: UsageMachine;
  now: () => Date;
  options: SourceAdapterOptions;
  storage: LocalHistoryStorageService;
}): ScheduledSource => ({
  cadence: Duration.millis(getCollectionSourceDefinition('jira.issues').cadenceMs),
  detect: input.detect,
  id: 'jira.issues',
  run: (context) =>
    Effect.gen(function* () {
      yield* reportProgress(context, { phase: 'discovering' });
      const availability = yield* input.detect;
      if (availability.availability !== 'detected') {
        return sourceUnavailableResult();
      }
      const config = yield* readMergedAiUsageConfigFrom(input.options.configCwd).pipe(
        Effect.provideService(LocalHistoryStorage, input.storage),
        Effect.catchAllDefect((cause) => Effect.fail(cause)),
        Effect.mapError((cause) => sourceFailure('jira.issues', cause)),
      );
      if (config.jira?.enabled === false) {
        const message = 'jira.enabled is false in the local config.';
        yield* recordWorkFactRun({
          dbPath: input.dbPath,
          disabled: true,
          failed: 0,
          machineId: input.machine.id,
          message,
          observed: 0,
          ranAt: input.now(),
          sourceId: 'jira.issues',
        }).pipe(Effect.mapError((cause) => sourceFailure('jira.issues', cause)));
        return {
          changed: false,
          inputCount: 0,
          outputCount: 0,
          unavailable: { code: 'policy-disabled', message },
          warnings: [],
        };
      }
      const desktop = yield* desktopWorkFactInputs({
        dbPath: input.dbPath,
        machineId: input.machine.id,
        now: input.now,
      });
      const keys = desktop.jiraKeys.slice(0, JIRA_ISSUE_DEFAULTS.maxKeys);
      const truncated = desktop.jiraKeys.length > keys.length;
      yield* reportProgress(context, { completed: 0, phase: 'reading', total: keys.length });
      const batch = yield* observeJiraIssues({
        keys,
        machineId: input.machine.id,
        now: input.now,
        ...(input.options.workFactProcessRunner === undefined ? {} : { run: input.options.workFactProcessRunner }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      yield* abortIfRequested(context.signal);
      yield* reportProgress(context, { completed: 0, phase: 'importing', total: batch.observations.length });
      yield* importJiraIssueObservations({ dbPath: input.dbPath, observations: batch.observations }).pipe(
        Effect.mapError((cause) => sourceFailure('jira.issues', cause)),
      );
      const observed = batch.observations.filter(({ outcome }) => outcome === 'observed').length;
      const failed = batch.observations.filter(
        ({ outcome }) => outcome !== 'observed' && outcome !== 'disabled',
      ).length;
      const notInstalled =
        batch.observations.length > 0 && batch.observations.every(({ outcome }) => outcome === 'disabled');
      const truncation = truncated
        ? `Observed the first ${String(keys.length)} of ${String(desktop.jiraKeys.length)} linked Jira issues.`
        : null;
      yield* recordWorkFactRun({
        dbPath: input.dbPath,
        disabled: notInstalled,
        failed,
        machineId: input.machine.id,
        message: notInstalled ? JIRA_NOT_INSTALLED_MESSAGE : truncation,
        observed,
        ranAt: input.now(),
        sourceId: 'jira.issues',
      }).pipe(Effect.mapError((cause) => sourceFailure('jira.issues', cause)));
      return {
        changed: false,
        inputCount: keys.length,
        outputCount: batch.observations.length,
        warnings: [
          ...desktop.warnings,
          ...(truncation === null ? [] : [{ code: 'jira-issues-truncated', message: truncation }]),
        ],
      };
    }),
});

const harnessAdapter = (
  sourceId: 'claude.sessions' | 'codex.sessions' | 'opencode.sessions',
): Effect.Effect<HarnessAdapter, SourceRunError> => {
  const harness = sourceId.split('.')[0] as 'claude' | 'codex' | 'opencode';
  const adapter = selectedHarnessAdapters({ harness, includeCursor: true })[0];
  return adapter ? Effect.succeed(adapter) : Effect.fail(sourceFailure(sourceId, new Error('Missing harness adapter')));
};

export const createScheduledSourceRegistry = (
  options: SourceAdapterOptions = {},
): Effect.Effect<ReadonlyMap<CollectionSourceId, ScheduledSource>, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const machine = options.machine ?? (yield* ensureMachineConfig);
    const dbPath = options.dbPath ?? usageStorePath(storage.home);
    const candidates = resolvePathCandidates(storage);
    const detections = {
      claude: detectPathCandidates(storage, [...candidates.claude.projectsDir, ...candidates.claude.historyFile]),
      claudeDesktop: detectPathCandidates(storage, candidates.claude.desktopSessionsDir),
      codex: detectPathCandidates(storage, [...candidates.codex.sessionsDir, ...candidates.codex.sessionIndexFile]),
      cursor: detectConfiguredCursorInputs(storage, options.configCwd),
      cursorAttribution: detectPathCandidates(storage, candidates.cursor.aiTrackingDb),
      opencode: detectPathCandidates(storage, [...candidates.opencode.liveDb, ...candidates.opencode.stableDb]),
      rtk: detectPathCandidates(storage, candidates.rtk.historyDb),
    };
    const quotaDetection = Effect.gen(function* () {
      const rollout = yield* detections.codex;
      const liveAvailable = options.codexLiveAvailable?.() ?? Bun.which('codex') !== null;
      return liveAvailable || rollout.availability === 'detected' ? detected() : notDetected();
    });
    // The binary AND a local Claude home. Presence of the executable alone is not enough: opening a
    // session against a profile that has never run Claude spawns a process that waits on an onboarding
    // prompt, so a bare `which` would have every isolated environment stall for the whole timeout.
    // Whether that session then carries plan limits still cannot be known until it is open, and the
    // source already handles that by recording a window-less observation.
    const claudeQuotaDetection = Effect.gen(function* () {
      const history = yield* detections.claude;
      const liveAvailable = options.claudeLiveAvailable?.() ?? Bun.which('claude') !== null;
      return liveAvailable && history.availability === 'detected' ? detected() : notDetected();
    });
    // At least one harness CLI on the PATH. Only metadata commands run, so no local history is
    // required: an installed but never-used CLI is still a fact worth recording.
    const executorDetection = Effect.sync(() => {
      const which = options.executorObservation?.which ?? ((command: string) => Bun.which(command));
      return which('claude') !== null || which('codex') !== null ? detected() : notDetected();
    });
    const checkoutStatusDetection = Effect.sync(() =>
      (options.gitAvailable?.() ?? Bun.which('git') !== null)
        ? detected()
        : notDetected('git was not found on PATH, so checkouts cannot be observed.'),
    );
    // The executable is the input; credentials are not. Signing in is an outcome the run records
    // (`unauthenticated`), never a reason to call the source undetected. A malformed `github`
    // section is a misconfiguration, as a malformed Cursor section is.
    const pullRequestDetection = Effect.gen(function* () {
      if (!(options.ghAvailable?.() ?? Bun.which('gh') !== null)) {
        return notDetected('The GitHub CLI (gh) was not found on PATH, so pull requests cannot be observed.');
      }
      // A config file that fails validation throws inside the reader, so only an exit sees it.
      const config = yield* Effect.exit(
        readMergedAiUsageConfigFrom(options.configCwd).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      return Exit.isFailure(config) ? misconfigured() : detected();
    });
    // Same rule for Jira (ADR 0054): the Atlassian CLI is the input, its sign-in is an outcome.
    const jiraIssueDetection = Effect.gen(function* () {
      if (!(options.acliAvailable?.() ?? Bun.which('acli') !== null)) {
        return notDetected('The Atlassian CLI (acli) was not found on PATH, so Jira issues cannot be observed.');
      }
      const config = yield* Effect.exit(
        readMergedAiUsageConfigFrom(options.configCwd).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      return Exit.isFailure(config) ? misconfigured() : detected();
    });
    const sources: ScheduledSource[] = [
      createSessionSource({
        adapter: () => harnessAdapter('claude.sessions'),
        dbPath,
        detect: detections.claude,
        id: 'claude.sessions',
        label: 'Claude sessions',
        machine,
        now: options.now ?? (() => new Date()),
        storage,
      }),
      createSessionSource({
        adapter: () => harnessAdapter('codex.sessions'),
        dbPath,
        detect: detections.codex,
        id: 'codex.sessions',
        label: 'Codex sessions',
        machine,
        now: options.now ?? (() => new Date()),
        storage,
      }),
      createSessionSource({
        adapter: () => harnessAdapter('opencode.sessions'),
        dbPath,
        detect: detections.opencode,
        id: 'opencode.sessions',
        label: 'OpenCode sessions',
        machine,
        now: options.now ?? (() => new Date()),
        storage,
      }),
      createSessionSource({
        adapter: () =>
          cursorOptions(storage, options.configCwd).pipe(
            Effect.flatMap((cursorCsv) => {
              const adapter = selectedHarnessAdapters({
                harness: 'cursor',
                includeCursor: true,
                ...(cursorCsv === undefined ? {} : { cursorCsv }),
              })[0];
              return adapter
                ? Effect.succeed(adapter)
                : Effect.fail(sourceFailure('cursor.sessions', new Error('Missing Cursor adapter')));
            }),
          ),
        dbPath,
        detect: detections.cursor,
        id: 'cursor.sessions',
        label: 'Cursor sessions',
        machine,
        now: options.now ?? (() => new Date()),
        storage,
      }),
      createProviderQuotaSource({
        dbPath,
        detect: quotaDetection,
        id: 'codex.usage-limits',
        machine,
        options,
        storage,
      }),
      createProviderQuotaSource({
        dbPath,
        detect: claudeQuotaDetection,
        id: 'claude.usage-limits',
        machine,
        options,
        quotaOptions: {
          // No Claude quota history exists locally, so there is nothing to backfill.
          backfillSource: null,
          identity: CLAUDE_QUOTA_SOURCE_IDENTITY,
          liveSource: createClaudeAgentSdkBatchSource(),
        },
        storage,
      }),
      createRtkSource({
        dbPath,
        detect: detections.rtk,
        machine,
        storage,
      }),
      createCursorAttributionSource({
        dbPath,
        detect: detections.cursorAttribution,
        machine,
        storage,
      }),
      createExecutorCapabilitiesSource({
        dbPath,
        detect: executorDetection,
        machine,
        now: options.now ?? (() => new Date()),
        observation: options.executorObservation,
      }),
      createCheckoutStatusSource({
        dbPath,
        detect: checkoutStatusDetection,
        machine,
        now: options.now ?? (() => new Date()),
        options,
      }),
      createPullRequestSource({
        dbPath,
        detect: pullRequestDetection,
        machine,
        now: options.now ?? (() => new Date()),
        options,
        storage,
      }),
      createJiraIssueSource({
        dbPath,
        detect: jiraIssueDetection,
        machine,
        now: options.now ?? (() => new Date()),
        options,
        storage,
      }),
      createClaudeDesktopSessionSource({
        dbPath,
        detect: detections.claudeDesktop,
        machine,
        now: options.now ?? (() => new Date()),
        storage,
      }),
    ];
    const registry = new Map(sources.map((source) => [source.id, source] as const));
    if (
      registry.size !== collectionSourceDefinitions.length ||
      collectionSourceDefinitions.some(({ id }) => !registry.has(id))
    ) {
      return yield* Effect.die(new Error('The scheduled source registry does not match the source catalogue.'));
    }
    return registry;
  });

export const noSourceProgress: SourceRunContext['reportProgress'] = () => Effect.void;
