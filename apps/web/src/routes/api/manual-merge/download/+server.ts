import { handleManualMergeDownloadEndpoint } from '$lib/features/sync/server/manual-merge-endpoints.server';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) =>
  await handleManualMergeDownloadEndpoint(request, locals.runtimeMode ?? 'live');
