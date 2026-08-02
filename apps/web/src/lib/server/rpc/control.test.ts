import { describe, expect, test } from 'bun:test';
import { controlRpcRouter, createControlExplicitHttpAdapters } from './control';

const request = (path: string, method: 'GET' | 'POST', signal?: AbortSignal): Request =>
  new Request(`http://localhost${path}`, {
    method,
    ...(signal === undefined ? {} : { signal }),
  });

describe('control explicit HTTP adapters', () => {
  test('delegates exact GET SSE and POST command requests without creating RPC ownership', async () => {
    const received: Request[] = [];
    const adapters = createControlExplicitHttpAdapters({
      handleCommand: (input) => {
        received.push(input);
        return Promise.resolve(Response.json({ ok: true }));
      },
      handleEvents: (input) => {
        received.push(input);
        return new Response('event: heartbeat\n\n', { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const events = request('/api/source-control', 'GET');
    const command = request('/api/source-control/command', 'POST');

    const eventResponse = await adapters.sourceControlSse(events);
    const commandResponse = await adapters.sourceControlCommand(command);

    expect(received).toEqual([events, command]);
    expect(eventResponse.headers.get('content-type')).toBe('text/event-stream');
    expect(commandResponse.status).toBe(200);
    expect(controlRpcRouter).toEqual({});
  });

  test('rejects wrong methods before deep transport acquisition', async () => {
    let acquisitions = 0;
    const adapters = createControlExplicitHttpAdapters({
      handleCommand: () => {
        acquisitions += 1;
        return Promise.resolve(new Response());
      },
      handleEvents: () => {
        acquisitions += 1;
        return new Response();
      },
    });

    const command = await adapters.sourceControlCommand(request('/api/source-control/command', 'GET'));
    const events = await adapters.sourceControlSse(request('/api/source-control', 'POST'));

    expect(command.status).toBe(405);
    expect(command.headers.get('allow')).toBe('POST');
    expect(events.status).toBe(405);
    expect(events.headers.get('allow')).toBe('GET');
    expect(acquisitions).toBe(0);
  });

  test('preserves the request cancellation signal for deep SSE cleanup', async () => {
    const controller = new AbortController();
    let receivedRequest: Request | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const adapters = createControlExplicitHttpAdapters({
      handleCommand: () => Promise.resolve(new Response()),
      handleEvents: async (input) => {
        receivedRequest = input;
        started?.();
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return new Response(null, { status: 204 });
      },
    });
    const events = request('/api/source-control', 'GET', controller.signal);
    const responsePromise = adapters.sourceControlSse(events);
    await startedPromise;
    controller.abort();

    expect((await responsePromise).status).toBe(204);
    expect(receivedRequest).toBe(events);
    expect(receivedRequest?.signal.aborted).toBe(true);
  });
});
