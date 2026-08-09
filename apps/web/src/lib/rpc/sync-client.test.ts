import { describe, expect, test } from 'bun:test';
import { MAX_PORTABLE_USAGE_BYTES } from '@ai-usage/report-core/portable-usage';
import { createSyncBrowserAdapter, type SyncRpcTransport } from './sync-client';

const fleet = {
  currentMachine: { id: 'machine-a', label: 'Machine A' },
  machines: [
    {
      hasLocalObservedRows: true,
      hasPortableRows: false,
      id: 'machine-a',
      label: 'Machine A',
      lastSeenAt: '2026-08-03T00:00:00.000Z',
      newestSessionAt: null,
      sessionCount: 1,
    },
  ],
  omittedMachines: 0,
  skipped: 0,
};

const defaultTransport = (): SyncRpcTransport => ({ fleet: () => Promise.resolve(fleet) });

const exportResponse = (): Response =>
  new Response('{"portable":true}', {
    headers: {
      'content-disposition': 'attachment; filename="ai-usage-machine-a.json"',
      'content-length': '17',
      'content-type': 'application/json; charset=utf-8',
    },
  });

describe('Sync browser adapter', () => {
  test('validates fleet output and forwards the caller signal through RPC', async () => {
    const controller = new AbortController();
    let receivedInput: unknown;
    let receivedSignal: AbortSignal | undefined;
    const adapter = createSyncBrowserAdapter({
      fleet: (input, options) => {
        receivedInput = input;
        receivedSignal = options?.signal;
        return Promise.resolve(fleet);
      },
    });

    expect(await adapter.fleet(controller.signal)).toEqual(fleet);
    expect(receivedInput).toEqual({});
    expect(receivedSignal).toBe(controller.signal);

    const malformed = createSyncBrowserAdapter({
      fleet: () => Promise.resolve({ ...fleet, databasePath: '/private/usage.sqlite' } as never),
    });
    await expect(malformed.fleet()).rejects.toThrow();
  });

  test('consumes and replays a validated attachment within its declared byte budget', async () => {
    const response = exportResponse();
    let fetchInput: string | URL | Request | undefined;
    let fetchInit: RequestInit | undefined;
    const controller = new AbortController();
    const adapter = createSyncBrowserAdapter(defaultTransport(), (input, init) => {
      fetchInput = input;
      fetchInit = init;
      return Promise.resolve(response);
    });

    const download = await adapter.downloadManualMerge(controller.signal);
    expect(download.filename).toBe('ai-usage-machine-a.json');
    expect(download.response).not.toBe(response);
    expect(await download.response.text()).toBe('{"portable":true}');
    expect(fetchInput).toBe('/api/manual-merge/download');
    expect(fetchInit).toEqual({ method: 'POST', signal: controller.signal });
    expect(response.bodyUsed).toBe(true);
  });

  test('cancels rejected status and attachment metadata before returning bytes', async () => {
    const responses = [
      new Response('{}', { status: 503 }),
      new Response('{}', {
        headers: {
          'content-disposition': 'attachment; filename="../private.json"',
          'content-length': '2',
          'content-type': 'application/json; charset=utf-8',
        },
      }),
      new Response('{}', {
        headers: {
          'content-disposition': 'attachment; filename="safe.json"',
          'content-length': String(MAX_PORTABLE_USAGE_BYTES + 1),
          'content-type': 'application/json; charset=utf-8',
        },
      }),
      new Response('{}', {
        headers: {
          'content-disposition': 'attachment; filename="safe.json"',
          'content-length': '2',
          'content-type': 'text/plain',
        },
      }),
      new Response('{}', {
        headers: {
          'content-disposition': 'attachment; filename="safe.json"',
          'content-type': 'application/json; charset=utf-8',
        },
      }),
    ];

    for (const response of responses) {
      const adapter = createSyncBrowserAdapter(defaultTransport(), () => Promise.resolve(response));
      await expect(adapter.downloadManualMerge()).rejects.toThrow();
      expect(response.bodyUsed).toBe(true);
    }
  });

  test('rejects truncated and lying manual-export streams without returning partial bytes', async () => {
    const headers = {
      'content-disposition': 'attachment; filename="safe.json"',
      'content-length': '3',
      'content-type': 'application/json; charset=utf-8',
    };
    const truncated = new Response('{}', { headers });
    const truncatedAdapter = createSyncBrowserAdapter(defaultTransport(), () => Promise.resolve(truncated));

    await expect(truncatedAdapter.downloadManualMerge()).rejects.toThrow('length did not match');
    expect(truncated.body?.locked).toBe(false);

    let cancellations = 0;
    const lying = new Response(
      new ReadableStream<Uint8Array>({
        cancel: () => {
          cancellations += 1;
        },
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode('{} '));
        },
      }),
      { headers: { ...headers, 'content-length': '2' } },
    );
    const lyingAdapter = createSyncBrowserAdapter(defaultTransport(), () => Promise.resolve(lying));

    await expect(lyingAdapter.downloadManualMerge()).rejects.toThrow('byte limit');
    expect(cancellations).toBe(1);
    expect(lying.body?.locked).toBe(false);
  });

  test('does not await never-settling manual-export cancellation cleanup', async () => {
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
      {
        headers: {
          'content-disposition': 'attachment; filename="safe.json"',
          'content-length': '2',
          'content-type': 'application/json; charset=utf-8',
        },
      },
    );
    const adapter = createSyncBrowserAdapter(defaultTransport(), () => Promise.resolve(response));
    const controller = new AbortController();
    const reason = { reason: 'manual-export-unmounted' };
    const outcome = adapter.downloadManualMerge(controller.signal).then(
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

  test('observes rejected manual-export cancellation cleanup without replacing the abort reason', async () => {
    const secondReadStarted = Promise.withResolvers<void>();
    let pulls = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel: () => Promise.reject(new Error('manual-export cleanup rejected')),
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
      {
        headers: {
          'content-disposition': 'attachment; filename="safe.json"',
          'content-length': '2',
          'content-type': 'application/json; charset=utf-8',
        },
      },
    );
    const adapter = createSyncBrowserAdapter(defaultTransport(), () => Promise.resolve(response));
    const controller = new AbortController();
    const reason = { reason: 'manual-export-replaced' };
    const pending = adapter.downloadManualMerge(controller.signal);

    await secondReadStarted.promise;
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    await Promise.resolve();
    expect(response.body?.locked).toBe(false);
  });

  test('preserves pre-abort identity without acquiring RPC or file transport', async () => {
    let fetchAcquisitions = 0;
    let rpcAcquisitions = 0;
    const adapter = createSyncBrowserAdapter(
      {
        fleet: () => {
          rpcAcquisitions += 1;
          return Promise.resolve(fleet);
        },
      },
      () => {
        fetchAcquisitions += 1;
        return Promise.resolve(exportResponse());
      },
    );
    const controller = new AbortController();
    const reason = { reason: 'superseded-sync' };
    controller.abort(reason);

    try {
      await adapter.fleet(controller.signal);
      throw new Error('Expected fleet cancellation');
    } catch (error) {
      expect(error).toBe(reason);
    }
    try {
      await adapter.downloadManualMerge(controller.signal);
      throw new Error('Expected download cancellation');
    } catch (error) {
      expect(error).toBe(reason);
    }
    expect(rpcAcquisitions).toBe(0);
    expect(fetchAcquisitions).toBe(0);
  });
});
