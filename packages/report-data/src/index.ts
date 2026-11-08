import { createHash } from 'node:crypto';
import { parseReportDatasets, withoutRetiredCursorFacet } from '@ai-usage/report-core/datasets';
import {
  type FocusedMachineFreshness,
  type FocusedReportSupport,
  parseFocusedReportSupport,
} from '@ai-usage/report-core/focused-report-query';
import { type HarnessKey, harnessKeys } from '@ai-usage/report-core/harness-metadata';
import type { AiUsageConfig, ProjectAliasEntry } from '@ai-usage/report-core/project-alias';
import type { ProjectGroupConfig } from '@ai-usage/report-core/project-group';
import { projectLatestProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { createProviderStatusDataset } from '@ai-usage/report-core/provider-status';
import type {
  ReportOptions,
  SerializedRow,
  UsageReportPayload,
  UsageReportWarning,
} from '@ai-usage/report-core/report-data';
import { createUsageSnapshot, type UsageMachine } from '@ai-usage/report-core/snapshot';
import { systemReportTimeZone } from '@ai-usage/report-core/time-zone';
import type { Row, SourcedRow } from '@ai-usage/report-core/types';
import {
  queryLatestProviderQuotaObservations,
  queryReportRows,
  queryStoredReportCapture,
  queryUsageStoreGenerations,
  type StoredSourceAuthority,
} from '@ai-usage/usage-store/reader';
import { Effect } from 'effect';
import { withPerfSpan } from './perf';
import { type AuthorizedSourceRow, buildProjectProjection, type SourceAuthority } from './project-projection';
import { assembleReport } from './report-assembly';
import { mergeReportDatasets } from './report-datasets';

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

export interface ReportDatasetSelection {
  readonly includeProviderStatus?: boolean;
}

export interface StoredReportPayloadRequest {
  readonly config: AiUsageConfig;
  readonly datasets?: ReportDatasetSelection;
  readonly dbPath: string;
  readonly generatedAt?: Date;
  readonly harness: HarnessKey | null;
  readonly includeCursor: boolean;
  readonly includeFacets?: boolean;
  readonly machine: UsageMachine;
  readonly options: ReportOptions;
}

export interface StoredUsageSnapshotRequest {
  readonly appVersion?: string | null;
  readonly datasets?: ReportDatasetSelection;
  readonly dbPath: string;
  readonly generatedAt?: Date;
  readonly harness: HarnessKey | null;
  readonly includeCursor: boolean;
  readonly includeFacets?: boolean;
  readonly machine: UsageMachine;
  readonly warnings?: UsageReportWarning[];
}

export interface StoredReportSourceFingerprint {
  readonly configFingerprint: string;
  readonly machineFleetGeneration: number;
  readonly usageStoreGeneration: number;
}

export interface StoredReportCapture {
  readonly machineFreshness: FocusedMachineFreshness;
  readonly payload: UsageReportPayload;
  readonly projectAliases: readonly ProjectAliasEntry[];
  readonly projectGroupConfigs: readonly ProjectGroupConfig[];
  readonly rowSourceAuthorities: StoredSourceAuthority[];
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
  const servedFacets = withoutRetiredCursorFacet(facets);
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
      ...(datasets === undefined ? {} : { datasets: parseReportDatasets(datasets) }),
      ...(servedFacets === undefined ? {} : { facets: servedFacets }),
    }),
  };
};

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

const fingerprintConfig = (config: AiUsageConfig): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalJsonValue(config)))
    .digest('hex');

const authorizeStoredRows = (stored: {
  readonly rows: SourcedRow[];
  readonly sourceAuthorities: StoredSourceAuthority[];
}): AuthorizedSourceRow[] => {
  if (stored.rows.length !== stored.sourceAuthorities.length) {
    throw new Error('Stored report rows and source authorities must have the same length.');
  }
  return stored.rows.map((row, index) => {
    const authority = stored.sourceAuthorities[index];
    if (!authority) {
      throw new Error(`Stored report row ${index} is missing its source authority.`);
    }
    return { authority, row };
  });
};

const datasetSelectionFor = (request: {
  readonly datasets?: ReportDatasetSelection;
  readonly harness: HarnessKey | null;
  readonly includeCursor: boolean;
  readonly includeFacets?: boolean;
}): ReportDatasetSelection | undefined => {
  if (request.datasets) {
    return request.datasets;
  }
  if (!request.includeFacets) {
    return;
  }
  return {
    includeProviderStatus: true,
  };
};

const readStoredDatasets = (input: {
  readonly dbPath: string;
  readonly machine: UsageMachine;
  readonly request: {
    readonly datasets?: ReportDatasetSelection;
    readonly harness: HarnessKey | null;
    readonly includeCursor: boolean;
    readonly includeFacets?: boolean;
  };
}) =>
  Effect.gen(function* () {
    const selection = datasetSelectionFor(input.request);
    const warnings: UsageReportWarning[] = [];
    const storedQuota = selection?.includeProviderStatus
      ? yield* queryLatestProviderQuotaObservations({
          dbPath: input.dbPath,
          machineId: input.machine.id,
        })
      : undefined;
    const storedQuotaDataset = storedQuota?.observations.length
      ? {
          providerStatus: createProviderStatusDataset(
            storedQuota.observations.map(projectLatestProviderQuotaObservation),
          ),
        }
      : undefined;
    return {
      datasets: mergeReportDatasets(storedQuotaDataset),
      warnings,
    };
  });

const selectedStoredHarnessKeys = (request: {
  readonly harness: HarnessKey | null;
  readonly includeCursor: boolean;
}): HarnessKey[] | undefined => {
  if (request.harness) {
    return [request.harness];
  }
  if (request.includeCursor) {
    return;
  }
  return harnessKeys.filter((key) => key !== 'cursor');
};

export const createStoredReportCapture = (request: StoredReportPayloadRequest) =>
  withPerfSpan(
    'aiUsage.report.createStoredPayload',
    Effect.gen(function* () {
      const selectedHarnesses = selectedStoredHarnessKeys(request);
      const storedCapture = yield* withPerfSpan(
        'aiUsage.usageStore.queryStoredReportCapture',
        queryStoredReportCapture({
          dbPath: request.dbPath,
          ...(selectedHarnesses === undefined ? {} : { harnessKeys: selectedHarnesses }),
        }),
        (result) => ({ machines: result.machineFleet.machines.length, rows: result.reportRows.rows.length }),
      );
      const stored = storedCapture.reportRows;
      const projection = yield* withPerfSpan(
        'aiUsage.report.projectStoredGroups',
        Effect.sync(() =>
          buildProjectProjection(
            authorizeStoredRows(stored),
            request.config.projectGroups ?? [],
            request.config.projectAliases ?? [],
          ),
        ),
        (result) => ({
          groups: result.projectGroups.length,
          rows: result.rows.length,
          warnings: result.warnings.length,
        }),
      );
      const datasetResult = yield* withPerfSpan(
        'aiUsage.report.readStoredDatasets',
        readStoredDatasets({ dbPath: request.dbPath, machine: request.machine, request }),
        (result) => ({ datasets: result.datasets ? Object.keys(result.datasets).length : 0 }),
      );
      const { datasets } = datasetResult;
      return yield* withPerfSpan(
        'aiUsage.report.serializeStoredPayload',
        Effect.sync(() => {
          const assembly = assembleReport({
            configuredProjectGroups: request.config.projectGroups ?? [],
            datasets,
            generatedAt: request.generatedAt ?? new Date(),
            options: request.options,
            projectGroups: projection.projectGroups,
            rows: projection.rows,
            timeZone: systemReportTimeZone(),
            warnings: [...datasetResult.warnings, ...projection.warnings],
          });
          if (assembly.rows.length !== projection.sourceAuthorities.length) {
            throw new Error('Stored report projection lost source-authority alignment.');
          }
          const authorityByRow = new Map<Row, SourceAuthority>();
          for (const [index, row] of assembly.rows.entries()) {
            const authority = projection.sourceAuthorities[index];
            if (!authority) {
              throw new Error(`Stored report projection row ${index} is missing its source authority.`);
            }
            authorityByRow.set(row, authority);
          }
          const rowSourceAuthorities = assembly.report.rows.map((row, index) => {
            const authority = authorityByRow.get(row);
            if (!authority) {
              throw new Error(`Stored report row ${index} is missing its source authority.`);
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
            projectAliases: request.config.projectAliases ?? [],
            projectGroupConfigs: request.config.projectGroups ?? [],
            rowSourceAuthorities,
          } satisfies StoredReportCapture;
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

export const readStoredReportSourceFingerprint = (request: {
  readonly config: AiUsageConfig;
  readonly dbPath: string;
}) =>
  queryUsageStoreGenerations({ dbPath: request.dbPath }).pipe(
    Effect.map((generations) => ({
      configFingerprint: fingerprintConfig(request.config),
      ...generations,
    })),
  );

export const createStoredUsageSnapshot = (request: StoredUsageSnapshotRequest) =>
  Effect.gen(function* () {
    const selectedHarnesses = selectedStoredHarnessKeys(request);
    const stored = yield* queryReportRows({
      dbPath: request.dbPath,
      originMachineIds: [request.machine.id],
      sourceAuthorities: ['local-observed'],
      ...(selectedHarnesses === undefined ? {} : { harnessKeys: selectedHarnesses }),
    });
    const datasetResult = yield* readStoredDatasets({ dbPath: request.dbPath, machine: request.machine, request });
    const datasets = datasetResult.datasets;
    const warnings = [...(request.warnings ?? []), ...datasetResult.warnings];
    return createUsageSnapshot({
      machine: request.machine,
      rows: stored.rows,
      ...(request.generatedAt === undefined ? {} : { generatedAt: request.generatedAt }),
      ...(request.appVersion === undefined ? {} : { appVersion: request.appVersion }),
      ...(warnings.length ? { warnings } : {}),
      ...(datasets === undefined ? {} : { datasets }),
    });
  });
