import { defineHandler } from 'nitro';
import { runOutsideDemo } from '../../../src/server/demo-boundary.server';

export default defineHandler(async (event) => {
  const response = await runOutsideDemo(async () => {
    const { handleSourceControlCommandRequest } = await import('../../../src/server/source-control-api.server');
    return await handleSourceControlCommandRequest(event.req);
  });
  return response;
});
