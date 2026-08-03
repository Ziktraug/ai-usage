import { defineHandler } from 'nitro';

export default defineHandler(async (event) => {
  const { handleWebRpcRequest } = await import('../../src/lib/server/rpc/handler.server');
  return await handleWebRpcRequest(event.req);
});
