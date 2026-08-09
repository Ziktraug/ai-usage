import type { RuntimeMode } from '../../../runtime-mode';
import { enforceRequestPolicy, explicitPolicyForPath } from '../../server/rpc/request-policy-handler';

export type SourceControlEndpointPath = '/api/source-control' | '/api/source-control/command';

interface SourceControlEndpointOptions {
  readonly loadHandler: () => Promise<(request: Request) => Promise<Response>>;
  readonly pathname: SourceControlEndpointPath;
  readonly request: Request;
  readonly runtimeMode: RuntimeMode;
}

export const handleSourceControlEndpoint = async ({
  loadHandler,
  pathname,
  request,
  runtimeMode,
}: SourceControlEndpointOptions): Promise<Response> => {
  const policy = explicitPolicyForPath(pathname);
  if (!policy) {
    return new Response(null, { status: 500 });
  }
  const enforced = await enforceRequestPolicy(request, policy, runtimeMode);
  if (enforced instanceof Response) {
    return enforced;
  }
  const handler = await loadHandler();
  return await handler(request);
};
