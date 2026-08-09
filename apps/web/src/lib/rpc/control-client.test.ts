import { describe, expect, test } from 'bun:test';
import { collectionSourceDefinitions, sourceControlBounds } from '@ai-usage/report-core/source-control';
import { type ControlEventSource, createControlBrowserAdapter } from './control-client';

const snapshot = {
  generatedAt: '2026-08-03T00:00:00.000Z',
  generation: 1,
  instanceId: 'instance-a',
  publication: {
    acknowledgedRequestGeneration: 1,
    dirty: false,
    dirtyGeneration: 1,
    lastOutcome: 'success' as const,
    lastPublishedAt: '2026-08-03T00:00:00.000Z',
    pendingDemand: false,
    publishedGeneration: 1,
    queued: false,
    requestedGeneration: 1,
    revision: 'revision-1',
    rtkCompletedGeneration: 1,
    rtkRequiredGeneration: 1,
    running: false,
  },
  queueDepth: 0,
  runningCount: 0,
  sources: collectionSourceDefinitions.map((definition) => ({
    availability: 'detected' as const,
    cadenceMs: definition.cadenceMs,
    id: definition.id,
    label: definition.label,
    lastOutcome: 'success' as const,
    lifecycle: 'scheduled' as const,
    policy: 'enabled' as const,
    reason: { code: 'none' as const },
    warnings: [],
  })),
};

const failureEnvelope = {
  error: {
    message: 'The command is unavailable.',
    reason: 'engine-unavailable',
    tag: 'SourceControlCommandError' as const,
  },
  ok: false as const,
};

describe('control explicit browser adapter', () => {
  test('opens the exact SSE path and posts canonical commands with the caller signal', async () => {
    const eventSource: ControlEventSource = { close: () => undefined };
    const eventPaths: string[] = [];
    let fetchInput: string | URL | Request | undefined;
    let fetchInit: RequestInit | undefined;
    const controller = new AbortController();
    const responseEnvelope = { accepted: true, ok: true as const, snapshot };
    const adapter = createControlBrowserAdapter({
      createEventSource: (path) => {
        eventPaths.push(path);
        return eventSource;
      },
      fetch: (input, init) => {
        fetchInput = input;
        fetchInit = init;
        return Promise.resolve(Response.json(responseEnvelope));
      },
    });

    expect(adapter.openEvents()).toBe(eventSource);
    expect(eventPaths).toEqual(['/api/source-control']);
    expect(await adapter.sendCommand({ command: 'run-all' }, controller.signal)).toEqual(responseEnvelope);
    expect(fetchInput).toBe('/api/source-control/command');
    expect(fetchInit).toMatchObject({
      body: '{"command":"run-all"}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: controller.signal,
    });
  });

  test('preserves authoritative failure envelopes and rejects status disagreement', async () => {
    const failureAdapter = createControlBrowserAdapter({
      fetch: () => Promise.resolve(Response.json(failureEnvelope, { status: 503 })),
    });
    expect(await failureAdapter.sendCommand({ command: 'detect-all' })).toEqual(failureEnvelope);

    const inconsistent = createControlBrowserAdapter({
      fetch: () => Promise.resolve(Response.json({ accepted: true, ok: true, snapshot }, { status: 409 })),
    });
    await expect(inconsistent.sendCommand({ command: 'run-all' })).rejects.toThrow('status is inconsistent');
  });

  test('rejects malformed or oversized responses before protocol data escapes', async () => {
    const malformed = createControlBrowserAdapter({
      fetch: () => Promise.resolve(Response.json({ ok: true, snapshot: { privatePath: '/private/store' } })),
    });
    await expect(malformed.sendCommand({ command: 'run-all' })).rejects.toThrow();

    const maximum = sourceControlBounds.maxSnapshotBytes + sourceControlBounds.maxEventBytes;
    const oversized = createControlBrowserAdapter({
      fetch: () =>
        Promise.resolve(
          new Response('{}', {
            headers: { 'content-length': String(maximum + 1) },
          }),
        ),
    });
    await expect(oversized.sendCommand({ command: 'run-all' })).rejects.toThrow('byte limit');
  });

  test('cancels and releases a streamed response that exceeds its byte budget', async () => {
    const maximum = sourceControlBounds.maxSnapshotBytes + sourceControlBounds.maxEventBytes;
    let cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancellations += 1;
      },
      start: (controller) => {
        controller.enqueue(new Uint8Array(maximum + 1));
      },
    });
    const response = new Response(stream);
    const adapter = createControlBrowserAdapter({ fetch: () => Promise.resolve(response) });

    await expect(adapter.sendCommand({ command: 'run-all' })).rejects.toThrow('byte limit');
    expect(cancellations).toBe(1);
    expect(response.body?.locked).toBe(false);
  });

  test('prefers the exact abort reason over a concurrent mid-body failure', async () => {
    const secondReadStarted = Promise.withResolvers<void>();
    const concurrentFailure = Promise.withResolvers<void>();
    const encoder = new TextEncoder();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(encoder.encode('{'));
          return;
        }
        secondReadStarted.resolve();
        return concurrentFailure.promise;
      },
    });
    const response = new Response(stream);
    const adapter = createControlBrowserAdapter({ fetch: () => Promise.resolve(response) });
    const controller = new AbortController();
    const reason = { reason: 'superseded-command-body' };
    const pending = adapter.sendCommand({ command: 'run-all' }, controller.signal);

    await secondReadStarted.promise;
    controller.abort(reason);
    concurrentFailure.reject(new Error('concurrent body failure'));

    await expect(pending).rejects.toBe(reason);
    expect(response.body?.locked).toBe(false);
  });

  test('rejects declared-length mismatches and releases the streamed command body', async () => {
    const response = new Response('{}', { headers: { 'content-length': '3' } });
    const adapter = createControlBrowserAdapter({ fetch: () => Promise.resolve(response) });

    await expect(adapter.sendCommand({ command: 'run-all' })).rejects.toThrow('length did not match');
    expect(response.body?.locked).toBe(false);
  });

  test('does not await never-settling command cancellation cleanup', async () => {
    const secondReadStarted = Promise.withResolvers<void>();
    const cancellationStarted = Promise.withResolvers<void>();
    let pulls = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel: () => {
          cancellationStarted.resolve();
          return new Promise<void>(() => undefined);
        },
        pull: (controller) => {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(new TextEncoder().encode('{'));
            return;
          }
          secondReadStarted.resolve();
          return new Promise<void>(() => undefined);
        },
      }),
    );
    const adapter = createControlBrowserAdapter({ fetch: () => Promise.resolve(response) });
    const controller = new AbortController();
    const reason = { reason: 'command-view-unmounted' };
    const outcome = adapter.sendCommand({ command: 'run-all' }, controller.signal).then(
      () => ({ error: null, settled: true as const }),
      (error: unknown) => ({ error, settled: true as const }),
    );

    await secondReadStarted.promise;
    controller.abort(reason);
    await cancellationStarted.promise;
    const nextTask = new Promise<{ settled: false }>((resolve) => {
      setTimeout(() => resolve({ settled: false }), 0);
    });
    const completion = await Promise.race([outcome, nextTask]);

    expect(completion.settled).toBe(true);
    expect('error' in completion ? completion.error : null).toBe(reason);
    expect(response.body?.locked).toBe(false);
  });

  test('observes rejected command cancellation cleanup without replacing the abort reason', async () => {
    const secondReadStarted = Promise.withResolvers<void>();
    let pulls = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel: () => Promise.reject(new Error('command cleanup rejected')),
        pull: (controller) => {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(new TextEncoder().encode('{'));
            return;
          }
          secondReadStarted.resolve();
          return new Promise<void>(() => undefined);
        },
      }),
    );
    const adapter = createControlBrowserAdapter({ fetch: () => Promise.resolve(response) });
    const controller = new AbortController();
    const reason = { reason: 'command-view-replaced' };
    const pending = adapter.sendCommand({ command: 'run-all' }, controller.signal);

    await secondReadStarted.promise;
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    await Promise.resolve();
    expect(response.body?.locked).toBe(false);
  });

  test('rejects invalid commands before fetch and preserves pre-abort identity', async () => {
    let acquisitions = 0;
    const adapter = createControlBrowserAdapter({
      fetch: () => {
        acquisitions += 1;
        return Promise.resolve(Response.json(failureEnvelope, { status: 409 }));
      },
    });
    await expect(adapter.sendCommand({ command: 'run-now', sourceId: 'unknown.sessions' } as never)).rejects.toThrow(
      'known source ID',
    );

    const controller = new AbortController();
    const reason = { reason: 'superseded-command' };
    controller.abort(reason);
    try {
      await adapter.sendCommand({ command: 'run-all' }, controller.signal);
      throw new Error('Expected command cancellation');
    } catch (error) {
      expect(error).toBe(reason);
    }
    expect(acquisitions).toBe(0);
  });
});
