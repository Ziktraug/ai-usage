import type { WebContractClient } from '@ai-usage/web-contract';
import { getContext, setContext } from 'svelte';
import type { WebRpcQueryUtils } from '../rpc/client';

const WEB_QUERY_RPC_CONTEXT = Symbol('web-query-rpc');

export interface WebQueryRpcContext {
  readonly orpc: WebRpcQueryUtils;
  readonly rpc: WebContractClient;
}

export const installWebQueryRpcContext = (context: WebQueryRpcContext): WebQueryRpcContext => {
  setContext(WEB_QUERY_RPC_CONTEXT, context);
  return context;
};

export const useOptionalWebQueryRpcContext = (): WebQueryRpcContext | undefined =>
  getContext<WebQueryRpcContext | undefined>(WEB_QUERY_RPC_CONTEXT);

export const useWebQueryRpcContext = (): WebQueryRpcContext => {
  const context = useOptionalWebQueryRpcContext();
  if (context === undefined) {
    throw new Error('Web Query RPC context is unavailable outside the root Query provider.');
  }
  return context;
};
