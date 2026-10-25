import type { WebContractClient } from '@ai-usage/web-contract';
import { createContext } from 'svelte';
import type { WebRpcQueryUtils } from '../rpc/client';

export interface WebQueryRpcContext {
  readonly orpc: WebRpcQueryUtils;
  readonly rpc: WebContractClient;
}

const [useWebQueryRpcContext, installWebQueryRpcContext, hasWebQueryRpcContext] = createContext<WebQueryRpcContext>();

/** Installed by the root Query provider; reading it outside that provider throws. */
export { installWebQueryRpcContext, useWebQueryRpcContext };

/** For components that also render without the root Query provider (server render, isolated fixtures). */
export const useOptionalWebQueryRpcContext = (): WebQueryRpcContext | undefined =>
  hasWebQueryRpcContext() ? useWebQueryRpcContext() : undefined;
