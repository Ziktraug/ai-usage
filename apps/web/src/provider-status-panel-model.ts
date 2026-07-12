import type { ProviderStatusView } from './provider-status-model';

export interface ProviderStatusPanelSummary {
  attentionProvidersWithoutQuota: ProviderStatusView[];
  criticalProvidersWithoutQuota: ProviderStatusView[];
  noWindowProviderCount: number;
  quotaProviders: ProviderStatusView[];
  unsupportedProviderCount: number;
  warningCount: number;
}

export const buildProviderStatusPanelSummary = (providers: ProviderStatusView[]): ProviderStatusPanelSummary => {
  const quotaProviders: ProviderStatusView[] = [];
  const criticalProvidersWithoutQuota: ProviderStatusView[] = [];
  const attentionProvidersWithoutQuota: ProviderStatusView[] = [];
  let noWindowProviderCount = 0;
  let unsupportedProviderCount = 0;
  let warningCount = 0;

  for (const provider of providers) {
    const hasQuotaWindow = provider.windowGroups.length > 0;
    if (hasQuotaWindow) {
      quotaProviders.push(provider);
    } else {
      noWindowProviderCount += 1;
      if (provider.tone === 'critical') {
        criticalProvidersWithoutQuota.push(provider);
      } else if (
        provider.tone === 'warning' ||
        (provider.provider.warnings?.length ?? 0) > 0 ||
        provider.creditsSummary !== null
      ) {
        attentionProvidersWithoutQuota.push(provider);
      }
    }
    if (provider.provider.state === 'unsupported') {
      unsupportedProviderCount += 1;
    }
    warningCount += provider.provider.warnings?.length ?? 0;
  }

  return {
    attentionProvidersWithoutQuota,
    criticalProvidersWithoutQuota,
    noWindowProviderCount,
    quotaProviders,
    unsupportedProviderCount,
    warningCount,
  };
};
