import { defineHandler } from 'nitro';
import { enforceRequestPolicy, explicitPolicyForPath } from '../../../src/lib/server/rpc/request-policy-handler';

export default defineHandler(async (event) => {
  const policy = explicitPolicyForPath('/api/manual-merge/download');
  if (!policy) {
    return new Response(null, { status: 500 });
  }
  const enforced = await enforceRequestPolicy(event.req, policy);
  if (enforced instanceof Response) {
    return enforced;
  }
  const [{ createManualMergeDownloadHandler }, syncData, { resolveUsageReadModelForServer }] = await Promise.all([
    import('../../../src/lib/server/rpc/sync'),
    import('../../../src/server/sync-data.server'),
    import('../../../src/server/usage-read-model-resolver.server'),
  ]);
  const download = createManualMergeDownloadHandler({
    canonicalizeExport: (candidate, signal) => {
      signal.throwIfAborted();
      const result = syncData.canonicalizeManualMergeExportForServer(candidate);
      signal.throwIfAborted();
      return result;
    },
    exportBundle: async (signal) => {
      signal.throwIfAborted();
      const result = await syncData.exportManualMergeBundleForServer(await resolveUsageReadModelForServer());
      signal.throwIfAborted();
      return result;
    },
  });
  return await download(event.req);
});
