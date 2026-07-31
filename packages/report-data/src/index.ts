import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  collectHarnessDatasetsResult,
  collectSelectedHarnessResults,
  collectSelectedHarnessRows,
  type HarnessSelection,
  type SelectedHarnessCollectionResult,
} from '@ai-usage/local-collectors';
import { LocalHistoryError, type LocalHistoryWarning } from '@ai-usage/local-collectors/errors';
import { LocalHistoryStorage, LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { ensureMachineConfig, readMergedAiUsageConfigFrom } from '@ai-usage/local-collectors/machine-config';
import {
  type FocusedMachineFreshness,
  type FocusedReportSupport,
  parseFocusedReportSupport,
} from '@ai-usage/report-core/focused-report-query';
import { type HarnessKey, harnessKeys } from '@ai-usage/report-core/harness-metadata';
import type { ProjectAliasEntry } from '@ai-usage/report-core/project-alias';
import type { ProjectGroupConfig } from '@ai-usage/report-core/project-group';
import { projectProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { createProviderStatusDataset } from '@ai-usage/report-core/provider-status';
import type {
  ReportOptions,
  SerializedRow,
  UsageReportPayload,
  UsageReportProjectGroup,
  UsageReportWarning,
} from '@ai-usage/report-core/report-data';
import { createUsageSnapshot, type UsageMachine } from '@ai-usage/report-core/snapshot';
import type { Row, SourcedRow } from '@ai-usage/report-core/types';
import {
  queryLatestProviderQuotaObservations,
  queryNormalizedDatasetItems,
  queryReportRows,
  queryStoredReportCapture,
  queryUsageStoreGenerations,
  type StoredSourceAuthority,
  usageStorePath,
} from '@ai-usage/usage-store/reader';
import { Effect } from 'effect';
import { withPerfSpan } from './perf';
import {
  assembleMergedUsageReport,
  collectProjectSourcesFromSnapshots,
  type MergedUsageReportRequest,
  type ProjectSourcesRequest,
  type ProjectSourcesResult,
} from './portable-report';
import {
  type AuthorizedSourceRow,
  authorizeRows,
  buildProjectProjection,
  collectProjectSources,
  defaultReadGitFile,
  type ProjectedRow,
  type ProjectSource,
  type SourceAuthority,
} from './project-projection';
import { assembleReport, captureReport, type ReportAssemblyInput } from './report-assembly';
import { mergeReportDatasets, mirrorDatasetsToLegacyFacets } from './report-datasets';

export {
  assembleMergedUsageReport,
  collectProjectSourcesFromSnapshots,
  type MergedUsageReport,
  type MergedUsageReportRequest,
  type ProjectedMergedUsageReportRequest,
  type ProjectSourcesRequest,
  type ProjectSourcesResult,
} from './portable-report';
export { type ProjectedRow, type ProjectSource, parseGitConfigRemote, type ReadGitFile } from './project-projection';
export {
  assembleReport,
  captureReport,
  reportAssemblyInputFingerprint,
  reportCaptureFingerprint,
} from './report-assembly';

const METRIC_VALIDATION_MESSAGE_PATTERN = /^Rejected (\d+) malformed (.+) metric record\(s\)\.$/;
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

export interface ReadStoredCursorCommitAttributionInput {
  dbPath: string;
  machineId?: string;
  maximumItems?: number;
}

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
  dbPath?: string;
  generatedAt?: Date;
  includeFacets?: boolean;
  machine?: UsageMachine;
  options: ReportOptions;
}

export interface StoredReportSourceFingerprint {
  configFingerprint: string;
  machineFleetGeneration: number;
  usageStoreGeneration: number;
}

export interface StoredReportCapture {
  machineFreshness: FocusedMachineFreshness;
  payload: UsageReportPayload;
  projectAliases: readonly ProjectAliasEntry[];
  projectGroupConfigs: readonly ProjectGroupConfig[];
  rowSourceAuthorities: StoredSourceAuthority[];
}

export interface StoredReportPublicationCapture {
  readonly configFingerprint: string;
  readonly generatedAt: string;
  readonly projectAliases: readonly ProjectAliasEntry[];
  readonly projectGroupConfigs: readonly ProjectGroupConfig[];
  readonly rows: readonly SerializedRow[];
  readonly sourceAuthorities: readonly StoredSourceAuthority[];
  readonly support: FocusedReportSupport;
}

type StoredReportJsonValue =
  | boolean
  | number
  | string
  | null
  | StoredReportJsonValue[]
  | { [key: string]: StoredReportJsonValue };

const isStoredReportJsonValue = (value: unknown): value is StoredReportJsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isStoredReportJsonValue);
  }
  if (typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.values(value).every(isStoredReportJsonValue);
};

const isStoredReportJsonRecord = (value: unknown): value is Record<string, StoredReportJsonValue> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(isStoredReportJsonValue);

const withoutLegacyCursorAttribution = (
  datasets: Record<string, StoredReportJsonValue> | undefined,
  facets: Record<string, StoredReportJsonValue> | undefined,
): Record<string, StoredReportJsonValue> | undefined => {
  if (!(Array.isArray(datasets?.cursorCommitAttribution) && facets)) {
    return facets;
  }
  const cursor = facets.cursor;
  if (!(isStoredReportJsonRecord(cursor) && Object.hasOwn(cursor, 'commitAttribution'))) {
    return facets;
  }
  const { commitAttribution: _legacyCommitAttribution, ...cursorWithoutAttribution } = cursor;
  if (Object.keys(cursorWithoutAttribution).length > 0) {
    return { ...facets, cursor: cursorWithoutAttribution };
  }
  const { cursor: _legacyCursorFacet, ...facetsWithoutCursor } = facets;
  return Object.keys(facetsWithoutCursor).length > 0 ? facetsWithoutCursor : undefined;
};

export const toStoredReportPublicationCapture = (
  capture: StoredReportCapture,
  configFingerprint: string,
): StoredReportPublicationCapture => {
  const { datasets, facets, rows, tableRows: _tableRows, ...support } = capture.payload;
  if (datasets !== undefined && !isStoredReportJsonRecord(datasets)) {
    throw new Error('Stored report datasets must contain only JSON-serializable values.');
  }
  if (facets !== undefined && !isStoredReportJsonRecord(facets)) {
    throw new Error('Stored report facets must contain only JSON-serializable values.');
  }
  const servedFacets = withoutLegacyCursorAttribution(datasets, facets);
  return {
    configFingerprint,
    generatedAt: capture.payload.generatedAt,
    projectAliases: capture.projectAliases,
    projectGroupConfigs: capture.projectGroupConfigs,
    rows,
    sourceAuthorities: capture.rowSourceAuthorities,
    support: parseFocusedReportSupport({
      ...support,
      machineFreshness: capture.machineFreshness,
      ...(datasets === undefined ? {} : { datasets }),
      ...(servedFacets === undefined ? {} : { facets: servedFacets }),
    }),
  };
};

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

export interface KnownLocalProjectSourcesRequest extends LocalUsageSelection {}

export interface KnownLocalProjectSourcesResult {
  projectGroups: UsageReportProjectGroup[];
  sources: ProjectSource[];
  warnings: (LocalHistoryWarning | UsageReportWarning)[];
}

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

export interface ProjectedLocalReportRowsResult
  extends Omit<LocalReportRowsResult, 'authorizedRows' | 'rows' | 'warnings'> {
  rows: ProjectedRow[];
  warnings: (LocalHistoryWarning | UsageReportWarning)[];
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
      const { collection } = yield* withPerfSpan(
        'aiUsage.report.collectConfiguredRows',
        collectConfiguredLocalRowsWithWarnings({ ...request, keepSource: true }),
        (result) => ({
          harnesses: result.collection.harnesses.length,
          rows: result.collection.rows.length,
          warnings: result.collection.warnings.length,
        }),
      );
      const rows = collection.rows.filter((row): row is SourcedRow => {
        const source = (row as { readonly source?: unknown }).source;
        return typeof source === 'object' && source !== null && 'harnessKey' in source;
      });
      if (rows.length !== collection.rows.length) {
        throw new Error('Local report collection omitted required source provenance.');
      }
      return {
        authorizedRows: authorizeRows(rows, 'local-observed'),
        rows,
        warnings: collection.warnings,
        collection,
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

export const createStoredReportCapture = (
  request: StoredReportPayloadRequest,
): Effect.Effect<
  StoredReportCapture,
  LocalHistoryError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  withPerfSpan(
    'aiUsage.report.createStoredPayload',
    Effect.gen(function* () {
      const storage = yield* LocalHistoryStorage;
      const machine = request.machine ?? (yield* ensureMachineConfig);
      const dbPath = request.dbPath ?? usageStorePath(storage.home);
      const harnessKeys = selectedStoredHarnessKeys(request);
      const storedCapture = yield* withPerfSpan(
        'aiUsage.usageStore.queryStoredReportCapture',
        queryStoredReportCapture({ dbPath, ...(harnessKeys === undefined ? {} : { harnessKeys }) }).pipe(
          Effect.mapError(usageStoreLocalHistoryError('usageStore.queryStoredReportCapture', dbPath)),
        ),
        (result) => ({ machines: result.machineFleet.machines.length, rows: result.reportRows.rows.length }),
      );
      const stored = storedCapture.reportRows;
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
        Effect.sync(() => {
          const assembly = assembleReport({
            configuredProjectGroups: config.projectGroups ?? [],
            datasets,
            facets,
            generatedAt: request.generatedAt ?? new Date(),
            options: request.options,
            projectGroups: projection.projectGroups,
            rows: projection.rows,
            warnings: [...datasetResult.warnings, ...projection.warnings],
          });
          if (assembly.rows.length !== projection.sourceAuthorities.length) {
            throw new Error('Stored report projection lost source-authority alignment');
          }
          const authorityByRow = new Map<Row, SourceAuthority>();
          for (const [index, row] of assembly.rows.entries()) {
            const authority = projection.sourceAuthorities[index];
            if (!authority) {
              throw new Error(`Stored report projection row ${index} is missing its source authority`);
            }
            authorityByRow.set(row, authority);
          }
          const rowSourceAuthorities = assembly.report.rows.map((row, index) => {
            const authority = authorityByRow.get(row);
            if (!authority) {
              throw new Error(`Stored report row ${index} is missing its source authority`);
            }
            return authority;
          });
          const machineFreshness: FocusedMachineFreshness = {
            kind: 'available',
            machines: storedCapture.machineFleet.machines.map(({ id, label, lastSeenAt }) => ({
              id,
              label,
              lastSeenAt,
            })),
            observedAt: assembly.payload.generatedAt,
            omittedMachines: storedCapture.machineFleet.omittedMachines,
            skippedRows: storedCapture.machineFleet.skipped,
          };
          return {
            machineFreshness,
            payload: assembly.payload,
            projectAliases: config.projectAliases ?? [],
            projectGroupConfigs: config.projectGroups ?? [],
            rowSourceAuthorities,
          };
        }),
        (capture) => ({
          rows: capture.payload.rows.length,
          tableRows: capture.payload.tableRows.length,
        }),
      );
    }),
    (capture) => ({
      rows: capture.payload.rows.length,
      tableRows: capture.payload.tableRows.length,
    }),
  );

export const createStoredReportPayload = (request: StoredReportPayloadRequest) =>
  createStoredReportCapture(request).pipe(Effect.map((capture) => capture.payload));

export const readStoredReportSourceFingerprint = (
  request: Pick<StoredReportPayloadRequest, 'configCwd' | 'dbPath'>,
): Effect.Effect<
  StoredReportSourceFingerprint,
  LocalHistoryError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const dbPath = request.dbPath ?? usageStorePath(storage.home);
    const generations = yield* queryUsageStoreGenerations({ dbPath }).pipe(
      Effect.mapError(usageStoreLocalHistoryError('usageStore.queryUsageStoreGenerations', dbPath)),
    );
    const config = yield* readMergedAiUsageConfigFrom(request.configCwd);
    return { configFingerprint: fingerprintConfig(config), ...generations };
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

export const createMergedUsageReport = (request: MergedUsageReportRequest) =>
  Effect.gen(function* () {
    const config = yield* readMergedAiUsageConfigFrom(request.configCwd);
    return assembleMergedUsageReport({
      ...request,
      projectAliases: config.projectAliases ?? [],
      projectGroupConfigs: config.projectGroups ?? [],
    });
  });

export const listProjectSourcesWithWarnings = (
  request: ProjectSourcesRequest,
): Effect.Effect<ProjectSourcesResult, LocalHistoryError> =>
  Effect.sync(() => collectProjectSourcesFromSnapshots(request));

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

export const runStoredReportCapture = (request: StoredReportPayloadRequest): Promise<StoredReportCapture> =>
  Effect.runPromise(createStoredReportCapture(request).pipe(Effect.provide(LocalHistoryStorageLive)));

export const runStoredReportSourceFingerprint = (
  request: Pick<StoredReportPayloadRequest, 'configCwd'>,
): Promise<StoredReportSourceFingerprint> =>
  Effect.runPromise(readStoredReportSourceFingerprint(request).pipe(Effect.provide(LocalHistoryStorageLive)));

export const runConsistentStoredReportPayload = async (
  request: StoredReportPayloadRequest,
): Promise<UsageReportPayload> => {
  const capture = await runConsistentStoredReportCapture(request);
  return capture.payload;
};

export const runConsistentStoredReportCapture = async (
  request: StoredReportPayloadRequest,
): Promise<StoredReportCapture> => {
  for (let attempt = 1; attempt <= MAX_STABLE_REPORT_CAPTURE_ATTEMPTS; attempt += 1) {
    const before = await runStoredReportSourceFingerprint(request);
    const capture = await runStoredReportCapture(request);
    const after = await runStoredReportSourceFingerprint(request);
    if (
      before.configFingerprint === after.configFingerprint &&
      before.machineFleetGeneration === after.machineFleetGeneration &&
      before.usageStoreGeneration === after.usageStoreGeneration
    ) {
      return capture;
    }
  }
  throw new Error(`Report source changed during ${MAX_STABLE_REPORT_CAPTURE_ATTEMPTS} consecutive capture attempts`);
};

export const runKnownLocalProjectSources = (
  request: KnownLocalProjectSourcesRequest,
): Promise<KnownLocalProjectSourcesResult> =>
  Effect.runPromise(createKnownLocalProjectSources(request).pipe(Effect.provide(LocalHistoryStorageLive)));
