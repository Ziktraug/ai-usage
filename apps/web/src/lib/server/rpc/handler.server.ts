import { BodyLimitPlugin, RPCHandler } from '@orpc/server/fetch';
import { type EnforcedRpcRequest, enforceRpcRequestPolicy } from './request-policy-handler';
import type { WebRpcRouterDependencies } from './router';
import { createWebRpcRouter } from './router';

const MAX_RPC_BODY_BYTES = 12 * 1024 * 1024;
const MAX_RPC_RESPONSE_BYTES = 12 * 1024 * 1024;

type RpcPolicyEnforcer = (request: Request) => Promise<EnforcedRpcRequest | Response>;
type WebRpcDependenciesFactory = (request: Request) => Promise<WebRpcRouterDependencies>;

export interface WebRpcHttpHandlerOptions {
  readonly createDependencies: WebRpcDependenciesFactory;
  readonly enforcePolicy?: RpcPolicyEnforcer;
}

const defaultDependenciesFactory: WebRpcDependenciesFactory = async (request) => {
  const { createWebRpcRouterDependencies } = await import('./context.server');
  return await createWebRpcRouterDependencies(request);
};

const failureResponse = (status: number, tag: string, message: string): Response =>
  Response.json({ error: { message, tag }, ok: false }, { headers: { 'cache-control': 'no-store' }, status });

export const enforceRpcResponseBound = async (response: Response): Promise<Response> => {
  const bytes = (await response.clone().arrayBuffer()).byteLength;
  if (bytes > MAX_RPC_RESPONSE_BYTES) {
    return failureResponse(502, 'ResponseTooLarge', 'The RPC response exceeded its byte limit.');
  }
  return response;
};

export const createWebRpcHttpHandler =
  ({ createDependencies, enforcePolicy = enforceRpcRequestPolicy }: WebRpcHttpHandlerOptions) =>
  async (request: Request): Promise<Response> => {
    const policyResult = await enforcePolicy(request);
    if (policyResult instanceof Response) {
      return policyResult;
    }
    try {
      const router = createWebRpcRouter(await createDependencies(request));
      const handler = new RPCHandler(router, {
        plugins: [new BodyLimitPlugin({ maxBodySize: MAX_RPC_BODY_BYTES })],
      });
      const { matched, response } = await handler.handle(request, { prefix: '/rpc' });
      if (!(matched && response)) {
        return failureResponse(404, 'NotFound', 'The RPC operation does not exist.');
      }
      return await enforceRpcResponseBound(response);
    } catch {
      request.signal.throwIfAborted();
      return failureResponse(500, 'Unavailable', 'The RPC operation is temporarily unavailable.');
    }
  };

export const handleWebRpcRequest = createWebRpcHttpHandler({
  createDependencies: defaultDependenciesFactory,
});
