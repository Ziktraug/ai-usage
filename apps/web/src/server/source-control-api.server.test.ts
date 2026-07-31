import { describe, expect, test } from 'bun:test';
import {
  collectionSourceDefinitions,
  parseSourceControlSnapshot,
  type SourceControlView,
} from '@ai-usage/report-core/source-control';
import {
  parseUsageEngineCommandResult,
  parseUsageEngineEvent,
  parseUsageEngineStatus,
  USAGE_ENGINE_PROTOCOL_VERSION,
  type UsageEngineCommand,
  type UsageEngineStatus,
} from '@ai-usage/usage-engine-control';
import { type UsageEngineControlClient, UsageEngineControlError } from '@ai-usage/usage-engine-control/client';
import { createInMemoryUsageEngineControlClient } from '@ai-usage/usage-engine-control/testing';
import { USAGE_STORE_SCHEMA_VERSION } from '@ai-usage/usage-store/reader';
import {
  applySourceControlCommandForServer,
  createSourceControlEventStream,
  handleSourceControlCommandRequest,
} from './source-control-api.server';

const INSTANCE_ID = 'source-control-test-engine';

const trustedRequest = (signal?: AbortSignal, headers: Record<string, string> = {}): Request =>
  new Request('http://localhost:3000/api/source-control', {
    headers: {
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    ...(signal === undefined ? {} : { signal }),
  });

const commandRequest = (value: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Request =>
  new Request('http://localhost:3000/api/source-control/command', {
    body: JSON.stringify(value),
    headers: {
      'content-type': 'application/json',
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    method: 'POST',
    ...(signal === undefined ? {} : { signal }),
  });

const streamingCommandRequest = (body: ReadableStream<Uint8Array>, signal: AbortSignal): Request => {
  const options: RequestInit & { duplex: 'half' } = {
    body,
    duplex: 'half',
    headers: {
      'content-type': 'application/json',
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      'sec-fetch-site': 'same-origin',
    },
    method: 'POST',
    signal,
  };
  return new Request('http://localhost:3000/api/source-control/command', options);
};

const snapshot = (generation: number, instanceId = INSTANCE_ID): SourceControlView =>
  parseSourceControlSnapshot({
    generatedAt: new Date(generation).toISOString(),
    generation,
    instanceId,
    publication: {
      acknowledgedRequestGeneration: 1,
      dirty: false,
      dirtyGeneration: 1,
      lastOutcome: 'success',
      lastPublishedAt: '2026-07-16T10:00:00.000Z',
      pendingDemand: false,
      publishedGeneration: 1,
      queued: false,
      requestedGeneration: 1,
      revision: 'revision-a',
      rtkCompletedGeneration: 1,
      rtkRequiredGeneration: 1,
      running: false,
    },
    queueDepth: 0,
    runningCount: 0,
    sources: collectionSourceDefinitions.map((definition) => ({
      availability: 'detected',
      cadenceMs: definition.cadenceMs,
      id: definition.id,
      label: definition.label,
      lastOutcome: 'success',
      lifecycle: 'scheduled',
      policy: 'enabled',
      reason: { code: 'none' },
      warnings: [],
    })),
  });

const status = (
  sourceControl = snapshot(0),
  options: { readonly readiness?: UsageEngineStatus['readiness']; readonly storeSchemaVersion?: number } = {},
): UsageEngineStatus => {
  const readiness = options.readiness ?? 'ready';
  return parseUsageEngineStatus({
    currentPublication: {
      publishedAt: sourceControl.publication.lastPublishedAt,
      revision: sourceControl.publication.revision,
    },
    degradedReason: readiness === 'degraded' ? { code: 'fixture-degraded', message: 'Fixture degraded.' } : null,
    generatedAt: '2026-07-16T10:00:00.000Z',
    generation: sourceControl.generation,
    instanceId: sourceControl.instanceId,
    protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    readiness,
    sourceControl,
    storeSchemaVersion: options.storeSchemaVersion ?? USAGE_STORE_SCHEMA_VERSION,
  });
};

const readTextChunk = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const chunk = await reader.read();
  if (chunk.done) {
    throw new Error('The source-control stream closed unexpectedly.');
  }
  return new TextDecoder().decode(chunk.value);
};

const readEvent = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  eventName: string,
): Promise<Record<string, unknown>> => {
  for (let attempt = 0; attempt < 12; attempt++) {
    const text = await readTextChunk(reader);
    if (!text.includes(`event: ${eventName}\n`)) {
      continue;
    }
    const data = text
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice(6);
    if (data) {
      return JSON.parse(data) as Record<string, unknown>;
    }
  }
  throw new Error(`The stream did not emit ${eventName}.`);
};

describe('source-control usage engine proxy', () => {
  test('maps every browser command to the bounded usage engine command catalogue', async () => {
    const adapter = createInMemoryUsageEngineControlClient({ status: status() });
    const commands = [
      { command: 'detect-all' as const },
      { command: 'run-all' as const },
      { command: 'run-now' as const, sourceId: 'codex.sessions' as const },
      { command: 'set-enabled' as const, enabled: false, sourceId: 'claude.sessions' as const },
    ];

    for (const command of commands) {
      expect(await applySourceControlCommandForServer(command, adapter.client)).toMatchObject({
        accepted: true,
        ok: true,
        snapshot: { generation: 0 },
      });
    }

    expect(adapter.commands).toEqual<UsageEngineCommand[]>([
      { command: 'detect-all' },
      { command: 'run-all-enabled' },
      { command: 'run-source', sourceId: 'codex.sessions' },
      { command: 'set-source-enabled', enabled: false, sourceId: 'claude.sessions' },
    ]);
    adapter.dispose();
  });

  test('enforces local trust and strict bounded command JSON before resolving control', async () => {
    let controlCalls = 0;
    const control: UsageEngineControlClient = {
      changes: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
      }),
      execute: () => {
        controlCalls += 1;
        return Promise.reject(new Error('Unexpected command.'));
      },
      getStatus: () => Promise.resolve(status()),
    };
    const malformed = await handleSourceControlCommandRequest(
      commandRequest({ command: 'run-all', unexpected: true }),
      control,
    );
    const hostile = await handleSourceControlCommandRequest(
      commandRequest({ command: 'detect-all' }, { host: 'attacker.example', origin: 'http://attacker.example' }),
      control,
    );
    const oversized = await handleSourceControlCommandRequest(
      commandRequest({ command: 'detect-all' }, { 'content-length': '4097' }),
      control,
    );

    expect(malformed.status).toBe(400);
    expect(hostile.status).toBe(403);
    expect(oversized.status).toBe(413);
    expect(controlCalls).toBe(0);
  });

  test('returns stable command failures without exposing engine details or paths', async () => {
    const adapter = createInMemoryUsageEngineControlClient({ status: status() });
    const control: UsageEngineControlClient = {
      ...adapter.client,
      execute: () =>
        Promise.reject(
          new UsageEngineControlError(
            'transport-failed',
            'command',
            'secret provider response at /home/user/.config/private',
          ),
        ),
    };

    const result = await applySourceControlCommandForServer(
      { command: 'run-now', sourceId: 'claude.sessions' },
      control,
    );

    expect(result).toEqual({
      error: {
        message: 'The usage engine is unavailable.',
        reason: 'transport-failed',
        tag: 'SourceControlCommandError',
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain('secret provider');
    expect(JSON.stringify(result)).not.toContain('/home/');
    adapter.dispose();
  });

  test('rejects degraded and schema-mismatched commands before mutation admission', async () => {
    const cases = [
      {
        expectedReason: 'engine-unavailable',
        status: status(snapshot(0), { readiness: 'degraded' }),
      },
      {
        expectedReason: 'protocol-mismatch',
        status: status(snapshot(0), { storeSchemaVersion: USAGE_STORE_SCHEMA_VERSION + 1 }),
      },
    ] as const;

    for (const testCase of cases) {
      const adapter = createInMemoryUsageEngineControlClient({ status: testCase.status });
      const result = await applySourceControlCommandForServer({ command: 'detect-all' }, adapter.client);

      expect(result).toMatchObject({ error: { reason: testCase.expectedReason }, ok: false });
      expect(adapter.commands).toEqual([]);
      adapter.dispose();
    }
  });

  test('propagates the request AbortSignal through source command preflight, admission, and refresh', async () => {
    const observedSignals: Array<AbortSignal | undefined> = [];
    const control: UsageEngineControlClient = {
      changes: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
      }),
      execute: (_command, options) => {
        observedSignals.push(options?.signal);
        return Promise.resolve(
          parseUsageEngineCommandResult({
            admission: 'accepted',
            commandId: 'signal-command',
            instanceId: INSTANCE_ID,
            ok: true,
            protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
          }),
        );
      },
      getStatus: (options) => {
        observedSignals.push(options?.signal);
        return Promise.resolve(status());
      },
    };
    const request = commandRequest({ command: 'detect-all' });

    const response = await handleSourceControlCommandRequest(request, control);

    expect(response.status).toBe(200);
    expect(observedSignals).toEqual([request.signal, request.signal, request.signal]);
  });

  test('does not admit an already-aborted source command', async () => {
    const adapter = createInMemoryUsageEngineControlClient({ status: status() });
    const abort = new AbortController();
    abort.abort();

    const result = await applySourceControlCommandForServer({ command: 'detect-all' }, adapter.client, {
      signal: abort.signal,
    });

    expect(result).toMatchObject({ error: { reason: 'aborted' }, ok: false });
    expect(adapter.commands).toEqual([]);
    adapter.dispose();
  });

  test('cancels a blocked command body when the request is aborted before admission', async () => {
    const abort = new AbortController();
    let bodyCancels = 0;
    let controlCalls = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        bodyCancels += 1;
      },
      pull: () => new Promise<void>(() => undefined),
    });
    const control: UsageEngineControlClient = {
      changes: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
      }),
      execute: () => {
        controlCalls += 1;
        return Promise.reject(new Error('Unexpected command.'));
      },
      getStatus: () => {
        controlCalls += 1;
        return Promise.resolve(status());
      },
    };
    const responsePromise = handleSourceControlCommandRequest(streamingCommandRequest(body, abort.signal), control);
    await Promise.resolve();

    abort.abort();
    const response = await responsePromise;

    expect(response.status).toBe(499);
    expect(bodyCancels).toBe(1);
    expect(controlCalls).toBe(0);
  });

  test('starts SSE from engine status and projects source and publication events', async () => {
    const adapter = createInMemoryUsageEngineControlClient({ status: status() });
    const response = createSourceControlEventStream(trustedRequest(), {
      control: adapter.client,
      scheduleHealthCheck: () => () => undefined,
      scheduleHeartbeat: () => () => undefined,
    });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Expected an SSE response body.');
    }

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await readTextChunk(reader)).toContain('retry: 3000');
    expect(await readEvent(reader, 'snapshot')).toMatchObject({ generation: 0, instanceId: INSTANCE_ID });
    expect(await readEvent(reader, 'control-state')).toEqual({ state: 'live' });

    const nextSnapshot = snapshot(1);
    adapter.publish(
      parseUsageEngineEvent({
        event: 'source-control',
        eventId: 'source:1',
        instanceId: INSTANCE_ID,
        sequence: 1,
        snapshot: nextSnapshot,
      }),
    );
    adapter.publish(
      parseUsageEngineEvent({
        event: 'report-published',
        eventId: 'publication:2',
        instanceId: INSTANCE_ID,
        publication: {
          instanceId: INSTANCE_ID,
          publishedAt: '2026-07-16T11:00:00.000Z',
          revision: 'revision-b',
          sourceControlGeneration: 1,
        },
        sequence: 2,
      }),
    );

    expect(await readEvent(reader, 'snapshot')).toMatchObject({ generation: 1 });
    expect(await readEvent(reader, 'report-published')).toMatchObject({ revision: 'revision-b' });
    await reader.cancel();
    adapter.dispose();
  });

  test('emits an explicit disconnected state when initial engine status is unavailable', async () => {
    const control: UsageEngineControlClient = {
      changes: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
      }),
      execute: () => Promise.reject(new Error('Unexpected command.')),
      getStatus: () =>
        Promise.reject(new UsageEngineControlError('engine-unavailable', 'status', 'private rendezvous missing')),
    };
    const response = createSourceControlEventStream(trustedRequest(), { control });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Expected an SSE response body.');
    }

    expect(await readTextChunk(reader)).toContain('retry: 3000');
    expect(await readEvent(reader, 'control-state')).toEqual({ state: 'disconnected' });
    expect((await reader.read()).done).toBe(true);
  });

  test('preserves the last snapshot but reports a store schema mismatch explicitly', async () => {
    const adapter = createInMemoryUsageEngineControlClient({
      status: status(snapshot(4), { storeSchemaVersion: USAGE_STORE_SCHEMA_VERSION + 1 }),
    });
    const response = createSourceControlEventStream(trustedRequest(), { control: adapter.client });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Expected an SSE response body.');
    }

    await readTextChunk(reader);
    expect(await readEvent(reader, 'snapshot')).toMatchObject({ generation: 4 });
    expect(await readEvent(reader, 'control-state')).toEqual({ state: 'protocol-mismatch' });
    expect((await reader.read()).done).toBe(true);
    adapter.dispose();
  });

  test('health checks turn a reconnecting event client into an explicit disconnected stream', async () => {
    const adapter = createInMemoryUsageEngineControlClient({ status: status() });
    let statusCalls = 0;
    let runHealthCheck: (() => void) | undefined;
    const control: UsageEngineControlClient = {
      ...adapter.client,
      getStatus: (options) => {
        statusCalls += 1;
        return statusCalls === 1
          ? adapter.client.getStatus(options)
          : Promise.reject(new UsageEngineControlError('transport-failed', 'status', 'engine stopped'));
      },
    };
    const response = createSourceControlEventStream(trustedRequest(), {
      control,
      scheduleHealthCheck: (operation) => {
        runHealthCheck = operation;
        return () => undefined;
      },
      scheduleHeartbeat: () => () => undefined,
    });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Expected an SSE response body.');
    }
    await readTextChunk(reader);
    await readEvent(reader, 'snapshot');
    await readEvent(reader, 'control-state');

    runHealthCheck?.();

    expect(await readEvent(reader, 'control-state')).toEqual({ state: 'disconnected' });
    expect((await reader.read()).done).toBe(true);
    adapter.dispose();
  });

  test('cleans up the engine event subscription and timers on request abort', async () => {
    const adapter = createInMemoryUsageEngineControlClient({ status: status() });
    const abortController = new AbortController();
    let cleanupCount = 0;
    let timerCleanupCount = 0;
    const response = createSourceControlEventStream(trustedRequest(abortController.signal), {
      control: adapter.client,
      onCleanup: () => {
        cleanupCount += 1;
      },
      scheduleHealthCheck: () => () => {
        timerCleanupCount += 1;
      },
      scheduleHeartbeat: () => () => {
        timerCleanupCount += 1;
      },
    });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Expected an SSE response body.');
    }
    await readTextChunk(reader);
    await readEvent(reader, 'snapshot');
    await readEvent(reader, 'control-state');

    abortController.abort();

    expect((await reader.read()).done).toBe(true);
    expect(cleanupCount).toBe(1);
    expect(timerCleanupCount).toBe(2);
    adapter.dispose();
  });

  test('does not initialize an SSE engine client for an already-aborted request', async () => {
    const abortController = new AbortController();
    abortController.abort();
    let cleanupCount = 0;
    let resolveCount = 0;
    const response = createSourceControlEventStream(trustedRequest(abortController.signal), {
      onCleanup: () => {
        cleanupCount += 1;
      },
      resolveControl: () => {
        resolveCount += 1;
        return Promise.reject(new Error('Unexpected control resolution.'));
      },
    });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Expected an SSE response body.');
    }

    expect((await reader.read()).done).toBe(true);
    expect(resolveCount).toBe(0);
    expect(cleanupCount).toBe(1);
  });
});
