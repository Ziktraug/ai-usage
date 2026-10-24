import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createClaudeAgentSdkBatchSource, normalizeCursorCommitAttributionItems } from '@ai-usage/local-collectors';
import { CHECKOUT_STATUS_DEFAULTS, observeCheckoutStatus } from '@ai-usage/local-collectors/checkout-status';
import { collectClaudeDesktopSessions } from '@ai-usage/local-collectors/claude-desktop-sessions';
import {
  collectClaudeRetentionWarnings,
  type HarnessAdapter,
  selectedHarnessAdapters,
} from '@ai-usage/local-collectors/collectors';
import { type BoundedRun, observeExecutors } from '@ai-usage/local-collectors/executor-observations';
import { collectCursorCommitAttributionResult } from '@ai-usage/local-collectors/facets';
import { discoverPullRequests } from '@ai-usage/local-collectors/github-pull-request-discovery';
import {
  GITHUB_PULL_REQUEST_DEFAULTS,
  observePullRequests,
  type PullRequestLink,
} from '@ai-usage/local-collectors/github-pull-requests';
import { discoverJiraIssues } from '@ai-usage/local-collectors/jira-issue-discovery';
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
import type { CodexWorkObservation } from '@ai-usage/report-core/codex-work-observation';
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
  parseWorkThreadLinkKey,
  sessionLinkKey,
  pullRequestLinkKey as workThreadPullRequestKey,
} from '@ai-usage/report-core/work-thread';
import {
  workThreadSeedsFromJiraIssues,
  workThreadSeedsFromPullRequests,
} from '@ai-usage/report-core/work-thread-seeds';
import {
  applyWorkThreadWaitObservations,
  attachDeclaredWorkThreadSessions,
  importCheckoutStatusObservations,
  importClaudeDesktopSessions,
  importCodexWorkObservations,
  importExecutorObservations,
  importJiraIssueObservations,
  importLocalRows,
  importNormalizedDatasetItems,
  importPullRequestObservations,
  importSkillObservations,
  MAX_CLAUDE_DESKTOP_SESSION_READ,
  MAX_CODEX_WORK_BATCH,
  MAX_WORK_FACT_QUERY_LIMIT,
  queryActiveWorkThreadLinks,
  queryClaudeDesktopSessions,
  queryCurrentServedLocalProjectSources,
  queryEnrichableUsageRows,
  queryLatestPullRequestObservations,
  queryServedSessionPullRequestLinks,
  queryUsageStoreGeneration,
  queryWorkThreadWaitCandidates,
  type RtkSavingsContribution,
  recordWorkFactRun,
  type ServedLocalProjectSource,
  seedWorkThreads,
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
    workObservations?: readonly CodexWorkObservation[];
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
      const importedWork = { changed: 0, rejected: 0 };
      const workObservations = collection.workObservations ?? [];
      const observedAt = input.now().toISOString();
      // The store bound applies to each transaction, not to the user's history. Empty snapshots
      // must also survive: they clear request evidence from an earlier parse of that session.
      for (let offset = 0; offset < workObservations.length; offset += MAX_CODEX_WORK_BATCH) {
        yield* abortIfRequested(context.signal);
        const batch = yield* importCodexWorkObservations({
          dbPath: input.dbPath,
          machineId: input.machine.id,
          observedAt,
          observations: workObservations.slice(offset, offset + MAX_CODEX_WORK_BATCH),
        }).pipe(Effect.mapError((cause) => sourceFailure(input.id, cause)));
        importedWork.changed += batch.changed;
        importedWork.rejected += batch.rejected;
      }
      if (importedWork.rejected > 0) {
        return yield* Effect.fail(
          sourceFailure(input.id, new Error(`Codex request import rejected ${importedWork.rejected} observations`)),
        );
      }
      const warnings = sanitizeSourceWarnings(input.label, [...collection.warnings, ...retentionWarnings]);
      return {
        changed:
          imported.inserted > 0 ||
          imported.updated > 0 ||
          importedObservations.inserted > 0 ||
          importedObservations.updated > 0 ||
          importedWork.changed > 0 ||
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
      // New or changed registry rows name checkouts and pull requests the two fact producers have
      // not observed yet: wake them once rather than leave the Work view without facts until
      // their cadence. Neither producer wakes anything, so this never chains.
      const changedRows = imported.inserted + imported.updated;
      return {
        changed: false,
        inputCount: collection.completeness.filesSeen,
        outputCount: imported.inserted + imported.updated + imported.unchanged,
        ...(changedRows > 0 ? { wake: ['checkouts.status', 'github.pull-requests', 'jira.issues'] as const } : {}),
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
  readonly declarations: readonly { readonly pullRequestKey: string; readonly sessionKey: string }[];
  readonly declarationsTruncated: boolean;
  /** Jira keys written in the sessions' branch names (ADR 0054), never read from titles or paths. */
  readonly jiraKeys: readonly string[];
  readonly links: readonly PullRequestLink[];
  readonly paths: readonly string[];
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

const NO_DESKTOP_WORK_FACT_INPUTS: DesktopWorkFactInputs = {
  declarations: [],
  declarationsTruncated: false,
  jiraKeys: [],
  links: [],
  paths: [],
  warnings: [],
};

const normalizedLinkKey = (link: PullRequestLink): string =>
  pullRequestLinkKey({
    host: link.host.trim().toLowerCase(),
    number: link.number,
    repository: link.repository.trim().toLowerCase(),
  });

/**
 * Leaves out the links whose latest stored observation already showed the pull request merged.
 * A merge is terminal: re-reading it every cadence for the fourteen days a session stays active
 * spends `gh` calls to learn nothing. Only a successful latest read counts; a failed read after a
 * merge, or no observation at all, keeps the link in the batch. A store that cannot be consulted
 * keeps every link and says so.
 */
const withoutMergedLinks = (
  dbPath: string,
  machineId: string,
  links: readonly PullRequestLink[],
): Effect.Effect<Pick<DesktopWorkFactInputs, 'links' | 'warnings'>> =>
  Effect.gen(function* () {
    const merged = new Set<string>();
    for (let start = 0; start < links.length; start += MAX_WORK_FACT_QUERY_LIMIT) {
      const { items } = yield* queryLatestPullRequestObservations({
        dbPath,
        limit: MAX_WORK_FACT_QUERY_LIMIT,
        links: links.slice(start, start + MAX_WORK_FACT_QUERY_LIMIT),
        machineId,
      });
      for (const { latest } of items) {
        if (latest.outcome === 'observed' && latest.state === 'MERGED') {
          merged.add(normalizedLinkKey({ host: latest.host, number: latest.number, repository: latest.repository }));
        }
      }
    }
    return { links: links.filter((link) => !merged.has(normalizedLinkKey(link))), warnings: [] };
  }).pipe(
    Effect.catchAll(() =>
      Effect.succeed({
        links,
        warnings: [
          {
            code: 'merged-links-unread',
            message:
              'Stored pull request observations could not be read; merged pull requests are re-observed this run.',
          },
        ],
      }),
    ),
  );

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
    Effect.flatMap(({ observations, skipped, truncated }) => {
      const paths: string[] = [];
      const declarations = new Map<string, { pullRequestKey: string; sessionKey: string }>();
      let declarationsTruncated = truncated || skipped > 0;
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
          const declaration = {
            pullRequestKey: workThreadPullRequestKey(link),
            sessionKey: sessionLinkKey({
              machineId: observation.machineId,
              harness: 'claude',
              sessionId: observation.cliSessionId,
            }),
          };
          if (
            parseWorkThreadLinkKey('pull-request', declaration.pullRequestKey) &&
            parseWorkThreadLinkKey('session', declaration.sessionKey)
          ) {
            declarations.set(JSON.stringify(declaration), declaration);
          } else {
            declarationsTruncated = true;
          }
          if (!seenLinks.has(key)) {
            seenLinks.add(key);
            links.push(link);
          }
        }
      }
      return withoutMergedLinks(input.dbPath, input.machineId, links).pipe(
        Effect.map(
          (open): DesktopWorkFactInputs => ({
            declarations: [...declarations.values()],
            declarationsTruncated,
            jiraKeys,
            links: open.links,
            paths,
            warnings: open.warnings,
          }),
        ),
      );
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
    github?.accounts?.find(
      (account) => account.host.toLowerCase() === link.host.toLowerCase() && account.owner.toLowerCase() === owner,
    )?.ghUser ?? null
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
      const candidates = [
        ...new Set([
          ...candidateCheckoutPaths([], input.machine.id, desktop.paths),
          ...candidateCheckoutPaths(served, input.machine.id, injected),
        ]),
      ];
      let paths = candidates;
      if (candidates.length > CHECKOUT_STATUS_DEFAULTS.maxPaths) {
        const probes = yield* Effect.forEach(
          candidates,
          (candidate) =>
            abortIfRequested(context.signal).pipe(
              Effect.zipRight(
                Effect.tryPromise({
                  try: async () => {
                    try {
                      await stat(candidate);
                      return { candidate, exists: true };
                    } catch (cause) {
                      if (
                        cause !== null &&
                        typeof cause === 'object' &&
                        'code' in cause &&
                        (cause.code === 'ENOENT' || cause.code === 'ENOTDIR')
                      ) {
                        return { candidate, exists: false };
                      }
                      throw cause;
                    }
                  },
                  catch: (cause) => sourceFailure('checkouts.status', cause),
                }),
              ),
            ),
          { concurrency: 8 },
        );
        paths = [...probes.filter(({ exists }) => exists), ...probes.filter(({ exists }) => !exists)].map(
          ({ candidate }) => candidate,
        );
      }
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
      const missing = batch.observations.filter(({ outcome }) => outcome === 'missing').length;
      const notRepositories = batch.observations.filter(({ outcome }) => outcome === 'not-a-repository').length;
      const truncation = batch.truncated
        ? `Observed the first ${String(batch.observations.length)} of ${String(paths.length)} candidate checkouts.`
        : null;
      const message =
        [
          truncation,
          missing === 0
            ? null
            : `${String(missing)} known ${missing === 1 ? 'path no longer exists' : 'paths no longer exist'}.`,
          notRepositories === 0
            ? null
            : `${String(notRepositories)} known ${notRepositories === 1 ? 'path is not a repository' : 'paths are not repositories'}.`,
        ]
          .filter(Boolean)
          .join(' ') || null;
      yield* recordWorkFactRun({
        dbPath: input.dbPath,
        disabled: false,
        failed: batch.observations.length - observed - missing - notRepositories,
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
        warnings: [
          ...desktop.warnings,
          ...(truncation === null ? [] : [{ code: 'checkouts-truncated', message: truncation }]),
        ],
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
        queryServedSessionPullRequestLinks({
          dbPath: input.dbPath,
          machineId: input.machine.id,
          now: input.now().getTime(),
        }),
        { links: [], declarations: [], truncated: false, revision: '', scannedRows: 0 },
      );
      const desktop = yield* desktopWorkFactInputs({
        dbPath: input.dbPath,
        machineId: input.machine.id,
        now: input.now,
      });
      const injected = input.options.workFactInputs?.linkedPullRequests
        ? yield* input.options.workFactInputs.linkedPullRequests()
        : [];
      const threadLinks = yield* servedInputsOrEmpty(
        'github.pull-requests',
        queryActiveWorkThreadLinks({
          dbPath: input.dbPath,
          machineId: input.machine.id,
          kind: 'pull-request',
          excludeObservedMerged: true,
          limit: GITHUB_PULL_REQUEST_DEFAULTS.maxLinks,
        }),
        { links: [], truncated: false },
      );
      const threadPullRequests = threadLinks.links.flatMap((link): PullRequestLink[] => {
        const parsed = parseWorkThreadLinkKey(link.kind, link.key);
        return parsed?.kind === 'pull-request' ? [parsed] : [];
      });
      // Store eligibility precedes its bound, so completed links cannot crowd out older pending links.
      // Operator-followed links precede session declarations and retain their account on discovery.
      const keyFor = (link: PullRequestLink): string =>
        pullRequestLinkKey({
          host: link.host.trim().toLowerCase(),
          number: link.number,
          repository: link.repository.trim().toLowerCase(),
        });
      const unique = new Map<string, { link: PullRequestLink; account: string | null }>();
      for (const link of [...threadPullRequests, ...desktop.links, ...served.links, ...injected]) {
        const candidate: PullRequestLink = { host: link.host, number: link.number, repository: link.repository };
        const key = keyFor(candidate);
        if (!unique.has(key)) {
          unique.set(key, { link: candidate, account: accountFor(config.github, candidate) });
        }
      }
      const accounts = new Map<string | null, string[]>();
      const routedOwners = new Set<string>();
      for (const account of config.github?.accounts ?? []) {
        const owner = account.owner.toLowerCase();
        // Match accountFor: only the first configured account for an owner can observe its PRs.
        if (account.host === 'github.com' && !routedOwners.has(owner)) {
          routedOwners.add(owner);
          accounts.set(account.ghUser, [...new Set([...(accounts.get(account.ghUser) ?? []), account.owner])]);
        }
      }
      if (accounts.size === 0) {
        accounts.set(null, []);
      }
      const discoveryWarnings: { code: string; message: string }[] = [];
      let discoveryFailures = 0;
      let discoveryTruncated = threadLinks.truncated || served.truncated;
      let discoveryUnauthenticated = false;
      for (const [account, owners] of accounts) {
        yield* abortIfRequested(context.signal);
        const discovery = yield* discoverPullRequests({
          environment: ghEnvironment(),
          ...(account === null ? {} : { account: { ghUser: account }, owners }),
          ...(input.options.workFactProcessRunner === undefined ? {} : { run: input.options.workFactProcessRunner }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
        discoveryTruncated ||= discovery.truncated;
        discoveryUnauthenticated ||= discovery.outcome === 'unauthenticated';
        if (discovery.outcome !== 'observed') {
          discoveryFailures += 1;
          discoveryWarnings.push({
            code: `pull-request-discovery-${discovery.outcome}`,
            message: discovery.outcomeMessage ?? 'Pull request discovery failed.',
          });
        }
        for (const link of discovery.links) {
          const key = keyFor(link);
          const explicit = unique.get(key);
          if (explicit) {
            // Author takes precedence if multiple accounts discover the same pull request.
            const discoveryRole = explicit.link.discoveryRole === 'author' ? 'author' : link.discoveryRole;
            unique.set(key, { ...explicit, link: { ...explicit.link, discoveryRole } });
          } else {
            unique.set(key, { link, account });
          }
        }
      }
      const selected = [...unique.values()].slice(0, GITHUB_PULL_REQUEST_DEFAULTS.maxLinks);
      const links = selected.map(({ link }) => link);
      const truncated = unique.size > links.length || discoveryTruncated;
      const waits = yield* servedInputsOrEmpty(
        'github.pull-requests',
        queryWorkThreadWaitCandidates({
          dbPath: input.dbPath,
          machineId: input.machine.id,
          kind: 'pull-request-review',
          linkKeys: links.map(workThreadPullRequestKey),
        }),
        { candidates: [], truncated: false },
      );
      yield* reportProgress(context, { completed: 0, phase: 'reading', total: links.length });
      const byAccount = new Map<string | null, PullRequestLink[]>();
      for (const { link, account } of selected) {
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
      const waitResult =
        waits.candidates.length === 0
          ? { satisfied: 0, unchanged: 0, unproven: 0 }
          : yield* applyWorkThreadWaitObservations({
              dbPath: input.dbPath,
              machineId: input.machine.id,
              now: input.now().toISOString(),
              candidates: waits.candidates,
              pullRequests: observations,
            }).pipe(Effect.mapError((cause) => sourceFailure('github.pull-requests', cause)));
      const waitWarnings = [
        ...(waits.truncated
          ? [
              {
                code: 'work-thread-waits-truncated',
                message: 'Some identified waits exceeded the bounded transition read and remain waiting.',
              },
            ]
          : []),
        ...(waitResult.unproven > 0
          ? [
              {
                code: 'pull-request-wait-unproven',
                message: `Stored observations cannot prove a new review decision for ${String(waitResult.unproven)} identified waits; they remain waiting.`,
              },
            ]
          : []),
      ];
      // A discovered pull request becomes a Work thread once; the store keys it by origin (plan 120).
      const pullRequestSeeds = workThreadSeedsFromPullRequests(observations);
      if (pullRequestSeeds.length > 0) {
        yield* seedWorkThreads({
          dbPath: input.dbPath,
          machineId: input.machine.id,
          now: input.now().toISOString(),
          seeds: pullRequestSeeds,
        }).pipe(Effect.mapError((cause) => sourceFailure('github.pull-requests', cause)));
      }
      const declarations = [
        ...new Map(
          [...desktop.declarations, ...served.declarations].map((declaration) => [
            JSON.stringify([declaration.pullRequestKey, declaration.sessionKey]),
            declaration,
          ]),
        ).values(),
      ];
      const attached =
        declarations.length === 0
          ? { truncated: false }
          : yield* attachDeclaredWorkThreadSessions({
              dbPath: input.dbPath,
              machineId: input.machine.id,
              now: input.now().toISOString(),
              declarations,
            }).pipe(Effect.mapError((cause) => sourceFailure('github.pull-requests', cause)));
      const declarationWarnings =
        attached.truncated || served.truncated || desktop.declarationsTruncated
          ? [
              {
                code: 'declared-sessions-truncated',
                message: 'Some declared session links could not be read or exceeded the read or attachment limits.',
              },
            ]
          : [];
      const observed = observations.filter(({ outcome }) => outcome === 'observed').length;
      const failed =
        discoveryFailures +
        observations.filter(({ outcome }) => outcome !== 'observed' && outcome !== 'disabled').length;
      const truncation = truncated
        ? `Observed ${String(links.length)} of ${String(unique.size)} candidate pull requests; additional search results may be omitted.`
        : null;
      const message =
        [
          truncation,
          ...discoveryWarnings.map((warning) => warning.message),
          ...waitWarnings.map((warning) => warning.message),
          ...declarationWarnings.map((warning) => warning.message),
        ]
          .filter(Boolean)
          .join(' ') || null;
      yield* recordWorkFactRun({
        dbPath: input.dbPath,
        disabled: false,
        failed,
        machineId: input.machine.id,
        message,
        observed,
        ranAt: input.now(),
        outcomeCode: discoveryUnauthenticated ? 'unauthenticated' : null,
        sourceId: 'github.pull-requests',
      }).pipe(Effect.mapError((cause) => sourceFailure('github.pull-requests', cause)));
      return {
        changed: false,
        inputCount: links.length,
        outputCount: observations.length,
        warnings: [
          ...desktop.warnings,
          ...discoveryWarnings,
          ...waitWarnings,
          ...declarationWarnings,
          ...(truncation === null ? [] : [{ code: 'pull-requests-truncated', message: truncation }]),
        ],
      };
    }),
});

/**
 * The Jira issue producer (ADR 0054): personal assigned-issue discovery joins explicit Desktop
 * branch keys before bounded issue reads through the operator's own CLI session. The run records itself
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
        if (availability.availability === 'not-detected') {
          yield* recordWorkFactRun({
            dbPath: input.dbPath,
            disabled: true,
            failed: 0,
            machineId: input.machine.id,
            message: JIRA_NOT_INSTALLED_MESSAGE,
            observed: 0,
            ranAt: input.now(),
            sourceId: 'jira.issues',
          }).pipe(Effect.mapError((cause) => sourceFailure('jira.issues', cause)));
        }
        return { ...sourceUnavailableResult(), unavailable: availability.reason };
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
      yield* abortIfRequested(context.signal);
      const discovery = yield* discoverJiraIssues({
        ...(input.options.workFactProcessRunner === undefined ? {} : { run: input.options.workFactProcessRunner }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      yield* abortIfRequested(context.signal);
      if (discovery.outcome === 'unavailable') {
        yield* recordWorkFactRun({
          dbPath: input.dbPath,
          disabled: true,
          failed: 0,
          machineId: input.machine.id,
          message: JIRA_NOT_INSTALLED_MESSAGE,
          observed: 0,
          ranAt: input.now(),
          sourceId: 'jira.issues',
        }).pipe(Effect.mapError((cause) => sourceFailure('jira.issues', cause)));
        return {
          changed: false,
          inputCount: 0,
          outputCount: 0,
          unavailable: { code: 'input-missing', message: JIRA_NOT_INSTALLED_MESSAGE },
          warnings: desktop.warnings,
        };
      }
      const discoveryWarnings =
        discovery.outcome === 'observed'
          ? []
          : [
              {
                code: `jira-discovery-${discovery.outcome}`,
                message: discovery.outcomeMessage ?? 'Jira issue discovery failed.',
              },
            ];
      const threadLinks = yield* servedInputsOrEmpty(
        'jira.issues',
        queryActiveWorkThreadLinks({
          dbPath: input.dbPath,
          machineId: input.machine.id,
          kind: 'jira-issue',
          jiraSite: 'default',
          limit: JIRA_ISSUE_DEFAULTS.maxKeys,
        }),
        { links: [], truncated: false },
      );
      const threadKeys = threadLinks.links.flatMap((link) => {
        const parsed = parseWorkThreadLinkKey(link.kind, link.key);
        // The current Jira observation authority is the CLI's default site only.
        return parsed?.kind === 'jira-issue' && parsed.site === 'default' ? [parsed.key] : [];
      });
      const candidates = [...new Set([...threadKeys, ...desktop.jiraKeys, ...discovery.keys])];
      const keys = candidates.slice(0, JIRA_ISSUE_DEFAULTS.maxKeys);
      const truncated = candidates.length > keys.length || discovery.truncated || threadLinks.truncated;
      const waits = yield* servedInputsOrEmpty(
        'jira.issues',
        queryWorkThreadWaitCandidates({
          dbPath: input.dbPath,
          machineId: input.machine.id,
          kind: 'jira-update',
          linkKeys: keys.map((key) => `jira:default/${key}`),
        }),
        { candidates: [], truncated: false },
      );
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
      const waitResult =
        waits.candidates.length === 0
          ? { satisfied: 0, unchanged: 0, unproven: 0 }
          : yield* applyWorkThreadWaitObservations({
              dbPath: input.dbPath,
              machineId: input.machine.id,
              now: input.now().toISOString(),
              candidates: waits.candidates,
              jiraIssues: batch.observations,
            }).pipe(Effect.mapError((cause) => sourceFailure('jira.issues', cause)));
      const waitWarnings = [
        ...(waits.truncated
          ? [
              {
                code: 'work-thread-waits-truncated',
                message: 'Some identified waits exceeded the bounded transition read and remain waiting.',
              },
            ]
          : []),
        ...(waitResult.unproven > 0
          ? [
              {
                code: 'jira-wait-unproven',
                message: `Stored observations cannot prove a status change for ${String(waitResult.unproven)} identified waits; they remain waiting.`,
              },
            ]
          : []),
      ];
      // Only assigned issues the discovery returned become threads; a key read from a branch name
      // stays a fact of the sessions that wrote it.
      const discoveredKeys = new Set(discovery.keys);
      const jiraSeeds = workThreadSeedsFromJiraIssues(
        batch.observations.filter((observation) => discoveredKeys.has(observation.key)),
      );
      if (jiraSeeds.length > 0) {
        yield* seedWorkThreads({
          dbPath: input.dbPath,
          machineId: input.machine.id,
          now: input.now().toISOString(),
          seeds: jiraSeeds,
        }).pipe(Effect.mapError((cause) => sourceFailure('jira.issues', cause)));
      }
      const observed = batch.observations.filter(({ outcome }) => outcome === 'observed').length;
      const failed =
        discoveryWarnings.length +
        batch.observations.filter(({ outcome }) => outcome !== 'observed' && outcome !== 'disabled').length;
      const notInstalled =
        batch.observations.length > 0 && batch.observations.every(({ outcome }) => outcome === 'disabled');
      const truncation = truncated
        ? `Observed ${String(keys.length)} of ${String(candidates.length)} candidate Jira issues; additional search results may be omitted.`
        : null;
      yield* recordWorkFactRun({
        dbPath: input.dbPath,
        disabled: notInstalled,
        failed,
        machineId: input.machine.id,
        message: notInstalled
          ? JIRA_NOT_INSTALLED_MESSAGE
          : [
              truncation,
              ...discoveryWarnings.map((warning) => warning.message),
              ...waitWarnings.map((warning) => warning.message),
            ]
              .filter(Boolean)
              .join(' ') || null,
        observed,
        ranAt: input.now(),
        outcomeCode: discovery.outcome === 'unauthenticated' ? 'unauthenticated' : null,
        sourceId: 'jira.issues',
      }).pipe(Effect.mapError((cause) => sourceFailure('jira.issues', cause)));
      return {
        changed: false,
        inputCount: keys.length,
        outputCount: batch.observations.length,
        ...(notInstalled ? { unavailable: { code: 'input-missing', message: JIRA_NOT_INSTALLED_MESSAGE } } : {}),
        warnings: [
          ...discoveryWarnings,
          ...desktop.warnings,
          ...waitWarnings,
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
      // Before the fact producers it feeds; the registry map keeps this order for the startup runs.
      createClaudeDesktopSessionSource({
        dbPath,
        detect: detections.claudeDesktop,
        machine,
        now: options.now ?? (() => new Date()),
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
