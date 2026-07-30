import { afterEach, describe, expect, test } from 'bun:test';
import {
  parseUsageEngineCommandResult,
  parseUsageEngineErrorResponse,
  parseUsageEngineEvent,
  parseUsageEngineStatus,
  USAGE_ENGINE_PROTOCOL_VERSION,
  type UsageEngineCommand,
  type UsageEngineEvent,
  type UsageEngineStatus,
  usageEngineControlBounds,
} from '@ai-usage/usage-engine-control';
import { createUsageEngineBearerToken } from '@ai-usage/usage-engine-control/node';
import type { UsageEngineRuntimeHost } from '@ai-usage/usage-engine-runtime';
import { createInitialUsageEngineSourceControlView } from '@ai-usage/usage-engine-runtime';
import {
  createUsageEngineControlHandler,
  startUsageEngineControlServer,
  usageEngineControlServerBounds,
} from './control-server';

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'a'.repeat(43);
const NOW = '2026-07-29T12:00:00.000Z';
const SSE_FRAME_ID_PATTERN = /^id: ([^\n]+)$/m;
const servers: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()));
});

const fixtureStatus = (): UsageEngineStatus =>
  parseUsageEngineStatus({
    currentPublication: null,
    degradedReason: null,
    generatedAt: NOW,
    generation: 1,
    instanceId: INSTANCE_ID,
    protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    readiness: 'ready',
    sourceControl: createInitialUsageEngineSourceControlView(INSTANCE_ID, new Date(NOW)),
    storeSchemaVersion: 14,
  });

interface RuntimeFixture {
  readonly commands: Array<{ command: UsageEngineCommand; commandId: string }>;
  readonly flush: () => Promise<void>;
  readonly publish: (event: UsageEngineEvent) => void;
  readonly runtime: UsageEngineRuntimeHost;
}

const createRuntime = (): RuntimeFixture => {
  const commands: RuntimeFixture['commands'] = [];
  const listeners = new Set<(event: UsageEngineEvent) => void>();
  const flushWaiters = new Set<() => void>();
  let processedPublicationCount = 0;
  let publicationCount = 0;
  let disposed = false;
  const runtime: UsageEngineRuntimeHost = {
    changes: () => ({
      [Symbol.asyncIterator]: () => {
        const queue: UsageEngineEvent[] = [];
        let pending: ((result: IteratorResult<UsageEngineEvent>) => void) | undefined;
        const listener = (event: UsageEngineEvent): void => {
          if (pending) {
            const resolve = pending;
            pending = undefined;
            resolve({ done: false, value: event });
          } else {
            queue.push(event);
          }
        };
        listeners.add(listener);
        return {
          next: () => {
            const event = queue.shift();
            if (event) {
              return Promise.resolve({ done: false as const, value: event });
            }
            if (disposed) {
              return Promise.resolve({ done: true as const, value: undefined });
            }
            processedPublicationCount = publicationCount;
            for (const resolve of flushWaiters) {
              resolve();
            }
            flushWaiters.clear();
            return new Promise<IteratorResult<UsageEngineEvent>>((resolve) => {
              pending = resolve;
            });
          },
          return: () => {
            listeners.delete(listener);
            pending?.({ done: true, value: undefined });
            return Promise.resolve({ done: true as const, value: undefined });
          },
        };
      },
    }),
    dispose: () => {
      disposed = true;
      return Promise.resolve();
    },
    disposeRetainingWriterLease: () => {
      disposed = true;
      return Promise.resolve();
    },
    execute: async (command) => await runtime.executeCommand(command, crypto.randomUUID()),
    executeCommand: (command, commandId) => {
      commands.push({ command, commandId });
      return Promise.resolve(
        parseUsageEngineCommandResult({
          admission: 'accepted',
          commandId,
          instanceId: INSTANCE_ID,
          ok: true,
          protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
        }),
      );
    },
    start: () => Promise.resolve(),
    status: () => Promise.resolve(fixtureStatus()),
    waitForCommand: () => Promise.reject(new Error('No command completion was requested by this test.')),
    waitForIdle: () => Promise.resolve(),
  };
  return {
    commands,
    flush: () => {
      if (processedPublicationCount >= publicationCount) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => flushWaiters.add(resolve));
    },
    publish: (event) => {
      publicationCount++;
      for (const listener of listeners) {
        listener(event);
      }
    },
    runtime,
  };
};

const headers = (overrides: Record<string, string> = {}): Headers =>
  new Headers({
    authorization: `Bearer ${TOKEN}`,
    'x-ai-usage-protocol-version': String(USAGE_ENGINE_PROTOCOL_VERSION),
    ...overrides,
  });

const commandRequest = (command: UsageEngineCommand, commandId = 'command-1'): string =>
  JSON.stringify({ command, commandId, protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION });

const completionEvent = (sequence: number, commandId = `command-${sequence}`): UsageEngineEvent =>
  parseUsageEngineEvent({
    completion: {
      command: 'publish',
      commandId,
      completedAt: NOW,
      output: { kind: 'none' },
      state: 'succeeded',
    },
    event: 'command-completed',
    eventId: `engine:${sequence}`,
    instanceId: INSTANCE_ID,
    sequence,
  });

const readFrame = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const result = await reader.read();
  if (result.done) {
    return '';
  }
  return new TextDecoder().decode(result.value);
};

const frameId = (frame: string): string => frame.match(SSE_FRAME_ID_PATTERN)?.[1] ?? '';

describe('usage engine control server', () => {
  test('authenticates status and commands while preserving the caller command ID', async () => {
    const fixture = createRuntime();
    const handler = createUsageEngineControlHandler({
      runtime: fixture.runtime,
      token: createUsageEngineBearerToken(TOKEN),
    });
    servers.push(handler);
    const statusResponse = await handler.handle(
      new Request('http://127.0.0.1:41052/v1/status', { headers: headers() }),
      '127.0.0.1',
    );
    expect(statusResponse.status).toBe(200);
    expect(parseUsageEngineStatus(await statusResponse.json())).toMatchObject({ instanceId: INSTANCE_ID });

    const response = await handler.handle(
      new Request('http://127.0.0.1:41052/v1/commands', {
        body: commandRequest({ command: 'run-source', sourceId: 'codex.sessions' }, 'caller-command'),
        headers: headers({ 'content-type': 'application/json' }),
        method: 'POST',
      }),
      '127.0.0.1',
    );
    expect(response.status).toBe(200);
    expect(parseUsageEngineCommandResult(await response.json())).toMatchObject({ commandId: 'caller-command' });
    expect(fixture.commands).toEqual([
      { command: { command: 'run-source', sourceId: 'codex.sessions' }, commandId: 'caller-command' },
    ]);
  });

  test('rejects missing auth, protocol mismatch, non-loopback peers, and non-numeric hosts', async () => {
    const fixture = createRuntime();
    const handler = createUsageEngineControlHandler({
      runtime: fixture.runtime,
      token: createUsageEngineBearerToken(TOKEN),
    });
    servers.push(handler);

    const unauthenticated = await handler.handle(
      new Request('http://127.0.0.1:41052/v1/status', {
        headers: headers({ authorization: 'Bearer wrong-token-that-is-still-long-enough' }),
      }),
      '127.0.0.1',
    );
    expect(unauthenticated.status).toBe(401);
    expect(JSON.stringify(await unauthenticated.json())).not.toContain(TOKEN);

    const mismatch = await handler.handle(
      new Request('http://127.0.0.1:41052/v1/status', {
        headers: headers({ 'x-ai-usage-protocol-version': '999' }),
      }),
      '127.0.0.1',
    );
    expect(mismatch.status).toBe(426);

    const foreignPeer = await handler.handle(
      new Request('http://127.0.0.1:41052/v1/status', { headers: headers() }),
      '192.0.2.10',
    );
    expect(foreignPeer.status).toBe(403);

    const namedHost = await handler.handle(
      new Request('http://localhost:41052/v1/status', { headers: headers() }),
      '127.0.0.1',
    );
    expect(namedHost.status).toBe(403);
  });

  test('bounds request bodies and exposes no report data route', async () => {
    const fixture = createRuntime();
    const handler = createUsageEngineControlHandler({
      runtime: fixture.runtime,
      token: createUsageEngineBearerToken(TOKEN),
    });
    servers.push(handler);
    const oversized = await handler.handle(
      new Request('http://127.0.0.1:41052/v1/commands', {
        body: 'x'.repeat(usageEngineControlBounds.maxCommandBytes + 1),
        headers: headers({ 'content-type': 'application/json' }),
        method: 'POST',
      }),
      '127.0.0.1',
    );
    expect(oversized.status).toBe(413);

    for (const path of ['/v1/report', '/v1/sessions', '/v1/quota', '/graphql']) {
      const response = await handler.handle(
        new Request(`http://127.0.0.1:41052${path}`, { headers: headers() }),
        '127.0.0.1',
      );
      expect(response.status).toBe(404);
    }
    expect(fixture.commands).toEqual([]);
  });

  test('times out a non-cooperative command body without admitting it', async () => {
    const fixture = createRuntime();
    let cancellations = 0;
    const handler = createUsageEngineControlHandler({
      requestTimeoutMs: 10,
      runtime: fixture.runtime,
      token: createUsageEngineBearerToken(TOKEN),
    });
    servers.push(handler);
    const response = await handler.handle(
      new Request('http://127.0.0.1:41052/v1/commands', {
        body: new ReadableStream<Uint8Array>({
          cancel: () => {
            cancellations += 1;
          },
        }),
        headers: headers({ 'content-type': 'application/json' }),
        method: 'POST',
      }),
      '127.0.0.1',
    );

    expect(response.status).toBe(408);
    expect(parseUsageEngineErrorResponse(await response.json())).toMatchObject({ error: { code: 'timeout' } });
    expect(fixture.commands).toEqual([]);
    expect(cancellations).toBe(1);
  });

  test('does not admit a fully buffered command after its request was aborted', async () => {
    const fixture = createRuntime();
    const handler = createUsageEngineControlHandler({
      runtime: fixture.runtime,
      token: createUsageEngineBearerToken(TOKEN),
    });
    servers.push(handler);
    const abortController = new AbortController();
    const request = new Request('http://127.0.0.1:41052/v1/commands', {
      body: commandRequest({ command: 'publish' }, 'aborted-command'),
      headers: headers({ 'content-type': 'application/json' }),
      method: 'POST',
      signal: abortController.signal,
    });
    abortController.abort();

    const response = await handler.handle(request, '127.0.0.1');

    expect(response.status).toBe(408);
    expect(parseUsageEngineErrorResponse(await response.json())).toMatchObject({ error: { code: 'aborted' } });
    expect(fixture.commands).toEqual([]);
  });

  test('starts every SSE stream with authoritative status and then emits bounded engine events', async () => {
    const fixture = createRuntime();
    const handler = createUsageEngineControlHandler({
      runtime: fixture.runtime,
      token: createUsageEngineBearerToken(TOKEN),
    });
    servers.push(handler);
    const response = await handler.handle(
      new Request('http://127.0.0.1:41052/v1/events', {
        headers: headers({ accept: 'text/event-stream' }),
      }),
      '127.0.0.1',
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain('event: usage-engine');
    expect(first).toContain('"event":"status"');

    fixture.publish(
      parseUsageEngineEvent({
        completion: {
          command: 'publish',
          commandId: 'command-1',
          completedAt: NOW,
          output: { kind: 'none' },
          state: 'succeeded',
        },
        event: 'command-completed',
        eventId: 'engine:2',
        instanceId: INSTANCE_ID,
        sequence: 2,
      }),
    );
    const second = decoder.decode((await reader.read()).value);
    expect(second).toContain('"event":"command-completed"');
    await reader.cancel();
  });

  test('emits a fresh status before live events without replaying stale state', async () => {
    const fixture = createRuntime();
    const handler = createUsageEngineControlHandler({
      runtime: fixture.runtime,
      token: createUsageEngineBearerToken(TOKEN),
    });
    servers.push(handler);
    fixture.publish(
      parseUsageEngineEvent({
        event: 'status',
        eventId: 'engine:1',
        instanceId: INSTANCE_ID,
        sequence: 1,
        status: fixtureStatus(),
      }),
    );
    await fixture.flush();
    const response = await handler.handle(
      new Request('http://127.0.0.1:41052/v1/events', {
        headers: headers({ accept: 'text/event-stream' }),
      }),
      '127.0.0.1',
    );
    const reader = response.body!.getReader();
    expect(await readFrame(reader)).toContain('"event":"status"');

    fixture.publish(completionEvent(2));
    await fixture.flush();
    const second = await readFrame(reader);
    expect(second).toContain('id: engine:2');
    expect(second).not.toContain('id: engine:1');
    await reader.cancel();
  });

  test('replays a missed command completion after the fresh reconnect status', async () => {
    const fixture = createRuntime();
    const handler = createUsageEngineControlHandler({
      runtime: fixture.runtime,
      token: createUsageEngineBearerToken(TOKEN),
    });
    servers.push(handler);
    const firstResponse = await handler.handle(
      new Request('http://127.0.0.1:41052/v1/events', {
        headers: headers({ accept: 'text/event-stream' }),
      }),
      '127.0.0.1',
    );
    const firstReader = firstResponse.body!.getReader();
    const initialStatusId = frameId(await readFrame(firstReader));
    await firstReader.cancel();
    fixture.publish(completionEvent(1, 'missed-command'));
    await fixture.flush();

    const reconnect = await handler.handle(
      new Request('http://127.0.0.1:41052/v1/events', {
        headers: headers({ accept: 'text/event-stream', 'last-event-id': initialStatusId }),
      }),
      '127.0.0.1',
    );
    const reconnectReader = reconnect.body!.getReader();
    expect(await readFrame(reconnectReader)).toContain('"event":"status"');
    const replay = await readFrame(reconnectReader);
    expect(replay).toContain('"event":"command-completed"');
    expect(replay).toContain('"commandId":"missed-command"');
    await reconnectReader.cancel();
  });

  test('replays bounded command completions on a first event subscription', async () => {
    const fixture = createRuntime();
    const handler = createUsageEngineControlHandler({
      runtime: fixture.runtime,
      token: createUsageEngineBearerToken(TOKEN),
    });
    servers.push(handler);
    fixture.publish(completionEvent(1, 'completed-before-subscribe'));
    await fixture.flush();

    const response = await handler.handle(
      new Request('http://127.0.0.1:41052/v1/events', {
        headers: headers({ accept: 'text/event-stream' }),
      }),
      '127.0.0.1',
    );
    const reader = response.body!.getReader();
    expect(await readFrame(reader)).toContain('"event":"status"');
    const replay = await Promise.race([readFrame(reader), Bun.sleep(50).then(() => 'timed-out')]);
    await reader.cancel();

    expect(replay).toContain('"commandId":"completed-before-subscribe"');
  });

  test('does not install a heartbeat after replay and pending frames close a full stream', async () => {
    const fixture = createRuntime();
    let heartbeatSchedules = 0;
    const runtime: UsageEngineRuntimeHost = {
      ...fixture.runtime,
      status: async () => {
        fixture.publish(completionEvent(usageEngineControlServerBounds.maxReplayEvents + 1, 'pending-command'));
        await fixture.flush();
        return fixtureStatus();
      },
    };
    const handler = createUsageEngineControlHandler({
      clearHeartbeat: () => undefined,
      runtime,
      scheduleHeartbeat: () => {
        heartbeatSchedules++;
        return 1 as never;
      },
      token: createUsageEngineBearerToken(TOKEN),
    });
    servers.push(handler);
    for (let sequence = 1; sequence <= usageEngineControlServerBounds.maxReplayEvents; sequence++) {
      fixture.publish(completionEvent(sequence));
    }
    await fixture.flush();

    const response = await handler.handle(
      new Request('http://127.0.0.1:41052/v1/events', {
        headers: headers({ accept: 'text/event-stream' }),
      }),
      '127.0.0.1',
    );
    const reader = response.body!.getReader();
    while (!(await reader.read()).done) {
      // Drain the bounded replay until the pending frame closes the stream.
    }

    expect(heartbeatSchedules).toBe(0);
  });

  test('rejects event subscribers beyond the process-wide bound', async () => {
    const fixture = createRuntime();
    const handler = createUsageEngineControlHandler({
      runtime: fixture.runtime,
      token: createUsageEngineBearerToken(TOKEN),
    });
    servers.push(handler);
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    for (let index = 0; index < usageEngineControlServerBounds.maxSubscribers; index++) {
      const response = await handler.handle(
        new Request('http://127.0.0.1:41052/v1/events', {
          headers: headers({ accept: 'text/event-stream' }),
        }),
        '127.0.0.1',
      );
      expect(response.status).toBe(200);
      readers.push(response.body!.getReader());
    }

    const rejected = await handler.handle(
      new Request('http://127.0.0.1:41052/v1/events', {
        headers: headers({ accept: 'text/event-stream' }),
      }),
      '127.0.0.1',
    );
    expect(rejected.status).toBe(503);
    await Promise.all(readers.map(async (reader) => await reader.cancel()));
  });

  test('closes a slow SSE subscriber at the bounded frame capacity', async () => {
    const fixture = createRuntime();
    const handler = createUsageEngineControlHandler({
      runtime: fixture.runtime,
      token: createUsageEngineBearerToken(TOKEN),
    });
    servers.push(handler);
    const response = await handler.handle(
      new Request('http://127.0.0.1:41052/v1/events', {
        headers: headers({ accept: 'text/event-stream' }),
      }),
      '127.0.0.1',
    );
    const reader = response.body!.getReader();
    for (let sequence = 1; sequence <= usageEngineControlServerBounds.maxSubscriberFrames; sequence++) {
      fixture.publish(completionEvent(sequence));
    }
    await fixture.flush();

    let frames = 0;
    while (frames <= usageEngineControlServerBounds.maxSubscriberFrames) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      frames++;
    }
    expect(frames).toBeLessThanOrEqual(usageEngineControlServerBounds.maxSubscriberFrames);
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  test('binds only numeric loopback and serves the same authenticated handler', async () => {
    const fixture = createRuntime();
    const server = await startUsageEngineControlServer({
      hostname: '127.0.0.1',
      port: 0,
      runtime: fixture.runtime,
      token: createUsageEngineBearerToken(TOKEN),
    });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/status`, { headers: headers() });
    expect(response.status).toBe(200);
    await expect(
      startUsageEngineControlServer({
        hostname: 'localhost',
        port: 0,
        runtime: fixture.runtime,
        token: createUsageEngineBearerToken(TOKEN),
      }),
    ).rejects.toThrow('numeric 127.0.0.1');
  });
});
