import type { ReportDatasets } from '@ai-usage/report-core/datasets';
import type { HarnessKey } from '@ai-usage/report-core/harness-metadata';
import type { ProjectAliasEntry } from '@ai-usage/report-core/project-alias';
import type { ProjectGroupConfig } from '@ai-usage/report-core/project-group';
import type {
  PreparedUsageReport,
  ReportOptions,
  UsageReportPayload,
  UsageReportWarning,
} from '@ai-usage/report-core/report-data';
import {
  deserializeSnapshotRow,
  mergeUsageSnapshots,
  type SnapshotMergeWarning,
  type UsageMachine,
  type UsageSnapshot,
  usageSnapshotRowDedupeKey,
} from '@ai-usage/report-core/snapshot';
import {
  type AuthorizedSourceRow,
  buildProjectProjection,
  collectProjectSources,
  type ProjectedRow,
  type ProjectSource,
  type ReadGitFile,
  type SourceAuthority,
} from './project-projection';
import { assembleReport } from './report-assembly';
import { mergeReportDatasets, mirrorDatasetsToLegacyFacets } from './report-datasets';

export type { ProjectedRow, ProjectSource, ReadGitFile } from './project-projection';

export interface LocalUsageSelection {
  readonly configCwd?: string;
  readonly harness: HarnessKey | null;
  readonly includeCursor: boolean;
}

export interface ReportDatasetSelection {
  readonly includeCursorCommitAttribution?: boolean;
  readonly includeProviderStatus?: boolean;
}

export interface MergedUsageReportRequest extends LocalUsageSelection {
  readonly appVersion?: string | null;
  readonly datasets?: ReportDatasetSelection;
  readonly generatedAt?: Date;
  readonly includeFacets?: boolean;
  readonly localSnapshots?: readonly UsageSnapshot[];
  readonly machine?: UsageMachine;
  readonly options: ReportOptions;
  readonly snapshots: readonly UsageSnapshot[];
}

export interface ProjectedMergedUsageReportRequest extends MergedUsageReportRequest {
  readonly projectAliases?: readonly ProjectAliasEntry[];
  readonly projectGroupConfigs?: readonly ProjectGroupConfig[];
}

export interface MergedUsageReport {
  readonly duplicatesDropped: number;
  readonly payload: UsageReportPayload;
  readonly report: PreparedUsageReport;
  readonly rows: ProjectedRow[];
  readonly warnings: UsageReportWarning[];
}

export interface ProjectSourcesRequest extends LocalUsageSelection {
  readonly appVersion?: string | null;
  readonly generatedAt?: Date;
  readonly includeGitRemote?: boolean;
  readonly localSnapshots?: readonly UsageSnapshot[];
  readonly machine?: UsageMachine;
  readonly readGitFile?: ReadGitFile;
  readonly snapshots: readonly UsageSnapshot[];
}

export interface ProjectSourcesResult {
  readonly sources: ProjectSource[];
  readonly warnings: SnapshotMergeWarning[];
}

interface AuthorizedSnapshot {
  readonly authority: SourceAuthority;
  readonly snapshot: UsageSnapshot;
}

const authorizeSnapshots = (
  snapshots: readonly UsageSnapshot[],
  localSnapshots: readonly UsageSnapshot[] = [],
): AuthorizedSnapshot[] => [
  ...snapshots.map((snapshot) => ({ authority: 'portable-opaque' as const, snapshot })),
  ...localSnapshots.map((snapshot) => ({ authority: 'local-observed' as const, snapshot })),
];

const mergeAuthorizedSnapshotRows = (snapshots: readonly AuthorizedSnapshot[]): AuthorizedSourceRow[] => {
  const winners = new Map<string, { readonly candidate: AuthorizedSourceRow; readonly generatedAt: number }>();
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
  return [...winners.values()].map(({ candidate }) => candidate);
};

export const assembleMergedUsageReport = (request: ProjectedMergedUsageReportRequest): MergedUsageReport => {
  const authorizedSnapshots = authorizeSnapshots(request.snapshots, request.localSnapshots);
  const merged = mergeUsageSnapshots(authorizedSnapshots.map(({ snapshot }) => snapshot));
  const projection = buildProjectProjection(
    mergeAuthorizedSnapshotRows(authorizedSnapshots),
    request.projectGroupConfigs,
    request.projectAliases,
  );
  const allWarnings = [...merged.warnings, ...projection.warnings];
  const payloadWarnings = allWarnings.map((warning) => {
    if (!('key' in warning)) {
      return warning;
    }
    const { key, ...payloadWarning } = warning;
    return {
      ...payloadWarning,
      message: key ? `${warning.message}: ${key}` : warning.message,
    };
  });
  const datasets: ReportDatasets | undefined = mergeReportDatasets(merged.datasets);
  const assembly = assembleReport({
    configuredProjectGroups: [...(request.projectGroupConfigs ?? [])],
    datasets,
    ...(request.includeFacets ? { facets: mirrorDatasetsToLegacyFacets(datasets) } : {}),
    generatedAt: request.generatedAt ?? new Date(),
    options: request.options,
    projectGroups: projection.projectGroups,
    rows: projection.rows,
    warnings: payloadWarnings,
  });
  return {
    duplicatesDropped: merged.duplicatesDropped,
    payload: assembly.payload,
    report: assembly.report,
    rows: assembly.rows,
    warnings: allWarnings,
  };
};

export const collectProjectSourcesFromSnapshots = (request: ProjectSourcesRequest): ProjectSourcesResult => {
  const authorizedSnapshots = authorizeSnapshots(request.snapshots, request.localSnapshots);
  return {
    sources: collectProjectSources(
      mergeAuthorizedSnapshotRows(authorizedSnapshots),
      request.includeGitRemote ?? false,
      request.readGitFile,
    ),
    warnings: mergeUsageSnapshots(authorizedSnapshots.map(({ snapshot }) => snapshot)).warnings,
  };
};
