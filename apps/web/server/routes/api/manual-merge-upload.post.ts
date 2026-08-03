import { defineHandler } from 'nitro';
import { enforceRequestPolicy, explicitPolicyForPath } from '../../../src/lib/server/rpc/request-policy-handler';

export default defineHandler(async (event) => {
  const policy = explicitPolicyForPath('/api/manual-merge/upload');
  if (!policy) {
    return new Response(null, { status: 500 });
  }
  const enforced = await enforceRequestPolicy(event.req, policy);
  if (enforced instanceof Response) {
    return enforced;
  }
  const [{ createManualMergeUploadHandler }, { handleSyncUploadRequest }] = await Promise.all([
    import('../../../src/lib/server/rpc/sync'),
    import('../../../src/server/sync-upload.server'),
  ]);
  return await createManualMergeUploadHandler(handleSyncUploadRequest)(event.req);
});
