import type { WebContractClient } from '@ai-usage/web-contract';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { createORPCSvelteQueryUtils, type RouterUtils } from '@orpc/svelte-query';

const GET_RPC_PATHS = new Set([
  'campaign/labelOverrides',
  'report/revisionBootstrap',
  'report/revisionManifest',
  'runtime/reportPerfEnabled',
  'skills/knownProjectPaths',
  'skills/previewReconcileAll',
  'skills/projectInventories',
  'skills/projectMarkdown',
  'skills/snapshot',
  'sync/fleet',
]);

export type WebRpcQueryUtils = RouterUtils<WebContractClient>;

export const createWebRpcQueryUtils = (client: WebContractClient): WebRpcQueryUtils =>
  createORPCSvelteQueryUtils(client);

export interface WebRpcClientOptions {
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly headers?: Headers | Readonly<Record<string, string>>;
  readonly url: string | URL;
}

export const rpcMethodForPath = (path: readonly string[]): 'GET' | 'POST' =>
  GET_RPC_PATHS.has(path.join('/')) ? 'GET' : 'POST';

export const createWebRpcClient = ({ fetch, headers, url }: WebRpcClientOptions): WebContractClient => {
  const link = new RPCLink({
    ...(fetch === undefined ? {} : { fetch }),
    ...(headers === undefined ? {} : { headers }),
    method: (_options, path) => rpcMethodForPath(path),
    url,
  });
  return createORPCClient<WebContractClient>(link);
};

export const browserWebRpcUrl = (locationUrl: string | URL): URL => new URL('/rpc', locationUrl);

export const createBrowserWebRpcClient = (requestOwner?: string): WebContractClient =>
  createWebRpcClient({
    ...(requestOwner === undefined ? {} : { headers: { 'x-ai-usage-request-owner': requestOwner } }),
    url: browserWebRpcUrl(globalThis.location.href),
  });
