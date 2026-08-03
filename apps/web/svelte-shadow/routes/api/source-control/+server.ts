import { handleSourceControlEndpoint } from '$lib/features/sources/endpoint.server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, request }) =>
  await handleSourceControlEndpoint({
    loadHandler: async () => {
      const [{ createSourceControlSseAdapter }, { createSourceControlEventStream }] = await Promise.all([
        import('../../../../src/lib/server/rpc/control'),
        import('../../../../src/server/source-control-api.server'),
      ]);
      return createSourceControlSseAdapter(createSourceControlEventStream);
    },
    pathname: '/api/source-control',
    request,
    runtimeMode: locals.runtimeMode ?? 'live',
  });
