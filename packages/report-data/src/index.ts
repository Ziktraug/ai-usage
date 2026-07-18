import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  collectHarnessDatasetsResult,
  collectSelectedHarnessResults,
  collectSelectedHarnessRows,
  type HarnessSelection,
  mirrorDatasetsToLegacyFacets,
  normalizeCursorCommitAttributionItems,
  type SelectedHarnessCollectionResult,
} from '@ai-usage/local-collectors';
import { LocalHistoryError, type LocalHistoryWarning } from '@ai-usage/local-collectors/errors';
import { LocalHistoryStorage, LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { ensureMachineConfig, readMergedAiUsageConfigFrom } from '@ai-usage/local-collectors/machine-config';
import type { CursorCommitAttributionRow, ReportDatasets } from '@ai-usage/report-core/datasets';
import { type HarnessKey, harnessKeys } from '@ai-usage/report-core/harness-metadata';
import type { ProjectAliasEntry } from '@ai-usage/report-core/project-alias';
import {
  matchesProjectSourceSelector,
  type ProjectGroupConfig,
  type ProjectGroupingWarning,
  type ProjectSourceSelector,
  projectSourceId,
  projectSourceSelectorLabel,
} from '@ai-usage/report-core/project-group';
import { projectProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import {
  createProviderStatusDataset,
  mergeProviderStatusDatasets,
  parseProviderStatusDataset,
} from '@ai-usage/report-core/provider-status';
import type {
  PreparedUsageReport,
  ReportOptions,
  UsageReportPayload,
  UsageReportProjectGroup,
  UsageReportWarning,
} from '@ai-usage/report-core/report-data';
import {
  createUsageSnapshot,
  deserializeSnapshotRow,
  mergeUsageSnapshots,
  type SnapshotMergeWarning,
  type UsageMachine,
  type UsageSnapshot,
  usageSnapshotRowDedupeKey,
} from '@ai-usage/report-core/snapshot';
import type { Row, SourcedRow } from '@ai-usage/report-core/types';
import { usageRowLineDelta, usageRowPricedCost, usageRowTokenTotal } from '@ai-usage/report-core/usage-row';
import {
  importLocalRows,
  importNormalizedDatasetItems,
  queryLatestProviderQuotaObservations,
  queryNormalizedDatasetItems,
  queryReportRows,
  queryUsageStoreGeneration,
  type StoredSourceAuthority,
  usageStorePath,
} from '@ai-usage/usage-store';
import { Effect } from 'effect';
import { withPerfSpan } from './perf';
import { assembleReport, captureReport, type ReportAssemblyInput } from './report-assembly';

export type {
  ProviderQuotaRefreshInput,
  ProviderQuotaRefreshResult,
  QueryLocalProviderQuotaHistoryInput,
} from './provider-quota';
export { queryLocalProviderQuotaHistory, refreshLocalProviderQuotas } from './provider-quota';
export { captureReport, reportAssemblyInputFingerprint, reportCaptureFingerprint } from './report-assembly';

const GIT_CONFIG_LINE_SEPARATOR = /\r?\n/;
const GIT_REMOTE_HEADER_PATTERN = /^\s*\[remote\s+"([^"]+)"\]\s*$/;
const GIT_SECTION_HEADER_PATTERN = /^\s*\[[^\]]+\]\s*$/;
const GIT_REMOTE_URL_PATTERN = /^\s*url\s*=\s*(.+?)\s*$/;
const GITHUB_HTTPS_REPO_PATTERN = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/;
const GITHUB_SSH_REPO_PATTERN = /git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/;
const GITDIR_FILE_PATTERN = /^\s*gitdir:\s*(.+?)\s*$/i;
const METRIC_VALIDATION_MESSAGE_PATTERN = /^Rejected (\d+) malformed (.+) metric record\(s\)\.$/;
const CLAUDE_WORKTREE_PATH_SEGMENT = '/.claude/worktrees/';
const MAX_STABLE_REPORT_CAPTURE_ATTEMPTS = 3;

const canonicalJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) {
      sorted[key] = canonicalJsonValue(child);
    }
  }
  return sorted;
};

const fingerprintConfig = (config: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalJsonValue(config)))
    .digest('hex');

export interface LocalUsageSelection {
  configCwd?: string;
  harness: HarnessKey | null;
  includeCursor: boolean;
}

export interface LocalReportRowsRequest extends LocalUsageSelection {
  keepSource?: boolean;
}

export interface ReportDatasetSelection {
  includeCursorCommitAttribution?: boolean;
  includeProviderStatus?: boolean;
}

export interface PersistCursorCommitAttributionInput {
  dbPath: string;
  importedAt?: Date;
  machineId: string;
  rows: readonly CursorCommitAttributionRow[];
}

export interface ReadStoredCursorCommitAttributionInput {
  dbPath: string;
  machineId?: string;
  maximumItems?: number;
}

export const persistCursorCommitAttribution = (input: PersistCursorCommitAttributionInput) =>
  importNormalizedDatasetItems({
    dbPath: input.dbPath,
    items: normalizeCursorCommitAttributionItems(input.machineId, input.rows),
    ...(input.importedAt === undefined ? {} : { importedAt: input.importedAt }),
  });

export const readStoredCursorCommitAttribution = (input: ReadStoredCursorCommitAttributionInput) =>
  queryNormalizedDatasetItems({
    datasetKey: 'cursor.commit-attribution',
    dbPath: input.dbPath,
    sourceId: 'cursor.commit-attribution',
    ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
    ...(input.maximumItems === undefined ? {} : { maximumItems: input.maximumItems }),
  }).pipe(
    Effect.map((result) => ({
      rows: result.items.map(({ payload }) => payload),
      skipped: result.skipped,
      truncated: result.truncated,
    })),
  );

export interface LocalReportPayloadRequest extends LocalReportRowsRequest {
  datasets?: ReportDatasetSelection;
  generatedAt?: Date;
  includeFacets?: boolean;
  options: ReportOptions;
}

export interface StoredReportPayloadRequest extends LocalUsageSelection {
  datasets?: ReportDatasetSelection;
  generatedAt?: Date;
  includeFacets?: boolean;
  options: ReportOptions;
}

export interface StoredReportSourceFingerprint {
  configFingerprint: string;
  usageStoreGeneration: number;
}

export interface LocalReportRowsResult {
  authorizedRows: AuthorizedSourceRow[];
  collection: SelectedHarnessCollectionResult;
  rows: SourcedRow[];
  warnings: LocalHistoryWarning[];
}

export interface LocalUsageSnapshotRequest extends LocalUsageSelection {
  appVersion?: string | null;
  datasets?: ReportDatasetSelection;
  generatedAt?: Date;
  includeFacets?: boolean;
  machine?: UsageMachine;
}

export interface StoredUsageSnapshotRequest extends LocalUsageSnapshotRequest {
  warnings?: UsageReportWarning[];
}

export interface MergedUsageReportRequest extends LocalUsageSelection {
  appVersion?: string | null;
  datasets?: ReportDatasetSelection;
  generatedAt?: Date;
  includeFacets?: boolean;
  localSnapshots?: UsageSnapshot[];
  machine?: UsageMachine;
  options: ReportOptions;
  snapshots: UsageSnapshot[];
}

export interface MergedUsageReport {
  duplicatesDropped: number;
  payload: UsageReportPayload;
  report: PreparedUsageReport;
  rows: Row[];
  warnings: UsageReportWarning[];
}

export interface ProjectSource {
  gitRemote: string;
  harness: string;
  harnesses: string[];
  harnessKey: string;
  harnessKeys: string[];
  id: string;
  machine: string;
  machineId: string;
  project: string;
  sessions: number;
  sourcePath: string;
  tokens: number;
}

export interface ProjectSourcesResult {
  sources: ProjectSource[];
  warnings: SnapshotMergeWarning[];
}

export interface KnownLocalProjectSourcesRequest extends LocalUsageSelection {}

export interface KnownLocalProjectSourcesResult {
  projectGroups: UsageReportProjectGroup[];
  sources: ProjectSource[];
  warnings: (LocalHistoryWarning | UsageReportWarning)[];
}

export type ReadGitFile = (filePath: string) => string | null;

interface CanonicalProjectSource {
  project: string;
  sourcePath: string;
}

type SourceAuthority = 'local-observed' | 'portable-opaque';

interface AuthorizedSourceRow {
  authority: SourceAuthority;
  row: SourcedRow;
}

const authorizeRows = (rows: SourcedRow[], authority: SourceAuthority): AuthorizedSourceRow[] =>
  rows.map((row) => ({ authority, row }));

const authorizeStoredRows = (stored: {
  rows: SourcedRow[];
  sourceAuthorities: StoredSourceAuthority[];
}): AuthorizedSourceRow[] => {
  if (stored.rows.length !== stored.sourceAuthorities.length) {
    throw new Error('Stored report rows and source authorities must have the same length');
  }
  return stored.rows.map((row, index) => {
    const authority = stored.sourceAuthorities[index];
    if (!authority) {
      throw new Error(`Stored report row ${index} is missing its source authority`);
    }
    return { authority, row };
  });
};

type CanonicalProjectSourceResolver = (
  project: string,
  sourcePath: string,
  authority: SourceAuthority,
) => CanonicalProjectSource;

export interface ProjectSourcesRequest extends LocalUsageSelection {
  appVersion?: string | null;
  generatedAt?: Date;
  includeGitRemote?: boolean;
  localSnapshots?: UsageSnapshot[];
  machine?: UsageMachine;
  readGitFile?: ReadGitFile;
  snapshots: UsageSnapshot[];
}

const datasetSelectionFor = (request: {
  datasets?: ReportDatasetSelection;
  harness: HarnessKey | null;
  includeCursor: boolean;
  includeFacets?: boolean;
}): ReportDatasetSelection | undefined => {
  if (request.datasets) {
    return request.datasets;
  }
  if (!request.includeFacets) {
    return;
  }
  return {
    includeCursorCommitAttribution: request.includeCursor && (!request.harness || request.harness === 'cursor'),
    includeProviderStatus: true,
  };
};

const loadSelectedReportDatasets = (request: {
  datasets?: ReportDatasetSelection;
  harness: HarnessKey | null;
  includeCursor: boolean;
  includeFacets?: boolean;
  machine?: UsageMachine;
}) => {
  const selection = datasetSelectionFor(request);
  if (!selection) {
    return Effect.succeed({ datasets: undefined, warnings: [] as LocalHistoryWarning[] });
  }
  const datasetEffect = collectHarnessDatasetsResult({
    includeCursor: selection.includeCursorCommitAttribution === true,
    includeProviderStatus: selection.includeProviderStatus === true,
    ...(request.machine === undefined ? {} : { machineId: request.machine.id, machineLabel: request.machine.label }),
  });
  return Effect.map(datasetEffect, ({ datasets, warnings }) => ({
    datasets: Object.keys(datasets).length ? datasets : undefined,
    warnings,
  }));
};

const coalesceMetricValidationWarnings = (
  warnings: (LocalHistoryWarning | UsageReportWarning)[],
): (LocalHistoryWarning | UsageReportWarning)[] => {
  const metricCounts = new Map<string, number>();
  const otherWarnings: (LocalHistoryWarning | UsageReportWarning)[] = [];
  for (const warning of warnings) {
    const match =
      warning.operation === 'metricValidation' ? warning.message.match(METRIC_VALIDATION_MESSAGE_PATTERN) : null;
    const count = match?.[1] ? Number(match[1]) : Number.NaN;
    const messageHarness = match?.[2];
    if (!(warning.harness && messageHarness === warning.harness && Number.isSafeInteger(count) && count > 0)) {
      otherWarnings.push(warning);
      continue;
    }
    const combined = (metricCounts.get(warning.harness) ?? 0) + count;
    if (!Number.isSafeInteger(combined)) {
      otherWarnings.push(warning);
      continue;
    }
    metricCounts.set(warning.harness, combined);
  }
  return [
    ...otherWarnings,
    ...[...metricCounts.entries()].map(([harness, count]) => ({
      harness,
      operation: 'metricValidation',
      message: `Rejected ${count} malformed ${harness} metric record(s).`,
    })),
  ];
};

const mergeReportDatasets = (...datasets: (ReportDatasets | undefined)[]): ReportDatasets | undefined => {
  const merged: ReportDatasets = {};
  for (const dataset of datasets) {
    if (!dataset) {
      continue;
    }
    for (const [key, value] of Object.entries(dataset)) {
      if (key === 'providerStatus') {
        continue;
      }
      merged[key] = value;
    }
  }
  const providerStatus = mergeProviderStatusDatasets(
    datasets.map((dataset) => parseProviderStatusDataset(dataset?.providerStatus) ?? undefined),
  );
  if (providerStatus) {
    merged.providerStatus = providerStatus;
  }
  return Object.keys(merged).length ? merged : undefined;
};

const readStoredDatasets = (input: {
  dbPath: string;
  machine: UsageMachine;
  request: {
    datasets?: ReportDatasetSelection;
    harness: HarnessKey | null;
    includeCursor: boolean;
    includeFacets?: boolean;
  };
}) =>
  Effect.gen(function* () {
    const selection = datasetSelectionFor(input.request);
    const warnings: LocalHistoryWarning[] = [];
    const storedCursor = selection?.includeCursorCommitAttribution
      ? yield* readStoredCursorCommitAttribution({ dbPath: input.dbPath }).pipe(
          Effect.mapError(usageStoreLocalHistoryError('usageStore.queryNormalizedDatasetItems', input.dbPath)),
        )
      : undefined;
    if (storedCursor?.skipped) {
      warnings.push({
        harness: 'cursor',
        message: `Skipped ${storedCursor.skipped} invalid stored Cursor attribution item(s).`,
        operation: 'usageStore.queryNormalizedDatasetItems',
      });
    }
    if (storedCursor?.truncated) {
      warnings.push({
        harness: 'cursor',
        message: 'Stored Cursor attribution exceeded the bounded report read.',
        operation: 'usageStore.queryNormalizedDatasetItems',
      });
    }
    const storedCursorDataset = storedCursor?.rows.length ? { cursorCommitAttribution: storedCursor.rows } : undefined;
    const storedQuota = selection?.includeProviderStatus
      ? yield* queryLatestProviderQuotaObservations({
          dbPath: input.dbPath,
          machineId: input.machine.id,
        }).pipe(
          Effect.mapError(usageStoreLocalHistoryError('usageStore.queryLatestProviderQuotaObservations', input.dbPath)),
        )
      : undefined;
    const storedQuotaDataset = storedQuota?.observations.length
      ? {
          providerStatus: createProviderStatusDataset(
            storedQuota.observations.map(({ observation }) => projectProviderQuotaObservation(observation)),
          ),
        }
      : undefined;
    return {
      datasets: mergeReportDatasets(storedCursorDataset, storedQuotaDataset),
      warnings,
    };
  });

const toHarnessSelection = (
  request: LocalReportRowsRequest,
  cursorCsv: HarnessSelection['cursorCsv'],
): HarnessSelection => ({
  harness: request.harness,
  includeCursor: request.includeCursor,
  ...(request.keepSource === undefined ? {} : { keepSource: request.keepSource }),
  ...(cursorCsv ? { cursorCsv } : {}),
});

const resolveConfigPath = (configCwd: string | undefined, value: string) =>
  configCwd && !path.isAbsolute(value) ? path.resolve(configCwd, value) : value;

const resolveCursorConfig = (
  cursorCsv: HarnessSelection['cursorCsv'],
  configCwd: string | undefined,
): HarnessSelection['cursorCsv'] => {
  if (!cursorCsv) {
    return;
  }
  return {
    ...cursorCsv,
    ...(cursorCsv.usageExportDir ? { usageExportDir: resolveConfigPath(configCwd, cursorCsv.usageExportDir) } : {}),
    ...(cursorCsv.usageExportPaths
      ? { usageExportPaths: cursorCsv.usageExportPaths.map((filePath) => resolveConfigPath(configCwd, filePath)) }
      : {}),
  };
};

const collectConfiguredLocalRows = (request: LocalReportRowsRequest) =>
  Effect.gen(function* () {
    const config = yield* readMergedAiUsageConfigFrom(request.configCwd);
    const collectedRows = yield* collectSelectedHarnessRows(
      toHarnessSelection(request, resolveCursorConfig(config.cursor, request.configCwd)),
    );
    return { config, rows: collectedRows };
  });

const collectConfiguredLocalRowsWithWarnings = (request: LocalReportRowsRequest) =>
  Effect.gen(function* () {
    const config = yield* readMergedAiUsageConfigFrom(request.configCwd);
    const collection = yield* collectSelectedHarnessResults(
      toHarnessSelection(request, resolveCursorConfig(config.cursor, request.configCwd)),
    );
    return { config, collection };
  });

const usageStoreLocalHistoryError = (operation: string, dbPath: string) => (cause: unknown) =>
  new LocalHistoryError({ operation, path: dbPath, cause });

const selectedStoredHarnessKeys = (request: LocalUsageSelection): HarnessKey[] | undefined => {
  if (request.harness) {
    return [request.harness];
  }
  if (request.includeCursor) {
    return;
  }
  return harnessKeys.filter((key) => key !== 'cursor');
};

export type ProjectedRow = SourcedRow & {
  projectGroupId: string;
  projectSourceId: string;
  rawProject: string;
};

export interface ProjectedLocalReportRowsResult
  extends Omit<LocalReportRowsResult, 'authorizedRows' | 'rows' | 'warnings'> {
  rows: ProjectedRow[];
  warnings: (LocalHistoryWarning | UsageReportWarning)[];
}

interface ProjectProjection {
  projectGroups: UsageReportProjectGroup[];
  rows: ProjectedRow[];
  warnings: UsageReportWarning[];
}

export const collectLocalReportRows = (request: LocalReportRowsRequest) =>
  Effect.gen(function* () {
    const { rows } = yield* collectConfiguredLocalRows(request);
    return rows;
  });

export const collectLocalReportRowsWithWarnings = (
  request: LocalReportRowsRequest,
): Effect.Effect<
  LocalReportRowsResult,
  LocalHistoryError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  withPerfSpan(
    'aiUsage.report.collectRowsWithWarnings',
    Effect.gen(function* () {
      const storage = yield* LocalHistoryStorage;
      const machine = yield* ensureMachineConfig;
      const dbPath = usageStorePath(storage.home);
      const { collection } = yield* withPerfSpan(
        'aiUsage.report.collectConfiguredRows',
        collectConfiguredLocalRowsWithWarnings({ ...request, keepSource: true }),
        (result) => ({
          harnesses: result.collection.harnesses.length,
          rows: result.collection.rows.length,
          warnings: result.collection.warnings.length,
        }),
      );
      const rows = collection.rows;
      yield* withPerfSpan(
        'aiUsage.usageStore.importLocalRows',
        importLocalRows({ dbPath, machine, rows }).pipe(
          Effect.mapError(usageStoreLocalHistoryError('usageStore.importLocalRows', dbPath)),
        ),
        (result) => ({
          deleted: result.deleted,
          inserted: result.inserted,
          superseded: result.superseded,
          unchanged: result.unchanged,
          updated: result.updated,
          warnings: result.warnings,
        }),
      );
      const harnessKeys = selectedStoredHarnessKeys(request);
      const stored = yield* withPerfSpan(
        'aiUsage.usageStore.queryReportRows',
        queryReportRows({ dbPath, ...(harnessKeys === undefined ? {} : { harnessKeys }) }).pipe(
          Effect.mapError(usageStoreLocalHistoryError('usageStore.queryReportRows', dbPath)),
        ),
        (result) => ({ rows: result.rows.length }),
      );
      const harnesses = collection.harnesses.map((harness) => ({
        ...harness,
        rows: stored.rows.filter((row) => row.harness === harness.label),
      }));
      return {
        authorizedRows: authorizeStoredRows(stored),
        rows: stored.rows,
        warnings: collection.warnings,
        collection: { ...collection, rows: stored.rows, harnesses },
      };
    }),
    (result) => ({
      harnesses: result.collection.harnesses.length,
      rows: result.rows.length,
      warnings: result.warnings.length,
    }),
  );

export const collectProjectedLocalReportRowsWithWarnings = (
  request: LocalReportRowsRequest,
): Effect.Effect<
  ProjectedLocalReportRowsResult,
  LocalHistoryError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  withPerfSpan(
    'aiUsage.report.collectProjectedRowsWithWarnings',
    Effect.gen(function* () {
      const { authorizedRows, warnings, collection } = yield* collectLocalReportRowsWithWarnings({
        ...request,
        keepSource: true,
      });
      const config = yield* readMergedAiUsageConfigFrom(request.configCwd);
      const projection = yield* withPerfSpan(
        'aiUsage.report.projectGroups',
        Effect.sync(() =>
          buildProjectProjection(authorizedRows, config.projectGroups ?? [], config.projectAliases ?? []),
        ),
        (result) => ({
          groups: result.projectGroups.length,
          rows: result.rows.length,
          warnings: result.warnings.length,
        }),
      );
      return {
        collection,
        rows: projection.rows,
        warnings: [...warnings, ...projection.warnings],
      };
    }),
    (result) => ({
      rows: result.rows.length,
      warnings: result.warnings.length,
    }),
  );

const collectLocalReportAssemblyInput = (
  request: LocalReportPayloadRequest,
): Effect.Effect<
  ReportAssemblyInput<ProjectedRow>,
  LocalHistoryError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  withPerfSpan(
    'aiUsage.report.collectLocalAssemblyInput',
    Effect.gen(function* () {
      const { authorizedRows, warnings } = yield* collectLocalReportRowsWithWarnings(request);
      const machine = yield* ensureMachineConfig;
      const config = yield* readMergedAiUsageConfigFrom(request.configCwd);
      const projection = yield* withPerfSpan(
        'aiUsage.report.projectGroups',
        Effect.sync(() =>
          buildProjectProjection(authorizedRows, config.projectGroups ?? [], config.projectAliases ?? []),
        ),
        (result) => ({
          groups: result.projectGroups.length,
          rows: result.rows.length,
          warnings: result.warnings.length,
        }),
      );
      const datasetResult = yield* withPerfSpan(
        'aiUsage.report.collectDatasets',
        loadSelectedReportDatasets({ ...request, machine }),
        (result) => ({ datasets: result.datasets ? Object.keys(result.datasets).length : 0 }),
      );
      const { datasets } = datasetResult;
      const facets = request.includeFacets ? mirrorDatasetsToLegacyFacets(datasets) : undefined;
      return {
        configuredProjectGroups: config.projectGroups ?? [],
        datasets,
        facets,
        generatedAt: request.generatedAt ?? new Date(),
        options: request.options,
        projectGroups: projection.projectGroups,
        rows: projection.rows,
        warnings: coalesceMetricValidationWarnings([...warnings, ...datasetResult.warnings, ...projection.warnings]),
      };
    }),
    (input) => ({
      rows: input.rows.length,
      warnings: input.warnings.length,
    }),
  );

export type LocalReportCaptureResult =
  | { captureFingerprint: string; payload: UsageReportPayload; status: 'changed' }
  | { captureFingerprint: string; status: 'unchanged' };

export const createLocalReportCapture = (request: LocalReportPayloadRequest, currentCaptureFingerprint?: string) =>
  withPerfSpan(
    'aiUsage.report.createLocalCapture',
    Effect.gen(function* () {
      const input = yield* collectLocalReportAssemblyInput(request);
      const capture = captureReport(input, currentCaptureFingerprint);
      if (capture.status === 'unchanged') {
        return capture;
      }
      const payload = yield* withPerfSpan(
        'aiUsage.report.serializePayload',
        Effect.succeed(capture.result.payload),
        (assembledPayload) => ({
          rows: assembledPayload.rows.length,
          tableRows: assembledPayload.tableRows.length,
          warnings: assembledPayload.warnings?.length ?? 0,
        }),
      );
      return { captureFingerprint: capture.captureFingerprint, payload, status: 'changed' as const };
    }),
    (result) => ({ status: result.status }),
  );

export const createLocalReportPayload = (request: LocalReportPayloadRequest) =>
  createLocalReportCapture(request).pipe(
    Effect.map((result) => {
      if (result.status === 'unchanged') {
        throw new Error('A local report capture without a comparison fingerprint must contain a payload');
      }
      return result.payload;
    }),
  );

export const createStoredReportPayload = (
  request: StoredReportPayloadRequest,
): Effect.Effect<
  UsageReportPayload,
  LocalHistoryError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  withPerfSpan(
    'aiUsage.report.createStoredPayload',
    Effect.gen(function* () {
      const storage = yield* LocalHistoryStorage;
      const machine = yield* ensureMachineConfig;
      const dbPath = usageStorePath(storage.home);
      const harnessKeys = selectedStoredHarnessKeys(request);
      const stored = yield* withPerfSpan(
        'aiUsage.usageStore.queryStoredReportRows',
        queryReportRows({ dbPath, ...(harnessKeys === undefined ? {} : { harnessKeys }) }).pipe(
          Effect.mapError(usageStoreLocalHistoryError('usageStore.queryReportRows', dbPath)),
        ),
        (result) => ({ rows: result.rows.length }),
      );
      const config = yield* readMergedAiUsageConfigFrom(request.configCwd);
      const projection = yield* withPerfSpan(
        'aiUsage.report.projectStoredGroups',
        Effect.sync(() =>
          buildProjectProjection(authorizeStoredRows(stored), config.projectGroups ?? [], config.projectAliases ?? []),
        ),
        (result) => ({
          groups: result.projectGroups.length,
          rows: result.rows.length,
          warnings: result.warnings.length,
        }),
      );
      const datasetResult = yield* withPerfSpan(
        'aiUsage.report.readStoredDatasets',
        readStoredDatasets({ dbPath, machine, request }),
        (result) => ({ datasets: result.datasets ? Object.keys(result.datasets).length : 0 }),
      );
      const { datasets } = datasetResult;
      const facets = request.includeFacets ? mirrorDatasetsToLegacyFacets(datasets) : undefined;
      return yield* withPerfSpan(
        'aiUsage.report.serializeStoredPayload',
        Effect.sync(
          () =>
            assembleReport({
              configuredProjectGroups: config.projectGroups ?? [],
              datasets,
              facets,
              generatedAt: request.generatedAt ?? new Date(),
              options: request.options,
              projectGroups: projection.projectGroups,
              rows: projection.rows,
              warnings: [...datasetResult.warnings, ...projection.warnings],
            }).payload,
        ),
        (payload) => ({
          rows: payload.rows.length,
          tableRows: payload.tableRows.length,
        }),
      );
    }),
    (payload) => ({
      rows: payload.rows.length,
      tableRows: payload.tableRows.length,
    }),
  );

export const readStoredReportSourceFingerprint = (
  request: Pick<StoredReportPayloadRequest, 'configCwd'>,
): Effect.Effect<
  StoredReportSourceFingerprint,
  LocalHistoryError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const dbPath = usageStorePath(storage.home);
    const usageStoreGeneration = yield* queryUsageStoreGeneration({ dbPath }).pipe(
      Effect.mapError(usageStoreLocalHistoryError('usageStore.queryUsageStoreGeneration', dbPath)),
    );
    const config = yield* readMergedAiUsageConfigFrom(request.configCwd);
    return { configFingerprint: fingerprintConfig(config), usageStoreGeneration };
  });

export const createKnownLocalProjectSources = (
  request: KnownLocalProjectSourcesRequest,
): Effect.Effect<
  KnownLocalProjectSourcesResult,
  LocalHistoryError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  withPerfSpan(
    'aiUsage.report.knownLocalProjectSources',
    Effect.gen(function* () {
      const storage = yield* LocalHistoryStorage;
      const machine = yield* ensureMachineConfig;
      const dbPath = usageStorePath(storage.home);
      const harnessKeys = selectedStoredHarnessKeys(request);
      const queryLocalRows = () =>
        queryReportRows({
          dbPath,
          originMachineIds: [machine.id],
          sourceAuthorities: ['local-observed'],
          ...(harnessKeys === undefined ? {} : { harnessKeys }),
        }).pipe(Effect.mapError(usageStoreLocalHistoryError('usageStore.queryReportRows', dbPath)));

      const stored = yield* queryLocalRows();

      const config = yield* readMergedAiUsageConfigFrom(request.configCwd);
      const rows = stored.rows;
      const localCandidates = authorizeRows(rows, 'local-observed');
      const projection = buildProjectProjection(
        localCandidates,
        config.projectGroups ?? [],
        config.projectAliases ?? [],
      );
      return {
        projectGroups: projection.projectGroups,
        sources: collectProjectSources(localCandidates, false, defaultReadGitFile),
        warnings: projection.warnings,
      };
    }),
    (result) => ({
      groups: result.projectGroups.length,
      sources: result.sources.length,
      warnings: result.warnings.length,
    }),
  );

export const createLocalUsageSnapshot = (request: LocalUsageSnapshotRequest) =>
  Effect.gen(function* () {
    const machine = request.machine ?? (yield* ensureMachineConfig);
    const { collection } = yield* collectConfiguredLocalRowsWithWarnings({ ...request, keepSource: true });
    const datasetResult = yield* loadSelectedReportDatasets({ ...request, machine });
    const { datasets } = datasetResult;
    const facets = request.includeFacets ? mirrorDatasetsToLegacyFacets(datasets) : undefined;

    return createUsageSnapshot({
      machine,
      rows: collection.rows,
      ...(request.generatedAt === undefined ? {} : { generatedAt: request.generatedAt }),
      ...(request.appVersion === undefined ? {} : { appVersion: request.appVersion }),
      ...(collection.warnings.length || datasetResult.warnings.length
        ? { warnings: coalesceMetricValidationWarnings([...collection.warnings, ...datasetResult.warnings]) }
        : {}),
      ...(datasets === undefined ? {} : { datasets }),
      ...(facets === undefined ? {} : { facets }),
    });
  });

export const createStoredUsageSnapshot = (request: StoredUsageSnapshotRequest) =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const machine = request.machine ?? (yield* ensureMachineConfig);
    const dbPath = usageStorePath(storage.home);
    const harnessKeys = selectedStoredHarnessKeys(request);
    const stored = yield* queryReportRows({
      dbPath,
      originMachineIds: [machine.id],
      sourceAuthorities: ['local-observed'],
      ...(harnessKeys === undefined ? {} : { harnessKeys }),
    }).pipe(Effect.mapError(usageStoreLocalHistoryError('usageStore.queryReportRows', dbPath)));
    const datasetResult = yield* readStoredDatasets({ dbPath, machine, request });
    const datasets = datasetResult.datasets;
    const facets = request.includeFacets ? mirrorDatasetsToLegacyFacets(datasets) : undefined;
    const warnings = [...(request.warnings ?? []), ...datasetResult.warnings];
    return createUsageSnapshot({
      machine,
      rows: stored.rows,
      ...(request.generatedAt === undefined ? {} : { generatedAt: request.generatedAt }),
      ...(request.appVersion === undefined ? {} : { appVersion: request.appVersion }),
      ...(warnings.length ? { warnings } : {}),
      ...(datasets === undefined ? {} : { datasets }),
      ...(facets === undefined ? {} : { facets }),
    });
  });

const mergeAuthorizedSnapshotRows = (
  snapshots: Array<{ authority: SourceAuthority; snapshot: UsageSnapshot }>,
): AuthorizedSourceRow[] => {
  const winners = new Map<string, { candidate: AuthorizedSourceRow; generatedAt: number }>();
  for (const { authority, snapshot } of snapshots) {
    const generatedAt = new Date(snapshot.generatedAt).getTime();
    for (const serializedRow of snapshot.rows) {
      const key = usageSnapshotRowDedupeKey(serializedRow);
      const existing = winners.get(key);
      if (!existing || generatedAt >= existing.generatedAt) {
        winners.set(key, { candidate: { authority, row: deserializeSnapshotRow(serializedRow) }, generatedAt });
      }
    }
  }
  return [...winners.values()].map((winner) => winner.candidate);
};

const authorizeSnapshots = (
  snapshots: readonly UsageSnapshot[],
  localSnapshots: readonly UsageSnapshot[] = [],
): Array<{ authority: SourceAuthority; snapshot: UsageSnapshot }> => [
  ...snapshots.map((snapshot) => ({ authority: 'portable-opaque' as const, snapshot })),
  ...localSnapshots.map((snapshot) => ({ authority: 'local-observed' as const, snapshot })),
];

export const createMergedUsageReport = (request: MergedUsageReportRequest) =>
  Effect.gen(function* () {
    const authorizedSnapshots = authorizeSnapshots(request.snapshots, request.localSnapshots);

    const snapshots = authorizedSnapshots.map((candidate) => candidate.snapshot);
    const merged = mergeUsageSnapshots(snapshots);
    const authorizedRows = mergeAuthorizedSnapshotRows(authorizedSnapshots);
    const config = yield* readMergedAiUsageConfigFrom(request.configCwd);
    const projection = buildProjectProjection(authorizedRows, config.projectGroups ?? [], config.projectAliases ?? []);
    const allWarnings = [...merged.warnings, ...projection.warnings];
    const payloadWarnings = allWarnings.map((warning) => {
      if ('key' in warning) {
        const { key, ...payloadWarning } = warning;
        return {
          ...payloadWarning,
          message: key ? `${warning.message}: ${key}` : warning.message,
        };
      }
      return warning;
    });
    const datasets = mergeReportDatasets(merged.datasets);
    const facets = request.includeFacets ? mirrorDatasetsToLegacyFacets(datasets) : undefined;

    const assembly = assembleReport({
      configuredProjectGroups: config.projectGroups ?? [],
      datasets,
      facets,
      generatedAt: request.generatedAt ?? new Date(),
      options: request.options,
      projectGroups: projection.projectGroups,
      rows: projection.rows,
      warnings: payloadWarnings,
    });
    return {
      rows: assembly.rows,
      report: assembly.report,
      payload: assembly.payload,
      warnings: allWarnings,
      duplicatesDropped: merged.duplicatesDropped,
    };
  });

const projectFromRow = (row: SourcedRow) => row.project || path.basename(row.source.sourcePath ?? '') || '(unknown)';

const defaultReadGitFile: ReadGitFile = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
};

export const parseGitConfigRemote = (text: string, remoteName = 'origin'): string => {
  let inRemote = false;
  for (const line of text.split(GIT_CONFIG_LINE_SEPARATOR)) {
    const remoteMatch = line.match(GIT_REMOTE_HEADER_PATTERN);
    if (remoteMatch) {
      inRemote = remoteMatch[1] === remoteName;
      continue;
    }
    if (GIT_SECTION_HEADER_PATTERN.test(line)) {
      inRemote = false;
      continue;
    }
    if (!inRemote) {
      continue;
    }
    const urlMatch = line.match(GIT_REMOTE_URL_PATTERN);
    if (urlMatch) {
      return extractRepoName(urlMatch[1]!);
    }
  }
  return '';
};

const extractRepoName = (url: string): string => {
  const httpsMatch = url.match(GITHUB_HTTPS_REPO_PATTERN);
  if (httpsMatch) {
    return httpsMatch[1]!;
  }
  const sshMatch = url.match(GITHUB_SSH_REPO_PATTERN);
  if (sshMatch) {
    return sshMatch[1]!;
  }
  return url;
};

const resolveGitPath = (basePath: string, gitPath: string) =>
  path.isAbsolute(gitPath) ? path.normalize(gitPath) : path.resolve(basePath, gitPath);

const readGitdirFilePath = (projectPath: string, readGitFile: ReadGitFile): string | null => {
  const gitFilePath = path.join(projectPath, '.git');
  const text = readGitFile(gitFilePath);
  const gitdirMatch = text?.match(GITDIR_FILE_PATTERN);
  if (!gitdirMatch) {
    return null;
  }
  return resolveGitPath(projectPath, gitdirMatch[1]!);
};

const readCommonGitDir = (projectPath: string, readGitFile: ReadGitFile): string | null => {
  const gitdirPath = readGitdirFilePath(projectPath, readGitFile);
  if (!gitdirPath) {
    return null;
  }
  const commonDirText = readGitFile(path.join(gitdirPath, 'commondir'));
  if (commonDirText === null) {
    return null;
  }
  return resolveGitPath(gitdirPath, commonDirText.trim());
};

const mainWorktreePathFromCommonGitDir = (commonGitDir: string) =>
  path.basename(commonGitDir) === '.git' ? path.dirname(commonGitDir) : null;

const gitWorktreeParentPath = (projectPath: string, readGitFile: ReadGitFile): string | null => {
  const commonGitDir = readCommonGitDir(projectPath, readGitFile);
  return commonGitDir === null ? null : mainWorktreePathFromCommonGitDir(commonGitDir);
};

const managedWorktreeParentPath = (projectPath: string): string | null => {
  const normalizedPath = projectPath.replaceAll('\\', '/');
  const markerIndex = normalizedPath.indexOf(CLAUDE_WORKTREE_PATH_SEGMENT);
  return markerIndex > 0 ? normalizedPath.slice(0, markerIndex) : null;
};

const canonicalProjectSource = (
  project: string,
  sourcePath: string,
  authority: SourceAuthority,
  readGitFile: ReadGitFile,
) => {
  if (!sourcePath || authority === 'portable-opaque') {
    return { project, sourcePath };
  }
  const canonicalSourcePath = gitWorktreeParentPath(sourcePath, readGitFile) ?? managedWorktreeParentPath(sourcePath);
  if (!canonicalSourcePath) {
    return { project, sourcePath };
  }
  return {
    project: path.basename(canonicalSourcePath) || project,
    sourcePath: canonicalSourcePath,
  };
};

const createCanonicalProjectSourceResolver = (readGitFile: ReadGitFile): CanonicalProjectSourceResolver => {
  const cache = new Map<string, CanonicalProjectSource>();
  return (project, sourcePath, authority) => {
    const key = [project, sourcePath, authority].join('\0');
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }
    const canonicalSource = canonicalProjectSource(project, sourcePath, authority, readGitFile);
    cache.set(key, canonicalSource);
    return canonicalSource;
  };
};

const readGitRemoteUrl = (projectPath: string, readGitFile: ReadGitFile): string => {
  const text =
    readGitFile(path.join(projectPath, '.git', 'config')) ?? readGitRemoteFromWorktree(projectPath, readGitFile);
  return text === null ? '' : parseGitConfigRemote(text);
};

const readGitRemoteFromWorktree = (projectPath: string, readGitFile: ReadGitFile) => {
  const commonGitDir = readCommonGitDir(projectPath, readGitFile);
  return commonGitDir === null ? null : readGitFile(path.join(commonGitDir, 'config'));
};

const sourceInputFromRow = (
  row: SourcedRow,
  authority: SourceAuthority,
  resolveCanonicalProjectSource: CanonicalProjectSourceResolver,
) => {
  const project = projectFromRow(row);
  return {
    machineId: row.source.machineId ?? '',
    ...resolveCanonicalProjectSource(project, row.source.sourcePath ?? '', authority),
  };
};

const createProjectSourceFromRow = (
  row: SourcedRow,
  authority: SourceAuthority,
  resolveCanonicalProjectSource: CanonicalProjectSourceResolver,
): ProjectSource => {
  const source = sourceInputFromRow(row, authority, resolveCanonicalProjectSource);
  return {
    id: projectSourceId(source),
    project: source.project,
    machine: row.source.machineLabel ?? 'Unknown machine',
    machineId: row.source.machineId ?? '',
    harness: row.harness,
    harnessKey: row.source.harnessKey,
    harnesses: [row.harness],
    harnessKeys: [row.source.harnessKey],
    sourcePath: source.sourcePath,
    gitRemote: '',
    sessions: 0,
    tokens: 0,
  };
};

const collectProjectSources = (
  candidates: AuthorizedSourceRow[],
  includeGitRemote: boolean,
  readGitFile: ReadGitFile = defaultReadGitFile,
  resolveCanonicalProjectSource = createCanonicalProjectSourceResolver(readGitFile),
): ProjectSource[] => {
  const summaries = new Map<string, ProjectSource>();

  for (const { authority, row } of candidates) {
    const summary = createProjectSourceFromRow(row, authority, resolveCanonicalProjectSource);
    const key = summary.id;
    const current = summaries.get(key) ?? summary;
    current.sessions++;
    current.tokens += usageRowTokenTotal(row);
    if (!current.harnesses.includes(row.harness)) {
      current.harnesses.push(row.harness);
      current.harness = current.harnesses.join(', ');
    }
    if (!current.harnessKeys.includes(row.source.harnessKey)) {
      current.harnessKeys.push(row.source.harnessKey);
      current.harnessKey = current.harnessKeys.join(',');
    }
    if (includeGitRemote && authority === 'local-observed' && !current.gitRemote && current.sourcePath) {
      current.gitRemote = readGitRemoteUrl(current.sourcePath, readGitFile);
    }
    summaries.set(key, current);
  }

  const result = [...summaries.values()].sort(
    (a, b) =>
      a.project.localeCompare(b.project) || a.machine.localeCompare(b.machine) || a.harness.localeCompare(b.harness),
  );

  return result;
};

const escapeRegex = (value: string) => value.replace(/[.+^${}()|[\]\\]/g, '\\$&');

const globToRegex = (glob: string) => {
  const normalized = path.normalize(glob).replaceAll(path.sep, '/');
  const pattern = normalized
    .split('*')
    .map((part) => escapeRegex(part))
    .join('.*');
  return new RegExp(`^${pattern}$`, 'i');
};

const legacyAliasMatchesSource = (source: ProjectSource, alias: ProjectAliasEntry) =>
  alias.match.some((pattern) => {
    const regex = globToRegex(pattern);
    return [source.sourcePath, source.project].some((candidate) => candidate && regex.test(candidate));
  });

const sourceLabel = (source: ProjectSource) =>
  source.machine ? `${source.project} · ${source.machine}` : source.project;

const lineDeltaForRows = (rows: SourcedRow[]) =>
  rows.reduce(
    (total, row) => {
      const lineDelta = usageRowLineDelta(row);
      total.added += lineDelta.added;
      total.deleted += lineDelta.deleted;
      return total;
    },
    { added: 0, deleted: 0 },
  );

const createReportProjectGroup = (
  id: string,
  name: string,
  grouped: boolean,
  sources: ProjectSource[],
  rows: SourcedRow[],
): UsageReportProjectGroup => {
  const lineDelta = lineDeltaForRows(rows);
  return {
    id,
    name,
    grouped,
    sources: sources.map((source) => ({
      gitRemote: source.gitRemote,
      id: source.id,
      machineId: source.machineId,
      machineLabel: source.machine,
      project: source.project,
      sessions: source.sessions,
      sourcePath: source.sourcePath,
      tokens: source.tokens,
    })),
    sessions: rows.length,
    tokens: rows.reduce((total, row) => total + usageRowTokenTotal(row), 0),
    fresh: rows.reduce((total, row) => total + row.tokIn + row.tokOut + row.tokCw, 0),
    cache: rows.reduce((total, row) => total + row.tokCr, 0),
    cost: rows.reduce((total, row) => total + (usageRowPricedCost(row) ?? 0), 0),
    priced: rows.filter((row) => usageRowPricedCost(row) !== null).length,
    linesAdded: lineDelta.added,
    linesDeleted: lineDelta.deleted,
    turns: rows.reduce((total, row) => total + row.turns, 0),
    tools: rows.reduce((total, row) => total + row.tools, 0),
  };
};

const projectGroupingWarning = (
  reason: ProjectGroupingWarning['reason'],
  message: string,
  group?: Pick<ProjectGroupConfig, 'id' | 'name'>,
  selectors?: ProjectSourceSelector[],
): UsageReportWarning => ({
  operation: 'projectGrouping',
  reason,
  message,
  ...(group === undefined ? {} : { groupId: group.id, groupName: group.name }),
  ...(selectors === undefined ? {} : { selectors }),
});

const buildProjectProjection = (
  candidates: AuthorizedSourceRow[],
  groups: ProjectGroupConfig[] = [],
  legacyAliases: ProjectAliasEntry[] = [],
): ProjectProjection => {
  const resolveCanonicalProjectSource = createCanonicalProjectSourceResolver(defaultReadGitFile);
  const sources = collectProjectSources(candidates, false, defaultReadGitFile, resolveCanonicalProjectSource);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const rowsBySourceId = new Map<string, SourcedRow[]>();
  for (const { authority, row } of candidates) {
    const sourceId = projectSourceId(sourceInputFromRow(row, authority, resolveCanonicalProjectSource));
    const sourceRows = rowsBySourceId.get(sourceId) ?? [];
    sourceRows.push(row);
    rowsBySourceId.set(sourceId, sourceRows);
  }

  const warnings: UsageReportWarning[] = [];
  const sourceGroupName = new Map<string, { groupId: string; name: string }>();
  const projectGroups: UsageReportProjectGroup[] = [];

  for (const group of groups) {
    const matchedSourceIds = new Set<string>();
    const unmatchedSelectors: ProjectSourceSelector[] = [];
    for (const selector of group.sources) {
      const matched = sources.filter((source) =>
        matchesProjectSourceSelector(
          {
            machineId: source.machineId,
            project: source.project,
            sourcePath: source.sourcePath,
            gitRemote: source.gitRemote,
          },
          selector,
        ),
      );
      if (!matched.length) {
        unmatchedSelectors.push(selector);
        continue;
      }
      if (matched.length > 1) {
        warnings.push(
          projectGroupingWarning(
            'broad-selector',
            `Project group "${group.name}" selector matched ${matched.length} sources: ${projectSourceSelectorLabel(selector)}`,
            group,
          ),
        );
      }
      for (const source of matched) {
        matchedSourceIds.add(source.id);
      }
    }

    if (!matchedSourceIds.size) {
      warnings.push(
        projectGroupingWarning('unmatched-group', `Project group "${group.name}" matches no sources.`, group, [
          ...group.sources,
        ]),
      );
      continue;
    }
    if (unmatchedSelectors.length) {
      const unmatchedLabels = unmatchedSelectors.map(projectSourceSelectorLabel);
      warnings.push(
        projectGroupingWarning(
          'partial-group',
          `Project group "${group.name}" has unmatched selectors: ${unmatchedLabels.join('; ')}`,
          group,
          unmatchedSelectors,
        ),
      );
    }

    const matchedSources = [...matchedSourceIds].flatMap((id) => {
      const source = sourceById.get(id);
      return source ? [source] : [];
    });
    const groupRows = [...matchedSourceIds].flatMap((id) => rowsBySourceId.get(id) ?? []);
    const groupId = `group:${group.id}`;
    projectGroups.push(createReportProjectGroup(groupId, group.name, true, matchedSources, groupRows));
    for (const id of matchedSourceIds) {
      sourceGroupName.set(id, { groupId, name: group.name });
    }
  }

  for (const alias of legacyAliases) {
    const matchedSources = sources.filter(
      (source) => !sourceGroupName.has(source.id) && legacyAliasMatchesSource(source, alias),
    );
    if (!matchedSources.length) {
      continue;
    }
    const groupId = `legacy-alias:${alias.name}`;
    const groupRows = matchedSources.flatMap((source) => rowsBySourceId.get(source.id) ?? []);
    warnings.push(
      projectGroupingWarning(
        'legacy-alias',
        `Legacy project alias "${alias.name}" was applied as a report-time project group.`,
        { id: alias.name, name: alias.name },
      ),
    );
    projectGroups.push(createReportProjectGroup(groupId, alias.name, true, matchedSources, groupRows));
    for (const source of matchedSources) {
      sourceGroupName.set(source.id, { groupId, name: alias.name });
    }
  }

  for (const source of sources) {
    if (sourceGroupName.has(source.id)) {
      continue;
    }
    const groupId = `source:${source.id}`;
    const groupName = sourceLabel(source);
    projectGroups.push(
      createReportProjectGroup(groupId, groupName, false, [source], rowsBySourceId.get(source.id) ?? []),
    );
    sourceGroupName.set(source.id, { groupId, name: groupName });
  }

  const projectedRows = candidates.map(({ authority, row }) => {
    const rawProject = row.project;
    const projectSourceIdValue = projectSourceId(sourceInputFromRow(row, authority, resolveCanonicalProjectSource));
    const group = sourceGroupName.get(projectSourceIdValue) ?? {
      groupId: `source:${projectSourceIdValue}`,
      name: projectFromRow(row),
    };
    return {
      ...row,
      rawProject,
      project: group.name,
      projectGroupId: group.groupId,
      projectSourceId: projectSourceIdValue,
    };
  });

  return {
    rows: projectedRows,
    projectGroups: projectGroups.sort((a, b) => b.cost - a.cost || b.fresh - a.fresh),
    warnings,
  };
};

export const listProjectSourcesWithWarnings = (
  request: ProjectSourcesRequest,
): Effect.Effect<
  ProjectSourcesResult,
  LocalHistoryError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  Effect.gen(function* () {
    const authorizedSnapshots = authorizeSnapshots(request.snapshots, request.localSnapshots);

    const snapshots = authorizedSnapshots.map((candidate) => candidate.snapshot);
    const merged = mergeUsageSnapshots(snapshots);
    return {
      sources: collectProjectSources(
        mergeAuthorizedSnapshotRows(authorizedSnapshots),
        request.includeGitRemote ?? false,
        request.readGitFile,
      ),
      warnings: merged.warnings,
    };
  });

export const listProjectSources = (request: ProjectSourcesRequest) =>
  listProjectSourcesWithWarnings(request).pipe(Effect.map((result) => result.sources));

export const runLocalReportPayload = (request: LocalReportPayloadRequest): Promise<UsageReportPayload> =>
  Effect.runPromise(createLocalReportPayload(request).pipe(Effect.provide(LocalHistoryStorageLive)));

export const runLocalReportCapture = (
  request: LocalReportPayloadRequest,
  currentCaptureFingerprint?: string,
): Promise<LocalReportCaptureResult> =>
  Effect.runPromise(
    createLocalReportCapture(request, currentCaptureFingerprint).pipe(Effect.provide(LocalHistoryStorageLive)),
  );

export const runStoredReportPayload = (request: StoredReportPayloadRequest): Promise<UsageReportPayload> =>
  Effect.runPromise(createStoredReportPayload(request).pipe(Effect.provide(LocalHistoryStorageLive)));

export const runStoredReportSourceFingerprint = (
  request: Pick<StoredReportPayloadRequest, 'configCwd'>,
): Promise<StoredReportSourceFingerprint> =>
  Effect.runPromise(readStoredReportSourceFingerprint(request).pipe(Effect.provide(LocalHistoryStorageLive)));

export const runConsistentStoredReportPayload = async (
  request: StoredReportPayloadRequest,
): Promise<UsageReportPayload> => {
  for (let attempt = 1; attempt <= MAX_STABLE_REPORT_CAPTURE_ATTEMPTS; attempt += 1) {
    const before = await runStoredReportSourceFingerprint(request);
    const payload = await runStoredReportPayload(request);
    const after = await runStoredReportSourceFingerprint(request);
    if (
      before.configFingerprint === after.configFingerprint &&
      before.usageStoreGeneration === after.usageStoreGeneration
    ) {
      return payload;
    }
  }
  throw new Error(`Report source changed during ${MAX_STABLE_REPORT_CAPTURE_ATTEMPTS} consecutive capture attempts`);
};

export const runKnownLocalProjectSources = (
  request: KnownLocalProjectSourcesRequest,
): Promise<KnownLocalProjectSourcesResult> =>
  Effect.runPromise(createKnownLocalProjectSources(request).pipe(Effect.provide(LocalHistoryStorageLive)));
