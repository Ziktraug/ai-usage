import { parseReportDatasets, type ReportDatasets, withoutRetiredCursorFacet } from '@ai-usage/report-core/datasets';
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
  timeZone: string;
  warnings: UsageReportWarning[];
}

export interface ReportAssemblyResult<ReportRow extends Row = Row> {
  payload: UsageReportPayload;
  report: PreparedUsageReport;
  rows: ReportRow[];
}

export type ReportCaptureResult<ReportRow extends Row = Row> =
  | { captureFingerprint: string; result: ReportAssemblyResult<ReportRow>; status: 'changed' }
  | { captureFingerprint: string; status: 'unchanged' };

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

/** Fingerprints exactly the client-visible semantic payload, excluding observation time and duplicate table rows. */
export const reportCaptureFingerprint = (payload: UsageReportPayload): string => {
  const { datasets, facets, generatedAt: _generatedAt, tableRows: _tableRows, ...visiblePayload } = payload;
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonicalJson({
          ...visiblePayload,
          ...(datasets === undefined ? {} : { datasets: parseReportDatasets(datasets) }),
          ...((withoutRetiredCursorFacet(facets) ?? undefined) === undefined
            ? {}
            : { facets: withoutRetiredCursorFacet(facets) }),
        }),
      ),
    )
    .digest('hex');
};

/** Fingerprints every deterministic input consumed by the pure assembler, excluding only its explicit clock. */
export const reportAssemblyInputFingerprint = <ReportRow extends Row>(
  input: ReportAssemblyInput<ReportRow>,
): string => {
  const { generatedAt: _generatedAt, ...semanticInput } = input;
  return createHash('sha256')
    .update(JSON.stringify(canonicalJson(semanticInput)))
    .digest('hex');
};

/** Performs no report assembly when the complete semantic input matches the current capture. */
export const captureReport = <ReportRow extends Row>(
  input: ReportAssemblyInput<ReportRow>,
  currentCaptureFingerprint?: string,
): ReportCaptureResult<ReportRow> => {
  const captureFingerprint = reportAssemblyInputFingerprint(input);
  if (captureFingerprint === currentCaptureFingerprint) {
    return { captureFingerprint, status: 'unchanged' };
  }
  return { captureFingerprint, result: assembleReport(input), status: 'changed' };
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
      withoutRetiredCursorFacet(input.facets),
      input.warnings,
      input.projectGroups,
      input.configuredProjectGroups,
      parseReportDatasets(input.datasets),
      input.timeZone,
    ),
    report,
    rows,
  };
};

import { createHash } from 'node:crypto';
