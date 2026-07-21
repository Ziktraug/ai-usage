import { describe, expect, test } from 'bun:test';
import type { CollectionSourceId, SourceControlView } from '@ai-usage/report-core/source-control';
import type { WebSourceControlRuntime } from './source-control.server';
import {
  applySourceControlCommandForServer,
  createSourceControlEventStream,
  handleSourceControlCommandRequest,
  type SourceControlStreamRuntime,
} from './source-control-api.server';

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

const commandRequest = (value: unknown, headers: Record<string, string> = {}): Request =>
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
  });

const snapshot = (generation: number, instanceId = 'instance-a'): SourceControlView => ({
  generatedAt: new Date(generation).toISOString(),
  generation,
  instanceId,
  publication: {
    acknowledgedRequestGeneration: 1,
    dirty: false,
    dirtyGeneration: 0,
    lastOutcome: 'success',
    pendingDemand: false,
    publishedGeneration: 0,
    queued: false,
    requestedGeneration: 1,
    rtkCompletedGeneration: 0,
    rtkRequiredGeneration: 0,
    running: false,
  },
  queueDepth: 0,
  runningCount: 0,
  sources: [
    {
      availability: 'detected',
      cadenceMs: 60_000,
      id: 'claude.sessions',
      label: 'Claude sessions',
      lastOutcome: 'success',
      lifecycle: 'scheduled',
      policy: 'enabled',
      reason: { code: 'none' },
      warnings: [],
    },
  ],
});

const streamRuntime = (initial = snapshot(0)) => {
  let current = initial;
  const listeners = new Set<(value: SourceControlView) => void>();
  let unsubscribeCount = 0;
  return {
    emit: (value: SourceControlView) => {
      current = value;
      for (const listener of listeners) {
        listener(value);
      }
    },
    runtime: {
      getSnapshot: async () => current,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          if (listeners.delete(listener)) {
            unsubscribeCount++;
          }
        };
      },
    } satisfies SourceControlStreamRuntime,
    unsubscribeCount: () => unsubscribeCount,
  };
};

const readTextChunk = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const chunk = await reader.read();
  if (chunk.done) {
    throw new Error('The source-control stream closed unexpectedly.');
  }
  return new TextDecoder().decode(chunk.value);
};

const readSnapshotEvent = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ generation: number; instanceId: string }> => {
  for (let attempts = 0; attempts < 3; attempts++) {
    const text = await readTextChunk(reader);
    const data = text
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice(6);
    if (data) {
      return JSON.parse(data) as {
        generation: number;
        instanceId: string;
      };
    }
  }
  throw new Error('The stream did not emit a snapshot event.');
};

const commandRuntime = (): {
  runtime: WebSourceControlRuntime;
  state: () => SourceControlView;
} => {
  let current = snapshot(0);
  const listeners = new Set<(value: SourceControlView) => void>();
  const update = () => {
    current = snapshot(current.generation + 1);
    for (const listener of listeners) {
      listener(current);
    }
  };
  return {
    runtime: {
      detectAll: async () => update(),
      dispose: async () => undefined,
      getSnapshot: async () => current,
      requestPublication: async () => true,
      runAllEnabled: () => {
        update();
        return Promise.resolve(1);
      },
      runEffect: () => Promise.reject(new Error('Unexpected runEffect call.')),
      runNow: (_sourceId: CollectionSourceId) => {
        update();
        return Promise.resolve(true);
      },
      setEnabled: async () => update(),
      start: async () => current,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    state: () => current,
  };
};

describe('source-control server API', () => {
  test('rejects untrusted SSE requests before subscribing', async () => {
    const source = streamRuntime();
    const response = createSourceControlEventStream(
      trustedRequest(undefined, {
        host: 'attacker.example',
        origin: 'http://attacker.example',
      }),
      { runtime: source.runtime },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { tag: 'UntrustedHost' },
      ok: false,
    });
    expect(source.unsubscribeCount()).toBe(0);
  });

  test('starts with the authoritative snapshot and identifies the process', async () => {
    const source = streamRuntime(snapshot(7, 'process-one'));
    const response = createSourceControlEventStream(trustedRequest(), {
      runtime: source.runtime,
    });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Expected an SSE response body.');
    }

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await readTextChunk(reader)).toContain('retry: 3000');
    expect(await readSnapshotEvent(reader)).toMatchObject({
      generation: 7,
      instanceId: 'process-one',
    });
    await reader.cancel();
    expect(source.unsubscribeCount()).toBe(1);
  });

  test('disables runtime idle timeouts for the long-lived stream', async () => {
    const timeoutCalls: [Request, number][] = [];
    const nodeTimeouts: number[] = [];
    const request = trustedRequest();
    Object.defineProperty(request, 'runtime', {
      value: {
        bun: {
          server: {
            timeout: (runtimeRequest: Request, seconds: number) => {
              timeoutCalls.push([runtimeRequest, seconds]);
            },
          },
        },
        node: {
          req: {
            setTimeout: (milliseconds: number) => nodeTimeouts.push(milliseconds),
          },
          res: {
            setTimeout: (milliseconds: number) => nodeTimeouts.push(milliseconds),
          },
        },
      },
    });
    const response = createSourceControlEventStream(request, {
      runtime: streamRuntime().runtime,
    });

    expect(timeoutCalls).toEqual([[request, 0]]);
    expect(nodeTimeouts).toEqual([0, 0]);
    await response.body?.cancel();
  });

  test('bounds slow clients to one queued and one replacement snapshot', async () => {
    const source = streamRuntime();
    const response = createSourceControlEventStream(trustedRequest(), {
      runtime: source.runtime,
    });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Expected an SSE response body.');
    }
    await readTextChunk(reader);
    expect((await readSnapshotEvent(reader)).generation).toBe(0);

    for (let generation = 1; generation <= 100; generation++) {
      source.emit(snapshot(generation));
    }

    expect((await readSnapshotEvent(reader)).generation).toBe(1);
    expect((await readSnapshotEvent(reader)).generation).toBe(100);
    await reader.cancel();
  });

  test('emits a separate bounded report publication event after a new revision', async () => {
    const source = streamRuntime();
    const response = createSourceControlEventStream(trustedRequest(), { runtime: source.runtime });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Expected an SSE response body.');
    }
    await readTextChunk(reader);
    await readSnapshotEvent(reader);
    const next = snapshot(1);
    source.emit({
      ...next,
      publication: {
        ...next.publication,
        lastPublishedAt: '2026-07-16T10:00:00.000Z',
        revision: 'revision-1',
      },
    });
    expect(await readTextChunk(reader)).toContain('event: snapshot');
    const publication = await readTextChunk(reader);
    expect(publication).toContain('event: report-published');
    expect(publication).toContain('"revision":"revision-1"');
    await reader.cancel();
  });

  test('cleans up subscription and heartbeat state on abort', async () => {
    const abortController = new AbortController();
    let cleanupCount = 0;
    let clearedIntervals = 0;
    const source = streamRuntime();
    const response = createSourceControlEventStream(trustedRequest(abortController.signal), {
      onCleanup: () => {
        cleanupCount++;
      },
      runtime: source.runtime,
      scheduleHeartbeat: () => () => {
        clearedIntervals++;
      },
    });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Expected an SSE response body.');
    }
    await readTextChunk(reader);
    await readSnapshotEvent(reader);

    abortController.abort();

    expect(cleanupCount).toBe(1);
    expect(clearedIntervals).toBe(1);
    expect(source.unsubscribeCount()).toBe(1);
    expect((await reader.read()).done).toBe(true);
  });

  test('reconnects with the new process instance and generation', async () => {
    const first = createSourceControlEventStream(trustedRequest(), {
      runtime: streamRuntime(snapshot(50, 'old-process')).runtime,
    });
    const second = createSourceControlEventStream(trustedRequest(), {
      runtime: streamRuntime(snapshot(0, 'new-process')).runtime,
    });
    const firstReader = first.body?.getReader();
    const secondReader = second.body?.getReader();
    if (!(firstReader && secondReader)) {
      throw new Error('Expected SSE response bodies.');
    }
    await readTextChunk(firstReader);
    await readTextChunk(secondReader);

    expect(await readSnapshotEvent(firstReader)).toMatchObject({
      generation: 50,
      instanceId: 'old-process',
    });
    expect(await readSnapshotEvent(secondReader)).toMatchObject({
      generation: 0,
      instanceId: 'new-process',
    });
    await Promise.all([firstReader.cancel(), secondReader.cancel()]);
  });

  test('commands return the converged authoritative snapshot', async () => {
    const source = commandRuntime();
    const response = createSourceControlEventStream(trustedRequest(), {
      runtime: source.runtime,
    });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Expected an SSE response body.');
    }
    await readTextChunk(reader);
    expect((await readSnapshotEvent(reader)).generation).toBe(0);

    const result = await applySourceControlCommandForServer(
      {
        command: 'run-now',
        sourceId: 'claude.sessions',
      },
      source.runtime,
    );

    expect(result).toMatchObject({
      accepted: true,
      ok: true,
      snapshot: { generation: 1 },
    });
    expect(source.state().generation).toBe(1);
    expect((await readSnapshotEvent(reader)).generation).toBe(1);
    await reader.cancel();
  });

  test('HTTP commands enforce local trust and bounded strict JSON', async () => {
    const source = commandRuntime();
    const accepted = await handleSourceControlCommandRequest(
      commandRequest({
        command: 'run-now',
        sourceId: 'claude.sessions',
      }),
      source.runtime,
    );
    const malformed = await handleSourceControlCommandRequest(
      commandRequest({ command: 'run-all', unexpected: true }),
      source.runtime,
    );
    const hostile = await handleSourceControlCommandRequest(
      commandRequest(
        { command: 'detect-all' },
        {
          host: 'attacker.example',
          origin: 'http://attacker.example',
        },
      ),
    );
    const oversized = await handleSourceControlCommandRequest(
      commandRequest({ command: 'detect-all' }, { 'content-length': '4097' }),
      source.runtime,
    );

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      accepted: true,
      ok: true,
      snapshot: { generation: 1 },
    });
    expect(malformed.status).toBe(400);
    expect(hostile.status).toBe(403);
    expect(oversized.status).toBe(413);
  });

  test('command failures are stable and do not expose raw errors', async () => {
    const source = commandRuntime();
    const failingRuntime = {
      ...source.runtime,
      runNow: () => Promise.reject(new Error('secret provider response at /home/user/.config/private')),
    };

    const result = await applySourceControlCommandForServer(
      {
        command: 'run-now',
        sourceId: 'claude.sessions',
      },
      failingRuntime,
    );

    expect(result).toEqual({
      error: {
        message: 'The source control command could not be completed.',
        reason: 'command-failed',
        tag: 'SourceControlCommandError',
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain('secret provider');
    expect(JSON.stringify(result)).not.toContain('/home/');
  });
});
