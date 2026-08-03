import type { WebContractClient } from '@ai-usage/web-contract';
import { createBrowserWebRpcClient } from './client';

export const resolveSolidWebRpcClient = async (requestOwner?: string): Promise<WebContractClient> => {
  if (import.meta.env.SSR) {
    const { createSsrWebRpcClient } = await import('./client.server');
    return createSsrWebRpcClient(requestOwner);
  }
  return createBrowserWebRpcClient(requestOwner);
};
