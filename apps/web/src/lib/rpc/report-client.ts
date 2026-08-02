import type {
  CampaignLabelOverrideMutation,
  CampaignLabelOverridesResult,
  FocusedBreakdownRequest,
  FocusedBreakdownResult,
  FocusedOverviewRequest,
  FocusedOverviewResult,
  FocusedReportServerResult,
  FocusedRevisionRequest,
  FocusedSupportResult,
  ProviderQuotaHistoryRequest,
  ProviderQuotaHistoryResult,
  ReportContractClient,
  ReportRevisionBootstrapResult,
  ReportRevisionManifestResult,
  SaveProjectGroupsInput,
} from '@ai-usage/web-contract/report';

export interface ReportClientCallOptions {
  readonly signal?: AbortSignal;
}

const signalOptions = (options: ReportClientCallOptions | undefined): { readonly signal?: AbortSignal } =>
  options?.signal ? { signal: options.signal } : {};

export interface ReportClient {
  readonly getCampaignLabelOverrides: (options?: ReportClientCallOptions) => Promise<CampaignLabelOverridesResult>;
  readonly getFocusedReportBreakdown: (
    input: FocusedBreakdownRequest,
    options?: ReportClientCallOptions,
  ) => Promise<FocusedReportServerResult<FocusedBreakdownResult>>;
  readonly getFocusedReportOverview: (
    input: FocusedOverviewRequest,
    options?: ReportClientCallOptions,
  ) => Promise<FocusedReportServerResult<FocusedOverviewResult>>;
  readonly getFocusedReportSupport: (
    input: FocusedRevisionRequest,
    options?: ReportClientCallOptions,
  ) => Promise<FocusedReportServerResult<FocusedSupportResult>>;
  readonly getProviderQuotaHistory: (
    input: ProviderQuotaHistoryRequest,
    options?: ReportClientCallOptions,
  ) => Promise<ProviderQuotaHistoryResult>;
  readonly getReportPerfEnabled: (options?: ReportClientCallOptions) => Promise<boolean>;
  readonly getReportRevisionBootstrap: (options?: ReportClientCallOptions) => Promise<ReportRevisionBootstrapResult>;
  readonly getReportRevisionManifest: (options?: ReportClientCallOptions) => Promise<ReportRevisionManifestResult>;
  readonly saveProjectGroups: (
    input: SaveProjectGroupsInput,
    options?: ReportClientCallOptions,
  ) => Promise<{ readonly accepted: true }>;
  readonly setCampaignLabelOverride: (
    input: CampaignLabelOverrideMutation,
    options?: ReportClientCallOptions,
  ) => Promise<CampaignLabelOverridesResult>;
}

export const createReportClient = (client: ReportContractClient): ReportClient => ({
  getCampaignLabelOverrides: async (options) => await client.campaign.labelOverrides({}, signalOptions(options)),
  getFocusedReportBreakdown: async (input, options) =>
    await client.report.focusedBreakdown(input, signalOptions(options)),
  getFocusedReportOverview: async (input, options) =>
    await client.report.focusedOverview(input, signalOptions(options)),
  getFocusedReportSupport: async (input, options) => await client.report.focusedSupport(input, signalOptions(options)),
  getProviderQuotaHistory: async (input, options) => await client.quota.history(input, signalOptions(options)),
  getReportPerfEnabled: async (options) => await client.runtime.reportPerfEnabled({}, signalOptions(options)),
  getReportRevisionBootstrap: async (options) => await client.report.revisionBootstrap({}, signalOptions(options)),
  getReportRevisionManifest: async (options) => await client.report.revisionManifest({}, signalOptions(options)),
  saveProjectGroups: async (input, options) => await client.projectGroup.save(input, signalOptions(options)),
  setCampaignLabelOverride: async (input, options) =>
    await client.campaign.setLabelOverride(input, signalOptions(options)),
});
