import { describe, expect, test } from 'bun:test';
import { handleSyncUploadRequest } from './sync-upload.server';

describe('sync upload demo boundary', () => {
  test('rejects before loading a mutation handler or reading the body', async () => {
    let bodyPulls = 0;
    let handlerLoads = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bodyPulls += 1;
          controller.enqueue(new TextEncoder().encode('{"rows":[]}'));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const requestOptions: RequestInit & { duplex: 'half' } = {
      body,
      duplex: 'half',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    };
    const request = new Request('http://127.0.0.1/sync', requestOptions);

    const response = await handleSyncUploadRequest(request, {
      loadHandler: () => {
        handlerLoads += 1;
        return Promise.resolve(() => Promise.resolve(new Response('live')));
      },
      mode: 'demo',
    });

    expect(response.status).toBe(404);
    expect(handlerLoads).toBe(0);
    expect(bodyPulls).toBe(0);
  });
});
