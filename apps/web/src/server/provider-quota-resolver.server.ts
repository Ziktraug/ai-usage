import {
  type ProviderQuotaHistoryRequest,
  type ProviderQuotaHistoryResult,
  parseProviderQuotaHistoryRequest,
} from '@ai-usage/report-core/provider-quota';
import type { RuntimeMode } from '../runtime-mode';
import { getServerRuntimeMode } from './runtime-mode.server';

export type ProviderQuotaHistoryReader = (
  request: ProviderQuotaHistoryRequest,
  options?: { readonly signal?: AbortSignal },
) => Promise<ProviderQuotaHistoryResult>;

const loadLiveProviderQuotaHistoryReader = async (): Promise<ProviderQuotaHistoryReader> => {
  const { getProviderQuotaHistoryForServer } = await import('./provider-quota.server');
  return getProviderQuotaHistoryForServer;
};

export const resolveProviderQuotaHistoryForServer = async (
  requestValue: ProviderQuotaHistoryRequest,
  mode: RuntimeMode = getServerRuntimeMode(),
  loadLiveReader: () => Promise<ProviderQuotaHistoryReader> = loadLiveProviderQuotaHistoryReader,
  options: { readonly signal?: AbortSignal } = {},
): Promise<ProviderQuotaHistoryResult> => {
  options.signal?.throwIfAborted();
  const request = parseProviderQuotaHistoryRequest(requestValue);
  if (mode === 'demo') {
    const { assertOutsideDemo } = await import('./demo-boundary.server');
    assertOutsideDemo(mode);
    throw new Error('Demo mode does not expose provider quota history.');
  }
  if (mode === 'e2e') {
    const { createE2EProviderQuotaHistoryFixture } = await import('../provider-quota-e2e-fixture');
    return createE2EProviderQuotaHistoryFixture();
  }
  const readLive = await loadLiveReader();
  const result = await readLive(request, options);
  options.signal?.throwIfAborted();
  return result;
};
