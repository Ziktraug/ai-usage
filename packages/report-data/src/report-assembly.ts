import type { ReportDatasets } from '@ai-usage/report-core/datasets';
import type { ProjectGroupConfig } from '@ai-usage/report-core/project-group';
import {
  createUsageReportPayload,
  type PreparedUsageReport,
  prepareUsageReport,
  type ReportOptions,
  type UsageReportPayload,
  type UsageReportProjectGroup,
  type UsageReportWarning,
} from '@ai-usage/report-core/report-data';
import { normalizeSessionLineage } from '@ai-usage/report-core/session-lineage';
import type { Row } from '@ai-usage/report-core/types';

export interface ReportAssemblyInput<ReportRow extends Row = Row> {
  configuredProjectGroups: ProjectGroupConfig[];
  datasets?: ReportDatasets | undefined;
  facets?: UsageReportPayload['facets'] | undefined;
  generatedAt: Date;
  options: ReportOptions;
  projectGroups: UsageReportProjectGroup[];
  rows: ReportRow[];
  warnings: UsageReportWarning[];
}

export interface ReportAssemblyResult<ReportRow extends Row = Row> {
  payload: UsageReportPayload;
  report: PreparedUsageReport;
  rows: ReportRow[];
}

const canonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJson(child)]),
  );
};

const reportVisibleFacets = (
  datasets: ReportDatasets | undefined,
  facets: UsageReportPayload['facets'] | undefined,
): UsageReportPayload['facets'] | undefined => {
  if (!(Array.isArray(datasets?.cursorCommitAttribution) && facets)) {
    return facets;
  }
  const cursor = facets.cursor;
  if (!(typeof cursor === 'object' && cursor !== null && !Array.isArray(cursor))) {
    return facets;
  }
  const { commitAttribution: _legacyAttribution, ...cursorWithoutAttribution } = cursor as Record<string, unknown>;
  if (Object.keys(cursorWithoutAttribution).length > 0) {
    return { ...facets, cursor: cursorWithoutAttribution };
  }
  const { cursor: _legacyCursor, ...facetsWithoutCursor } = facets;
  return Object.keys(facetsWithoutCursor).length > 0 ? facetsWithoutCursor : undefined;
};

/** Fingerprints exactly the client-visible semantic payload, excluding observation time and duplicate table rows. */
export const reportCaptureFingerprint = (payload: UsageReportPayload): string => {
  const { datasets, facets, generatedAt: _generatedAt, tableRows: _tableRows, ...visiblePayload } = payload;
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonicalJson({
          ...visiblePayload,
          ...(datasets === undefined ? {} : { datasets }),
          ...((reportVisibleFacets(datasets, facets) ?? undefined) === undefined
            ? {}
            : { facets: reportVisibleFacets(datasets, facets) }),
        }),
      ),
    )
    .digest('hex');
};

/** Pure, deterministic owner for the final report projection. All I/O happens before this boundary. */
export const assembleReport = <ReportRow extends Row>(
  input: ReportAssemblyInput<ReportRow>,
): ReportAssemblyResult<ReportRow> => {
  const rows = normalizeSessionLineage(input.rows);
  const report = prepareUsageReport(rows, input.options);
  return {
    payload: createUsageReportPayload(
      report,
      input.options,
      input.generatedAt,
      input.facets,
      input.warnings,
      input.projectGroups,
      input.configuredProjectGroups,
      input.datasets,
    ),
    report,
    rows,
  };
};

import { createHash } from 'node:crypto';
