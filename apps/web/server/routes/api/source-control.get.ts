import { defineHandler } from 'nitro';
import { runOutsideDemo } from '../../../src/server/demo-boundary.server';

export default defineHandler(async (event) => {
  const response = await runOutsideDemo(async () => {
    const { createSourceControlEventStream } = await import('../../../src/server/source-control-api.server');
    return createSourceControlEventStream(event.req);
  });
  return response;
});
