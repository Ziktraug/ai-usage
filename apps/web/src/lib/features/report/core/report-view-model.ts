import type { FocusedSupportResult } from '@ai-usage/report-core/focused-report-query';
import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
import type { WebReportPayload } from '../../../../web-report-payload';

export interface ReportOverviewItem {
  readonly label: string;
  readonly value: string;
}

export interface ReportShellModel {
  readonly generatedAt: string | null;
  readonly hasReportData: boolean;
  readonly isDemo: boolean;
  readonly omittedSupportItemCount: number;
  readonly overviewItems: readonly ReportOverviewItem[];
  readonly publicationLabel: string;
  readonly revision: string | null;
  readonly support: FocusedSupportResult | null;
  readonly warnings: FocusedSupportResult['support']['warnings'];
}

const numberFormatter = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
const dateTimeFormatter = new Intl.DateTimeFormat('en', {
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
  month: 'short',
});

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
      overviewItems: [],
      publicationLabel: 'No compatible publication',
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
    overviewItems: [
      {
        label: 'Coverage',
        value: result.bootstrap.dateDomain
          ? `${result.bootstrap.dateDomain.first} – ${result.bootstrap.dateDomain.last}`
          : 'No dated sessions',
      },
      { label: 'Harnesses', value: numberFormatter.format(result.bootstrap.filterOptions.harness.length) },
      { label: 'Machines', value: numberFormatter.format(result.bootstrap.filterOptions.machine.length) },
      { label: 'Providers', value: numberFormatter.format(result.bootstrap.providerRows.length) },
    ],
    publicationLabel: 'Compatible stored publication',
    revision: result.manifest.revision,
    support: result.bootstrap,
    warnings: result.bootstrap.support.warnings,
  };
};

export const syntheticReportShellModel = (mode: 'demo' | 'e2e', payload: WebReportPayload): ReportShellModel => {
  const harnesses = new Set(payload.rows.map(({ harness }) => harness));
  const providers = new Set(payload.rows.map(({ provider }) => provider));
  return {
    generatedAt: payload.generatedAt,
    hasReportData: payload.rows.length > 0,
    isDemo: mode === 'demo',
    omittedSupportItemCount: 0,
    overviewItems: [
      { label: 'Sessions', value: numberFormatter.format(payload.rows.length) },
      { label: 'Harnesses', value: numberFormatter.format(harnesses.size) },
      { label: 'Providers', value: numberFormatter.format(providers.size) },
    ],
    publicationLabel: mode === 'demo' ? 'Synthetic demo publication' : 'Synthetic test publication',
    revision: null,
    support: null,
    warnings: payload.warnings,
  };
};

export const reportGeneratedLabel = (generatedAt: string | null, hasReportData: boolean): string => {
  if (!(hasReportData && generatedAt)) {
    return 'Report payload unavailable';
  }
  return `Generated ${dateTimeFormatter.format(new Date(generatedAt))}`;
};
