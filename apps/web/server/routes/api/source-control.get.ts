import { defineHandler } from 'nitro';
import { enforceRequestPolicy, explicitPolicyForPath } from '../../../src/lib/server/rpc/request-policy-handler';

export default defineHandler(async (event) => {
  const policy = explicitPolicyForPath('/api/source-control');
  if (!policy) {
    return new Response(null, { status: 500 });
  }
  const enforced = await enforceRequestPolicy(event.req, policy);
  if (enforced instanceof Response) {
    return enforced;
  }
  const [{ createSourceControlSseAdapter }, { createSourceControlEventStream }] = await Promise.all([
    import('../../../src/lib/server/rpc/control'),
    import('../../../src/server/source-control-api.server'),
  ]);
  return await createSourceControlSseAdapter(createSourceControlEventStream)(event.req);
});
