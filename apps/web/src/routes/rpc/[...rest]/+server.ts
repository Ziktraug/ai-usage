import { handleWebRpcRequest } from '$lib/server/rpc/handler.server';
import { normalizeOwnedRpcSubrequest } from '$lib/server/rpc/subrequest-normalization.server';
import type { RequestHandler } from './$types';

const handleRpcRequest: RequestHandler = async ({ isSubRequest, request, url }) => {
  const rpcRequest = normalizeOwnedRpcSubrequest({ isSubRequest, request, url });
  const response = await handleWebRpcRequest(rpcRequest);
  response.headers.set('x-ai-usage-sveltekit', 'active');
  return response;
};

export const DELETE = handleRpcRequest;
export const GET = handleRpcRequest;
export const HEAD = handleRpcRequest;
export const OPTIONS = handleRpcRequest;
export const PATCH = handleRpcRequest;
export const POST = handleRpcRequest;
export const PUT = handleRpcRequest;
