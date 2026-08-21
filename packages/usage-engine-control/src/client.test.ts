import { describe, expect, test } from 'bun:test';
import { createUsageEngineControlClient, UsageEngineControlError, type UsageEngineFetch } from './client';
import { USAGE_ENGINE_PROTOCOL_VERSION, usageEngineControlBounds } from './contracts';
import { assertUsageEngineRendezvousTarget, parseUsageEngineRendezvous } from './rendezvous';
import { fixtureGeneratedAt, fixtureInstanceId, fixtureStatus } from './test-fixtures';

const rendezvous = parseUsageEngineRendezvous({
  instanceId: fixtureInstanceId,
  port: 41_321,
  protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
  targetId: 'a'.repeat(64),
  token: 'fixture-token-with-at-least-thirty-two-bytes',
});

const statusEvent = (eventId: string, sequence: number, status = fixtureStatus()) => ({
  event: 'status' as const,
  eventId,
  instanceId: status.instanceId,
  sequence,
  status,
});

const publishedEvent = (eventId: string, sequence: number, instanceId = fixtureInstanceId) => ({
  event: 'report-published' as const,
  eventId,
  instanceId,
  publication: {
    instanceId,
    publishedAt: fixtureGeneratedAt,
    revision: `revision-${sequence}`,
    sourceControlGeneration: sequence,
  },
  sequence,
});

const eventStreamResponse = (...events: readonly unknown[]): Response =>
  new Response(
    events
      .map((event) => {
        const eventId = (event as { readonly eventId: string }).eventId;
        return `id: ${eventId}\nevent: usage-engine\ndata: ${JSON.stringify(event)}\n\n`;
      })
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );

const nonCooperativeResponse = (contentType: string): Response =>
  ({
    body: {
      getReader: () => ({
        cancel: () => new Promise<never>(() => undefined),
        read: () => new Promise<never>(() => undefined),
        releaseLock: () => undefined,
      }),
    },
    headers: new Headers({ 'content-type': contentType }),
    ok: true,
    redirected: false,
    status: 200,
  }) as unknown as Response;

const heartbeatOnlyResponse = (): Response => {
  const heartbeat = new TextEncoder().encode(': heartbeat\n\n');
  let canceled = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      cancel: () => {
        canceled = true;
      },
      pull: async (controller) => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (!canceled) {
          controller.enqueue(heartbeat);
        }
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
};

describe('usage engine HTTP client', () => {
  test('uses exact loopback paths, protocol/auth headers, and bounded JSON parsing', async () => {
    const requests: Request[] = [];
    const client = createUsageEngineControlClient({
      fetch: (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Promise.resolve(Response.json(fixtureStatus()));
      },
      resolveRendezvous: () => Promise.resolve(rendezvous),
    });

    expect(await client.getStatus()).toEqual(fixtureStatus());
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://127.0.0.1:41321/v1/status');
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer fixture-token-with-at-least-thirty-two-bytes');
    expect(requests[0]?.headers.get('x-ai-usage-protocol-version')).toBe(String(USAGE_ENGINE_PROTOCOL_VERSION));
    expect(requests[0]?.redirect).toBe('error');
  });

  test('hard-stops non-cooperative fetches for caller abort and timeout', async () => {
    let fetches = 0;
    let markSecondFetchStarted: (() => void) | undefined;
    const secondFetchStarted = new Promise<void>((resolve) => {
      markSecondFetchStarted = resolve;
    });
    const hangingFetch: UsageEngineFetch = () => {
      fetches += 1;
      if (fetches === 2) {
        markSecondFetchStarted?.();
      }
      return new Promise<never>(() => undefined);
    };
    const client = createUsageEngineControlClient({
      fetch: hangingFetch,
      requestTimeoutMs: 10,
      resolveRendezvous: () => Promise.resolve(rendezvous),
    });

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(client.getStatus({ signal: preAborted.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(fetches).toBe(0);

    await expect(client.getStatus()).rejects.toMatchObject({ code: 'timeout' });
    expect(fetches).toBe(1);

    const abort = new AbortController();
    const pending = client.getStatus({ signal: abort.signal });
    await secondFetchStarted;
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(fetches).toBe(2);
  });

  test('hard-stops a non-cooperative JSON body read at the request deadline', async () => {
    const client = createUsageEngineControlClient({
      fetch: () => Promise.resolve(nonCooperativeResponse('application/json')),
      requestTimeoutMs: 10,
      resolveRendezvous: () => Promise.resolve(rendezvous),
    });

    await expect(client.getStatus()).rejects.toMatchObject({ code: 'timeout' });
  });

  test('sends identity-only commands and rejects oversized streamed responses', async () => {
    const requests: Request[] = [];
    const commandClient = createUsageEngineControlClient({
      commandId: () => 'command-1',
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(
          Response.json({
            admission: 'accepted',
            commandId: 'command-1',
            instanceId: fixtureInstanceId,
            ok: true,
            protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
          }),
        );
      },
      resolveRendezvous: () => Promise.resolve(rendezvous),
    });
    expect(await commandClient.execute({ command: 'publish' })).toMatchObject({
      commandId: 'command-1',
      ok: true,
    });
    expect(requests[0]?.url).toBe('http://127.0.0.1:41321/v1/commands');
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers.get('content-type')).toBe('application/json');
    expect(await requests[0]?.json()).toEqual({
      command: { command: 'publish' },
      commandId: 'command-1',
      protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    });

    const oversizedClient = createUsageEngineControlClient({
      fetch: () =>
        Promise.resolve(
          new Response(new Uint8Array(usageEngineControlBounds.maxStatusBytes + 1), {
            headers: { 'content-type': 'application/json' },
          }),
        ),
      resolveRendezvous: () => Promise.resolve(rendezvous),
    });
    await expect(oversizedClient.getStatus()).rejects.toMatchObject({ code: 'response-too-large' });
  });

  test('cancels an exact command identity with an authenticated bodyless DELETE', async () => {
    let observedRequest: Request | undefined;
    const client = createUsageEngineControlClient({
      fetch: (input, init) => {
        observedRequest = new Request(input, init);
        return Promise.resolve(
          Response.json({
            commandId: 'command-to-cancel',
            disposition: 'cancelled',
            instanceId: fixtureInstanceId,
            protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
          }),
        );
      },
      resolveRendezvous: () => Promise.resolve(rendezvous),
    });

    await expect(client.cancelCommand('command-to-cancel')).resolves.toMatchObject({
      commandId: 'command-to-cancel',
      disposition: 'cancelled',
    });
    expect(observedRequest?.url).toBe('http://127.0.0.1:41321/v1/commands/command-to-cancel');
    expect(observedRequest?.method).toBe('DELETE');
    expect(await observedRequest?.text()).toBe('');
    expect(observedRequest?.headers.get('authorization')).toBe('Bearer fixture-token-with-at-least-thirty-two-bytes');
  });

  test('uses stable bounded errors instead of exposing credentials or filesystem paths', async () => {
    const client = createUsageEngineControlClient({
      fetch: () =>
        Promise.reject(
          new Error(
            'Bearer fixture-token-with-at-least-thirty-two-bytes Basic c2VjcmV0 api_key=private /home/user/private.json',
          ),
        ),
      resolveRendezvous: () => Promise.resolve(rendezvous),
    });

    try {
      await client.getStatus();
      throw new Error('Expected request to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(UsageEngineControlError);
      expect((error as Error).message).toBe('Usage engine transport failed.');
      expect(String(error)).not.toContain('fixture-token');
      expect(String(error)).not.toContain('/home/user');
    }

    const commandClient = createUsageEngineControlClient({
      commandId: () => 'command-1',
      fetch: () =>
        Promise.resolve(
          Response.json({
            commandId: 'command-1',
            error: {
              code: 'command-rejected',
              message: 'Read /home/user/private.json with api_key=private',
            },
            instanceId: fixtureInstanceId,
            ok: false,
            protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
          }),
        ),
      resolveRendezvous: () => Promise.resolve(rendezvous),
    });
    expect(await commandClient.execute({ command: 'publish' })).toMatchObject({
      error: { code: 'command-rejected', message: 'Usage engine command was rejected.' },
      ok: false,
    });
  });

  test('does not reconnect authentication failures', async () => {
    let fetches = 0;
    const client = createUsageEngineControlClient({
      fetch: () => {
        fetches += 1;
        return Promise.resolve(
          Response.json(
            {
              error: { code: 'engine-busy', message: 'retry with /private/credential' },
              ok: false,
              protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
            },
            { status: 401 },
          ),
        );
      },
      reconnectDelayMs: 0,
      resolveRendezvous: () => Promise.resolve(rendezvous),
      wait: () => Promise.resolve(),
    });

    const changes = client.changes()[Symbol.asyncIterator]();
    await expect(changes.next()).rejects.toMatchObject({ code: 'authentication-failed', retry: 'never' });
    expect(fetches).toBe(1);
  });

  test('fails closed on rendezvous protocol mismatch without fetching or reconnecting', async () => {
    let fetches = 0;
    const client = createUsageEngineControlClient({
      fetch: () => {
        fetches += 1;
        return Promise.resolve(Response.json(fixtureStatus()));
      },
      reconnectDelayMs: 0,
      resolveRendezvous: () =>
        Promise.resolve().then(() =>
          parseUsageEngineRendezvous({
            instanceId: fixtureInstanceId,
            port: 41_321,
            protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION + 1,
            targetId: 'a'.repeat(64),
            token: 'fixture-token-with-at-least-thirty-two-bytes',
          }),
        ),
      wait: () => Promise.resolve(),
    });

    const changes = client.changes()[Symbol.asyncIterator]();
    await expect(changes.next()).rejects.toMatchObject({ code: 'protocol-mismatch', retry: 'never' });
    expect(fetches).toBe(0);
  });

  test('maps a rendezvous target mismatch to a non-retryable protocol mismatch without fetching', async () => {
    let fetches = 0;
    const client = createUsageEngineControlClient({
      fetch: () => {
        fetches += 1;
        return Promise.resolve(Response.json(fixtureStatus()));
      },
      resolveRendezvous: () =>
        Promise.resolve().then(() => {
          assertUsageEngineRendezvousTarget(rendezvous, 'b'.repeat(64));
          return rendezvous;
        }),
    });

    await expect(client.getStatus()).rejects.toMatchObject({ code: 'protocol-mismatch', retry: 'never' });
    expect(fetches).toBe(0);
  });

  test('distinguishes response protocol mismatch from malformed SSE without reconnecting either', async () => {
    const mismatchClient = createUsageEngineControlClient({
      fetch: () =>
        Promise.resolve(Response.json({ ...fixtureStatus(), protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION + 1 })),
      resolveRendezvous: () => Promise.resolve(rendezvous),
    });
    await expect(mismatchClient.getStatus()).rejects.toMatchObject({ code: 'protocol-mismatch', retry: 'never' });

    let fetches = 0;
    const malformedResponses = [
      Response.json(fixtureStatus()),
      eventStreamResponse({
        event: 'unknown',
        eventId: 'event-invalid',
        instanceId: fixtureInstanceId,
        sequence: 1,
      }),
    ];
    const malformedClient = createUsageEngineControlClient({
      fetch: () => {
        fetches += 1;
        return Promise.resolve(malformedResponses.shift() ?? Response.error());
      },
      reconnectDelayMs: 0,
      resolveRendezvous: () => Promise.resolve(rendezvous),
      wait: () => Promise.resolve(),
    });
    const changes = malformedClient.changes()[Symbol.asyncIterator]();
    await expect(changes.next()).rejects.toMatchObject({ code: 'invalid-response', retry: 'never' });
    expect(fetches).toBe(2);
  });

  test('requires an authoritative status as the first SSE frame', async () => {
    let fetches = 0;
    const client = createUsageEngineControlClient({
      fetch: () => {
        fetches += 1;
        if (fetches === 1) {
          return Promise.resolve(Response.json(fixtureStatus()));
        }
        return Promise.resolve(eventStreamResponse(publishedEvent('event-1', 1)));
      },
      reconnectDelayMs: 0,
      resolveRendezvous: () => Promise.resolve(rendezvous),
      wait: () => Promise.resolve(),
    });

    const changes = client.changes()[Symbol.asyncIterator]();
    await expect(changes.next()).rejects.toMatchObject({ code: 'invalid-response' });
    expect(fetches).toBe(2);
  });

  test('rejects an authoritative SSE status older than the preceding snapshot', async () => {
    const newerStatus = { ...fixtureStatus(), generation: 2 };
    const staleStatus = { ...fixtureStatus(), generation: 1 };
    const responses = [Response.json(newerStatus), eventStreamResponse(statusEvent('status-stale', 1, staleStatus))];
    const client = createUsageEngineControlClient({
      fetch: () => Promise.resolve(responses.shift() ?? Response.error()),
      resolveRendezvous: () => Promise.resolve(rendezvous),
    });

    const changes = client.changes()[Symbol.asyncIterator]();
    await expect(changes.next()).rejects.toMatchObject({ code: 'invalid-response' });
  });

  test('expires a silent SSE stream, refreshes status, and reconnects', async () => {
    const paths: string[] = [];
    const responses = [
      Response.json(fixtureStatus()),
      nonCooperativeResponse('text/event-stream'),
      Response.json(fixtureStatus()),
      eventStreamResponse(statusEvent('status-stream-1', 1)),
    ];
    const client = createUsageEngineControlClient({
      eventIdleTimeoutMs: 10,
      fetch: (input) => {
        paths.push(new URL(String(input)).pathname);
        const response = responses.shift();
        if (!response) {
          return Promise.reject(new Error('unexpected fetch'));
        }
        return Promise.resolve(response);
      },
      reconnectDelayMs: 0,
      resolveRendezvous: () => Promise.resolve(rendezvous),
      wait: () => Promise.resolve(),
    });

    const changes = client.changes()[Symbol.asyncIterator]();
    expect((await changes.next()).value?.eventId).toBe('status-stream-1');
    expect(paths).toEqual(['/v1/status', '/v1/events', '/v1/status', '/v1/events']);
    await changes.return?.();
  });

  test('retains an absolute handshake deadline despite frequent SSE heartbeats', async () => {
    const abort = new AbortController();
    const guard = setTimeout(() => abort.abort(), 100);
    const paths: string[] = [];
    const responses = [
      Response.json(fixtureStatus()),
      heartbeatOnlyResponse(),
      Response.json(fixtureStatus()),
      eventStreamResponse(statusEvent('status-stream-1', 1)),
    ];
    const client = createUsageEngineControlClient({
      eventIdleTimeoutMs: 10,
      fetch: (input) => {
        paths.push(new URL(String(input)).pathname);
        return Promise.resolve(responses.shift() ?? Response.error());
      },
      reconnectDelayMs: 0,
      requestTimeoutMs: 10,
      resolveRendezvous: () => Promise.resolve(rendezvous),
      wait: () => Promise.resolve(),
    });

    try {
      const changes = client.changes({ signal: abort.signal })[Symbol.asyncIterator]();
      expect((await changes.next()).value?.eventId).toBe('status-stream-1');
      expect(paths).toEqual(['/v1/status', '/v1/events', '/v1/status', '/v1/events']);
      await changes.return?.();
    } finally {
      clearTimeout(guard);
    }
  });

  test('propagates caller abort while a silent SSE read is pending', async () => {
    const abort = new AbortController();
    const responses = [Response.json(fixtureStatus()), nonCooperativeResponse('text/event-stream')];
    const client = createUsageEngineControlClient({
      eventIdleTimeoutMs: 1000,
      fetch: () => Promise.resolve(responses.shift() ?? Response.error()),
      resolveRendezvous: () => Promise.resolve(rendezvous),
    });

    const changes = client.changes({ signal: abort.signal })[Symbol.asyncIterator]();
    const pending = changes.next();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted', retry: 'never' });
  });

  test('hard-stops a non-cooperative injected reconnect wait on abort', async () => {
    const abort = new AbortController();
    const responses = [Response.json(fixtureStatus()), eventStreamResponse(statusEvent('status-stream-1', 1))];
    const client = createUsageEngineControlClient({
      fetch: () => Promise.resolve(responses.shift() ?? Response.error()),
      reconnectDelayMs: 1,
      resolveRendezvous: () => Promise.resolve(rendezvous),
      wait: () => new Promise<never>(() => undefined),
    });

    const changes = client.changes({ signal: abort.signal })[Symbol.asyncIterator]();
    expect((await changes.next()).value?.event).toBe('status');
    const pending = changes.next();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted', retry: 'never' });
  });

  test('retries a failed status fetch before opening an event stream', async () => {
    const paths: string[] = [];
    let attempt = 0;
    const client = createUsageEngineControlClient({
      fetch: (input) => {
        paths.push(new URL(String(input)).pathname);
        attempt += 1;
        if (attempt === 1) {
          return Promise.reject(new Error('engine starting'));
        }
        if (attempt === 2) {
          return Promise.resolve(Response.json(fixtureStatus()));
        }
        return Promise.resolve(eventStreamResponse(statusEvent('status-stream-1', 1)));
      },
      reconnectDelayMs: 0,
      resolveRendezvous: () => Promise.resolve(rendezvous),
      wait: () => Promise.resolve(),
    });

    const changes = client.changes()[Symbol.asyncIterator]();
    expect((await changes.next()).value?.eventId).toBe('status-stream-1');
    expect(paths).toEqual(['/v1/status', '/v1/status', '/v1/events']);
    await changes.return?.();
  });

  test('reconnects with Last-Event-ID and suppresses replayed sequences', async () => {
    const paths: string[] = [];
    const lastEventIds: (string | null)[] = [];
    const firstPublished = publishedEvent('event-2', 2);
    const freshPublished = publishedEvent('event-3', 3);
    const responses = [
      Response.json(fixtureStatus()),
      eventStreamResponse(statusEvent('status-stream-1', 1), firstPublished),
      Response.json(fixtureStatus()),
      eventStreamResponse(statusEvent('status-stream-2', 2), firstPublished, freshPublished),
    ];
    const client = createUsageEngineControlClient({
      fetch: (input, init) => {
        const request = new Request(input, init);
        paths.push(new URL(request.url).pathname);
        if (new URL(request.url).pathname === '/v1/events') {
          lastEventIds.push(request.headers.get('last-event-id'));
        }
        const response = responses.shift();
        if (!response) {
          return Promise.reject(new Error('unexpected fetch'));
        }
        return Promise.resolve(response);
      },
      reconnectDelayMs: 0,
      resolveRendezvous: () => Promise.resolve(rendezvous),
      wait: () => Promise.resolve(),
    });

    const changes = client.changes()[Symbol.asyncIterator]();
    expect((await changes.next()).value?.eventId).toBe('status-stream-1');
    expect((await changes.next()).value).toEqual(firstPublished);
    expect((await changes.next()).value?.eventId).toBe('status-stream-2');
    expect((await changes.next()).value).toEqual(freshPublished);
    expect(paths).toEqual(['/v1/status', '/v1/events', '/v1/status', '/v1/events']);
    expect(lastEventIds).toEqual([null, 'event-2']);
    await changes.return?.();
  });

  test('clears replay identity when the engine instance rotates', async () => {
    const nextInstanceId = '22222222-2222-4222-8222-222222222222';
    let activeInstanceId = fixtureInstanceId;
    let fetchIndex = 0;
    const lastEventIds: (string | null)[] = [];
    const client = createUsageEngineControlClient({
      fetch: (input, init) => {
        fetchIndex += 1;
        const request = new Request(input, init);
        if (new URL(request.url).pathname === '/v1/events') {
          lastEventIds.push(request.headers.get('last-event-id'));
        }
        if (fetchIndex === 1) {
          return Promise.resolve(Response.json(fixtureStatus()));
        }
        if (fetchIndex === 2) {
          activeInstanceId = nextInstanceId;
          return Promise.resolve(eventStreamResponse(statusEvent('status-old', 1), publishedEvent('event-old', 2)));
        }
        if (fetchIndex === 3) {
          return Promise.resolve(Response.json(fixtureStatus(nextInstanceId)));
        }
        if (fetchIndex === 4) {
          return Promise.resolve(eventStreamResponse(statusEvent('status-new', 1, fixtureStatus(nextInstanceId))));
        }
        return Promise.reject(new Error('unexpected fetch'));
      },
      reconnectDelayMs: 0,
      resolveRendezvous: () =>
        Promise.resolve(
          parseUsageEngineRendezvous({
            instanceId: activeInstanceId,
            port: 41_321,
            protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
            targetId: 'a'.repeat(64),
            token: 'fixture-token-with-at-least-thirty-two-bytes',
          }),
        ),
      wait: () => Promise.resolve(),
    });

    const changes = client.changes()[Symbol.asyncIterator]();
    expect((await changes.next()).value?.eventId).toBe('status-old');
    expect((await changes.next()).value?.eventId).toBe('event-old');
    expect((await changes.next()).value?.eventId).toBe('status-new');
    expect(lastEventIds).toEqual([null, null]);
    await changes.return?.();
  });

  test('rejects an over-budget SSE frame after its authoritative status', async () => {
    const oversizedData = 'é'.repeat(usageEngineControlBounds.maxStatusEventBytes);
    const response = new Response(
      `id: status-stream-1\nevent: usage-engine\ndata: ${JSON.stringify(statusEvent('status-stream-1', 1))}\n\n` +
        `id: event-2\nevent: usage-engine\ndata: ${oversizedData}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
    const responses = [Response.json(fixtureStatus()), response];
    const client = createUsageEngineControlClient({
      fetch: () => Promise.resolve(responses.shift() ?? Response.error()),
      resolveRendezvous: () => Promise.resolve(rendezvous),
    });

    const changes = client.changes()[Symbol.asyncIterator]();
    expect((await changes.next()).value?.event).toBe('status');
    await expect(changes.next()).rejects.toMatchObject({ code: 'response-too-large', retry: 'never' });
  });
});
