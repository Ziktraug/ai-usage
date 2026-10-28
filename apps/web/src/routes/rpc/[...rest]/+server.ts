import { handleWebRpcRequest } from '#lib/server/rpc/handler.server.ts';
import type { RequestHandler } from './$types';

// Only real HTTP reaches this endpoint: server loads call the router in process (ADR 0076), so an
// internal subrequest without a Host header fails the trusted-local check like any other request.
const handleRpcRequest: RequestHandler = async ({ request }) => {
  const response = await handleWebRpcRequest(request);
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
