import type { FocusedSupportResult } from '@ai-usage/report-core/focused-report-query';
import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
import type { WebReportPayload } from '../../../../web-report-payload';

export interface ReportShellModel {
  readonly generatedAt: string | null;
  readonly hasReportData: boolean;
  readonly isDemo: boolean;
  readonly omittedSupportItemCount: number;
  readonly revision: string | null;
  readonly support: FocusedSupportResult | null;
  readonly warnings: FocusedSupportResult['support']['warnings'];
}

const omittedSupportItems = (truncation: FocusedSupportResult['truncation']): number =>
  truncation.filterProjectOmitted +
  truncation.filterSinceOmitted +
  truncation.harnessOptionsOmitted +
  truncation.machineOptionsOmitted +
  truncation.providerRowsOmitted +
  truncation.providerStatusesOmitted +
  truncation.warningsOmitted;

export const liveReportShellModel = (result: ReportRevisionBootstrapResult | undefined): ReportShellModel => {
  if (!result?.ok) {
    return {
      generatedAt: null,
      hasReportData: false,
      isDemo: false,
      omittedSupportItemCount: 0,
      revision: null,
      support: null,
      warnings: undefined,
    };
  }
  return {
    generatedAt: result.manifest.generatedAt,
    hasReportData: true,
    isDemo: false,
    omittedSupportItemCount: omittedSupportItems(result.bootstrap.truncation),
    revision: result.manifest.revision,
    support: result.bootstrap,
    warnings: result.bootstrap.support.warnings,
  };
};

export const syntheticReportShellModel = (mode: 'demo' | 'e2e', payload: WebReportPayload): ReportShellModel => ({
  generatedAt: payload.generatedAt,
  hasReportData: payload.rows.length > 0,
  isDemo: mode === 'demo',
  omittedSupportItemCount: 0,
  revision: null,
  support: null,
  warnings: payload.warnings,
});

export const reportGeneratedLabel = (generatedAt: string | null, hasReportData: boolean): string => {
  if (!(hasReportData && generatedAt)) {
    return 'Report payload unavailable';
  }
  return `Generated ${new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(generatedAt))}`;
};
