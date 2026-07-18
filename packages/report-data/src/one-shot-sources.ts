import {
  ensureMachineConfig,
  readAiUsageConfig,
  readMergedAiUsageConfigFrom,
} from '@ai-usage/local-collectors/machine-config';
import type { HarnessKey } from '@ai-usage/report-core/harness-metadata';
import type { UsageReportWarning } from '@ai-usage/report-core/report-data';
import {
  type CollectionSourceId,
  resolveSourceEnabled,
  type SourceDetectionResult,
  type SourcePolicyOverrides,
  type SourceRunResult,
  type SourceWarning,
} from '@ai-usage/report-core/source-control';
import { Effect } from 'effect';
import {
  createMergedUsageReport,
  createStoredUsageSnapshot,
  type LocalUsageSnapshotRequest,
  listProjectSourcesWithWarnings,
  type MergedUsageReportRequest,
  type ProjectSourcesRequest,
} from './index';
import { queryLatestLocalProviderQuotas } from './provider-quota';
import {
  createScheduledSourceRegistry,
  noSourceProgress,
  type ScheduledSource,
  type SourceAdapterOptions,
} from './source-adapters';

export interface OneShotLocalSelection {
  readonly harness: HarnessKey | null;
  readonly includeCursor: boolean;
}

export type OneShotSourceStatus = 'success' | 'warning' | 'failed' | 'paused' | 'unavailable';

export interface OneShotSourceOutcome {
  readonly detection?: SourceDetectionResult;
  readonly result?: SourceRunResult;
  readonly sourceId: CollectionSourceId;
  readonly status: OneShotSourceStatus;
  readonly warnings: readonly SourceWarning[];
}

export interface OneShotExecutionResult {
  readonly changed: boolean;
  readonly outcomes: readonly OneShotSourceOutcome[];
  readonly warnings: readonly SourceWarning[];
}

export interface ExecuteOneShotSourcesInput {
  readonly policies?: SourcePolicyOverrides;
  readonly sourceIds: readonly CollectionSourceId[];
  readonly sources: ReadonlyMap<CollectionSourceId, ScheduledSource>;
}

export interface RunOneShotLocalSourcesInput extends OneShotLocalSelection {
  readonly adapterOptions?: SourceAdapterOptions;
  readonly configCwd?: string;
}

export interface FreshLocalMergedUsageReportRequest extends MergedUsageReportRequest {
  readonly includeLocal?: boolean;
}

export interface FreshLocalProjectSourcesRequest extends ProjectSourcesRequest {
  readonly includeLocal?: boolean;
}

const harnessSourceIds: Record<HarnessKey, CollectionSourceId> = {
  claude: 'claude.sessions',
  codex: 'codex.sessions',
  cursor: 'cursor.sessions',
  opencode: 'opencode.sessions',
};

const statusForResult = (result: SourceRunResult): OneShotSourceStatus => {
  if (result.unavailable) {
    return 'unavailable';
  }
  return result.warnings.length > 0 ? 'warning' : 'success';
};

export const localOneShotSourceIds = (selection: OneShotLocalSelection): readonly CollectionSourceId[] => {
  const sessionSources = selection.harness
    ? [harnessSourceIds[selection.harness]]
    : ([
        'claude.sessions',
        'codex.sessions',
        'opencode.sessions',
        ...(selection.includeCursor ? ['cursor.sessions' as const] : []),
      ] satisfies CollectionSourceId[]);
  const selectedSessions = sessionSources.filter(
    (sourceId) => selection.includeCursor || sourceId !== 'cursor.sessions',
  );
  return [
    ...selectedSessions,
    ...(selectedSessions.length > 0 ? (['rtk.savings'] as const) : []),
    ...(selection.includeCursor && (!selection.harness || selection.harness === 'cursor')
      ? (['cursor.commit-attribution'] as const)
      : []),
  ];
};

export const executeOneShotSources = (input: ExecuteOneShotSourcesInput): Effect.Effect<OneShotExecutionResult> =>
  Effect.gen(function* () {
    const outcomes: OneShotSourceOutcome[] = [];
    for (const sourceId of input.sourceIds) {
      const source = input.sources.get(sourceId);
      if (!source) {
        outcomes.push({
          sourceId,
          status: 'unavailable',
          warnings: [{ code: 'missing-adapter', message: 'The source adapter is unavailable.' }],
        });
        continue;
      }
      if (!resolveSourceEnabled(sourceId, input.policies)) {
        outcomes.push({
          sourceId,
          status: 'paused',
          warnings: [{ code: 'policy-disabled', message: 'The source is paused by user policy.' }],
        });
        continue;
      }
      const detection = yield* source.detect;
      if (detection.availability !== 'detected') {
        outcomes.push({ detection, sourceId, status: 'unavailable', warnings: [] });
        continue;
      }
      const result = yield* source.run({ reportProgress: noSourceProgress }).pipe(
        Effect.match({
          onFailure: () => undefined,
          onSuccess: (value) => value,
        }),
      );
      if (!result) {
        outcomes.push({
          detection,
          sourceId,
          status: 'failed',
          warnings: [{ code: 'run-failed', message: 'The source run failed; stored history was preserved.' }],
        });
        continue;
      }
      outcomes.push({
        detection,
        result,
        sourceId,
        status: statusForResult(result),
        warnings: result.warnings,
      });
    }
    return {
      changed: outcomes.some(({ result }) => result?.changed === true),
      outcomes,
      warnings: outcomes.flatMap(({ warnings }) => warnings),
    };
  });

export const runOneShotLocalSources = (input: RunOneShotLocalSourcesInput) =>
  Effect.gen(function* () {
    const configCwd = input.configCwd ?? input.adapterOptions?.configCwd;
    const config = yield* readMergedAiUsageConfigFrom(configCwd);
    const sources = yield* createScheduledSourceRegistry({
      ...input.adapterOptions,
      ...(configCwd === undefined ? {} : { configCwd }),
    });
    return yield* executeOneShotSources({
      sourceIds: localOneShotSourceIds(input),
      sources,
      ...(config.sourcePolicies === undefined ? {} : { policies: config.sourcePolicies }),
    });
  });

const oneShotUsageWarnings = (collection: OneShotExecutionResult): UsageReportWarning[] =>
  collection.outcomes.flatMap((outcome) =>
    outcome.warnings.map((warning) => {
      const harness = outcome.sourceId.split('.')[0];
      return {
        message: warning.message ?? 'The source reported a warning.',
        operation: outcome.sourceId,
        ...(harness === undefined ? {} : { harness }),
      };
    }),
  );

const collectFreshLocalSnapshot = (request: LocalUsageSnapshotRequest) =>
  Effect.gen(function* () {
    const collection = yield* runOneShotLocalSources({
      harness: request.harness,
      includeCursor: request.includeCursor,
      ...(request.configCwd === undefined ? {} : { configCwd: request.configCwd }),
      ...(request.machine === undefined ? {} : { adapterOptions: { machine: request.machine } }),
    });
    return yield* createStoredUsageSnapshot({
      ...request,
      warnings: oneShotUsageWarnings(collection),
    });
  });

export const createMergedUsageReportWithFreshLocal = (request: FreshLocalMergedUsageReportRequest) =>
  Effect.gen(function* () {
    if (!request.includeLocal) {
      return yield* createMergedUsageReport(request);
    }
    const snapshot = yield* collectFreshLocalSnapshot({
      harness: request.harness,
      includeCursor: request.includeCursor,
      ...(request.appVersion === undefined ? {} : { appVersion: request.appVersion }),
      ...(request.configCwd === undefined ? {} : { configCwd: request.configCwd }),
      ...(request.datasets === undefined ? {} : { datasets: request.datasets }),
      ...(request.generatedAt === undefined ? {} : { generatedAt: request.generatedAt }),
      ...(request.includeFacets === undefined ? {} : { includeFacets: request.includeFacets }),
      ...(request.machine === undefined ? {} : { machine: request.machine }),
    });
    return yield* createMergedUsageReport({
      ...request,
      localSnapshots: [...(request.localSnapshots ?? []), snapshot],
    });
  });

export const listProjectSourcesWithFreshLocalWarnings = (request: FreshLocalProjectSourcesRequest) =>
  Effect.gen(function* () {
    if (!request.includeLocal) {
      return yield* listProjectSourcesWithWarnings(request);
    }
    const snapshot = yield* collectFreshLocalSnapshot({
      harness: request.harness,
      includeCursor: request.includeCursor,
      ...(request.appVersion === undefined ? {} : { appVersion: request.appVersion }),
      ...(request.configCwd === undefined ? {} : { configCwd: request.configCwd }),
      ...(request.generatedAt === undefined ? {} : { generatedAt: request.generatedAt }),
      ...(request.machine === undefined ? {} : { machine: request.machine }),
    });
    return yield* listProjectSourcesWithWarnings({
      ...request,
      localSnapshots: [...(request.localSnapshots ?? []), snapshot],
    });
  });

export const runOneShotQuotaSource = (adapterOptions?: SourceAdapterOptions) =>
  Effect.gen(function* () {
    const config = yield* readAiUsageConfig;
    const sources = yield* createScheduledSourceRegistry(adapterOptions);
    return yield* executeOneShotSources({
      sourceIds: ['codex.usage-limits'],
      sources,
      ...(config.sourcePolicies === undefined ? {} : { policies: config.sourcePolicies }),
    });
  });

export const runOneShotQuotaAndReadLatest = (adapterOptions?: SourceAdapterOptions) =>
  Effect.gen(function* () {
    const collection = yield* runOneShotQuotaSource(adapterOptions);
    const machine = adapterOptions?.machine ?? (yield* ensureMachineConfig);
    const latest = yield* queryLatestLocalProviderQuotas({
      ...(adapterOptions?.dbPath === undefined ? {} : { dbPath: adapterOptions.dbPath }),
      machineId: machine.id,
      providerKey: 'codex',
    });
    return { collection, latest };
  });
