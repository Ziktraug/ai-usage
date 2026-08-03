import type { WebContractClient } from '@ai-usage/web-contract';

export const resolveSolidWebRpcClient = async (requestOwner?: string): Promise<WebContractClient> => {
  if (import.meta.env.SSR) {
    const { createSsrWebRpcClient } = await import('./client.server');
    return createSsrWebRpcClient(requestOwner);
  }
  const { createBrowserWebRpcClient } = await import('./client');
  return createBrowserWebRpcClient(requestOwner);
};
