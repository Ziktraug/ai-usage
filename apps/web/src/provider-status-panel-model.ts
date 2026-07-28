import type { ProviderStatusView } from './provider-status-model';

export interface ProviderStatusPanelSummary {
  attentionProvidersWithoutQuota: ProviderStatusView[];
  criticalProvidersWithoutQuota: ProviderStatusView[];
  otherProvidersWithoutQuota: ProviderStatusView[];
  quotaProviders: ProviderStatusView[];
  unsupportedProvidersWithoutQuota: ProviderStatusView[];
}

export const buildProviderStatusPanelSummary = (providers: ProviderStatusView[]): ProviderStatusPanelSummary => {
  const quotaProviders: ProviderStatusView[] = [];
  const criticalProvidersWithoutQuota: ProviderStatusView[] = [];
  const attentionProvidersWithoutQuota: ProviderStatusView[] = [];
  const unsupportedProvidersWithoutQuota: ProviderStatusView[] = [];
  const otherProvidersWithoutQuota: ProviderStatusView[] = [];

  for (const provider of providers) {
    if (provider.windowGroups.length > 0) {
      quotaProviders.push(provider);
      continue;
    }
    if (provider.tone === 'critical') {
      criticalProvidersWithoutQuota.push(provider);
      continue;
    }
    if (provider.provider.state === 'unsupported') {
      unsupportedProvidersWithoutQuota.push(provider);
      continue;
    }
    if (
      provider.tone === 'warning' ||
      (provider.provider.warnings?.length ?? 0) > 0 ||
      provider.creditsSummary !== null
    ) {
      attentionProvidersWithoutQuota.push(provider);
      continue;
    }
    otherProvidersWithoutQuota.push(provider);
  }

  return {
    attentionProvidersWithoutQuota,
    criticalProvidersWithoutQuota,
    otherProvidersWithoutQuota,
    quotaProviders,
    unsupportedProvidersWithoutQuota,
  };
};
