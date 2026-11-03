import { loadPromptsPage } from '#lib/features/prompts/prompts-load.ts';
import { createInProcessWebRpcClient } from '#lib/server/rpc/in-process-client.server.ts';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ locals, request, url }) =>
  await loadPromptsPage({ rpc: await createInProcessWebRpcClient(request), url }, locals.runtimeMode ?? 'live');
