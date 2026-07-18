import path from 'node:path';
import {
  collectClaudeRetentionWarnings,
  type HarnessAdapter,
  selectedHarnessAdapters,
} from '@ai-usage/local-collectors/collectors';
import type { LocalHistoryError } from '@ai-usage/local-collectors/errors';
import { collectCursorCommitAttributionResult } from '@ai-usage/local-collectors/facets';
import {
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-collectors/local-history';
import { ensureMachineConfig, readMergedAiUsageConfigFrom } from '@ai-usage/local-collectors/machine-config';
import { firstExisting, resolvePathCandidates } from '@ai-usage/local-collectors/platform-paths';
import {
  type CollectorRow,
  enrichCollectorRowsWithRtkSavingsResult,
  stripProjectPath,
} from '@ai-usage/local-collectors/rtk-enrichment';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type {
  CollectionSourceId,
  SourceDetectionResult,
  SourceProgress,
  SourceRunResult,
  SourceWarning,
} from '@ai-usage/report-core/source-control';
import {
  collectionSourceDefinitions,
  getCollectionSourceDefinition,
  sourceControlBounds,
} from '@ai-usage/report-core/source-control';
import {
  importLocalRows,
  queryEnrichableUsageRows,
  queryUsageStoreGeneration,
  type RtkSavingsContribution,
  upsertRtkSavingsContributions,
  usageStorePath,
} from '@ai-usage/usage-store';
import { Data, Duration, Effect } from 'effect';
import { persistCursorCommitAttribution } from './index';
import type { ProviderQuotaRuntimeOptions } from './provider-quota';
import { refreshLocalProviderQuotas } from './provider-quota';

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

export interface SourceAdapterOptions {
  readonly codexLiveAvailable?: () => boolean;
  readonly configCwd?: string;
  readonly dbPath?: string;
  readonly machine?: UsageMachine;
  readonly now?: () => Date;
  readonly providerQuotaOptions?: ProviderQuotaRuntimeOptions;
}

const warningCodeCharacters = /[^a-zA-Z0-9._-]/g;

const sanitizeWarnings = (label: string, warnings: readonly { operation?: string }[]): readonly SourceWarning[] =>
  warnings.slice(0, sourceControlBounds.maxWarningsPerSource).map((warning) => {
    const code = (warning.operation ?? 'collector-warning').replace(warningCodeCharacters, '-').slice(0, 64);
    return {
      code: code || 'collector-warning',
      message: `${label} completed with an incomplete or rejected local record.`,
    };
  });

const detected = (): SourceDetectionResult => ({
  availability: 'detected',
  reason: { code: 'none' },
});

const notDetected = (): SourceDetectionResult => ({
  availability: 'not-detected',
  reason: { code: 'input-missing', message: 'No supported local input was found.' },
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

const detectConfiguredCursorInputs = (
  storage: LocalHistoryStorageService,
  configCwd: string | undefined,
): Effect.Effect<SourceDetectionResult> =>
  readMergedAiUsageConfigFrom(configCwd).pipe(
    Effect.provideService(LocalHistoryStorage, storage),
    Effect.flatMap((config) => {
      const configuredPaths = [
        ...(config.cursor?.usageExportPaths ?? []).map((filePath) => resolveConfigPath(configCwd, filePath)),
        ...(config.cursor?.usageExportDir ? [resolveConfigPath(configCwd, config.cursor.usageExportDir)] : []),
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
  readMergedAiUsageConfigFrom(configCwd).pipe(
    Effect.provideService(LocalHistoryStorage, storage),
    Effect.map((config) =>
      config.cursor
        ? {
            ...config.cursor,
            ...(config.cursor.usageExportDir
              ? { usageExportDir: resolveConfigPath(configCwd, config.cursor.usageExportDir) }
              : {}),
            ...(config.cursor.usageExportPaths
              ? {
                  usageExportPaths: config.cursor.usageExportPaths.map((filePath) =>
                    resolveConfigPath(configCwd, filePath),
                  ),
                }
              : {}),
          }
        : undefined,
    ),
    Effect.mapError((cause) => sourceFailure('cursor.sessions', cause)),
  );

const collectHarness = (
  adapter: HarnessAdapter,
): Effect.Effect<
  { rows: CollectorRow[]; warnings: readonly { operation?: string }[] },
  unknown,
  LocalHistoryStorageService
> => {
  if (adapter.collectResult) {
    return adapter.collectResult;
  }
  return adapter.collect.pipe(Effect.map((rows) => ({ rows, warnings: [] })));
};

const createSessionSource = (input: {
  adapter: () => Effect.Effect<HarnessAdapter, SourceRunError>;
  dbPath: string;
  detect: Effect.Effect<SourceDetectionResult>;
  id: 'claude.sessions' | 'codex.sessions' | 'cursor.sessions' | 'opencode.sessions';
  label: string;
  machine: UsageMachine;
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
      const imported = yield* importLocalRows({
        dbPath: input.dbPath,
        machine: input.machine,
        rows,
      }).pipe(Effect.mapError((cause) => sourceFailure(input.id, cause)));
      const warnings = sanitizeWarnings(input.label, [...collection.warnings, ...retentionWarnings]);
      return {
        changed: imported.inserted > 0 || imported.updated > 0,
        inputCount: collection.rows.length,
        outputCount: rows.length,
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
        warnings: sanitizeWarnings('RTK savings', enriched.warnings),
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
        warnings: sanitizeWarnings('Cursor commit attribution', collection.warnings),
      };
    }),
});

const createProviderQuotaSource = (input: {
  dbPath: string;
  detect: Effect.Effect<SourceDetectionResult>;
  machine: UsageMachine;
  options: SourceAdapterOptions;
  storage: LocalHistoryStorageService;
}): ScheduledSource => ({
  cadence: Duration.millis(getCollectionSourceDefinition('codex.usage-limits').cadenceMs),
  detect: input.detect,
  id: 'codex.usage-limits',
  run: (context) =>
    Effect.gen(function* () {
      yield* reportProgress(context, { phase: 'reading' });
      const availability = yield* input.detect;
      if (availability.availability !== 'detected') {
        return sourceUnavailableResult();
      }
      const generationBefore = yield* queryUsageStoreGeneration({ dbPath: input.dbPath }).pipe(
        Effect.mapError((cause) => sourceFailure('codex.usage-limits', cause)),
      );
      const result = yield* refreshLocalProviderQuotas({
        dbPath: input.dbPath,
        machine: input.machine,
        options: {
          ...input.options.providerQuotaOptions,
          liveCadenceMs: 0,
          ...(input.options.now === undefined ? {} : { now: input.options.now }),
        },
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      }).pipe(
        Effect.provideService(LocalHistoryStorage, input.storage),
        Effect.mapError((cause) => sourceFailure('codex.usage-limits', cause)),
      );
      const generationAfter = yield* queryUsageStoreGeneration({ dbPath: input.dbPath }).pipe(
        Effect.mapError((cause) => sourceFailure('codex.usage-limits', cause)),
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
    const sources: ScheduledSource[] = [
      createSessionSource({
        adapter: () => harnessAdapter('claude.sessions'),
        dbPath,
        detect: detections.claude,
        id: 'claude.sessions',
        label: 'Claude sessions',
        machine,
        storage,
      }),
      createSessionSource({
        adapter: () => harnessAdapter('codex.sessions'),
        dbPath,
        detect: detections.codex,
        id: 'codex.sessions',
        label: 'Codex sessions',
        machine,
        storage,
      }),
      createSessionSource({
        adapter: () => harnessAdapter('opencode.sessions'),
        dbPath,
        detect: detections.opencode,
        id: 'opencode.sessions',
        label: 'OpenCode sessions',
        machine,
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
        storage,
      }),
      createProviderQuotaSource({
        dbPath,
        detect: quotaDetection,
        machine,
        options,
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
