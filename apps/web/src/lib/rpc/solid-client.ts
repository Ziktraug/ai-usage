import type { WebContractClient } from '@ai-usage/web-contract';
import type { ReportClient } from './report-client';

export const resolveSolidWebRpcClient = async (requestOwner?: string): Promise<WebContractClient> => {
  if (import.meta.env.SSR) {
    const { createSsrWebRpcClient } = await import('./client.server');
    return createSsrWebRpcClient(requestOwner);
  }
  const { createBrowserWebRpcClient } = await import('./client');
  return createBrowserWebRpcClient(requestOwner);
};

export const createSolidReportClient = async (rpc: WebContractClient): Promise<ReportClient> => {
  const { createReportClient } = await import('./report-client');
  return createReportClient(rpc);
};

export const resolveSolidReportClient = async (requestOwner?: string): Promise<ReportClient> =>
  await createSolidReportClient(await resolveSolidWebRpcClient(requestOwner));
