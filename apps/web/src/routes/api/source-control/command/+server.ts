import { handleSourceControlEndpoint } from '$lib/features/sources/endpoint.server';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) =>
  await handleSourceControlEndpoint({
    loadHandler: async () => {
      const [{ createSourceControlCommandAdapter }, { handleSourceControlCommandRequest }] = await Promise.all([
        import('../../../../../src/lib/server/rpc/control'),
        import('../../../../../src/server/source-control-api.server'),
      ]);
      return createSourceControlCommandAdapter(handleSourceControlCommandRequest);
    },
    pathname: '/api/source-control/command',
    request,
    runtimeMode: locals.runtimeMode ?? 'live',
  });
