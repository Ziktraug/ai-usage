import type { WebContractClient } from '@ai-usage/web-contract';
import { getRequest } from '@tanstack/solid-start/server';
import { createWebRpcClient } from './client';

export const createSsrWebRpcClient = (requestOwner?: string): WebContractClient => {
  const request = getRequest();
  const origin = new URL(request.url).origin;
  return createWebRpcClient({
    headers: {
      origin,
      ...(requestOwner === undefined ? {} : { 'x-ai-usage-request-owner': requestOwner }),
    },
    url: new URL('/rpc', origin),
  });
};
