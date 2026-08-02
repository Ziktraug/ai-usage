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

  test('acquires a validated attachment without consuming file bytes', async () => {
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
    expect(download).toEqual({ filename: 'ai-usage-machine-a.json', response });
    expect(fetchInput).toBe('/api/manual-merge/download');
    expect(fetchInit).toEqual({ method: 'POST', signal: controller.signal });
    expect(response.bodyUsed).toBe(false);
  });

  test('rejects unsafe status and attachment metadata without consuming bytes', async () => {
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
    ];

    for (const response of responses) {
      const adapter = createSyncBrowserAdapter(defaultTransport(), () => Promise.resolve(response));
      await expect(adapter.downloadManualMerge()).rejects.toThrow();
      expect(response.bodyUsed).toBe(false);
    }
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
