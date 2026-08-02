import { describe, expect, test } from 'bun:test';
import {
  serializeUsageMergeBundle,
  USAGE_MERGE_BUNDLE_VERSION,
  type UsageMergeBundle,
} from '@ai-usage/report-core/merge-bundle';
import { ORPCError } from '@orpc/client';
import { call } from '@orpc/server';
import { createManualMergeExplicitHandlers, createSyncRpcRouter } from './sync';

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

const bundle: UsageMergeBundle = {
  generatedAt: '2026-08-03T00:00:00.000Z',
  machine: fleet.currentMachine,
  rows: [],
  version: USAGE_MERGE_BUNDLE_VERSION,
  warnings: [],
};
const bundleText = serializeUsageMergeBundle(bundle);
const exportSuccess = () => ({
  data: {
    bytes: new TextEncoder().encode(bundleText).byteLength,
    filename: 'ai-usage-machine-a-2026-08-03.json',
    machine: bundle.machine,
    rows: bundle.rows.length,
    text: bundleText,
  },
  ok: true as const,
});

const catchError = async (operation: Promise<unknown>): Promise<unknown> => {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to fail');
};

const requireOrpcError = (error: unknown): ORPCError<string, unknown> => {
  if (!(error instanceof ORPCError)) {
    throw new Error('Expected an ORPCError');
  }
  return error;
};

const postRequest = (path: string, signal?: AbortSignal): Request =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    ...(signal === undefined ? {} : { signal }),
  });

describe('Sync RPC server adapter', () => {
  test('returns the exact bounded fleet and forwards cancellation capability', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const router = createSyncRpcRouter({
      getFleet: (signal) => {
        receivedSignal = signal;
        return Promise.resolve({ data: fleet, ok: true });
      },
    });

    expect(await call(router.fleet, {}, { signal: controller.signal })).toEqual(fleet);
    expect(receivedSignal).toBe(controller.signal);
  });

  test('maps incompatible and unavailable owner failures to sanitized closed errors', async () => {
    const privatePath = '/private/usage.sqlite';
    const incompatible = createSyncRpcRouter({
      getFleet: () =>
        Promise.resolve({
          error: { message: privatePath, reason: 'schema-too-new', tag: 'UsageStoreReadError' },
          ok: false,
        }),
    });
    const incompatibleError = requireOrpcError(await catchError(call(incompatible.fleet, {})));
    expect(incompatibleError.code).toBe('IncompatibleStore');
    expect(incompatibleError.data).toEqual({ reason: 'incompatible-store' });
    expect(incompatibleError.message).not.toContain(privatePath);

    const unavailable = createSyncRpcRouter({ getFleet: () => Promise.reject(new Error(privatePath)) });
    const unavailableError = requireOrpcError(await catchError(call(unavailable.fleet, {})));
    expect(unavailableError.code).toBe('Unavailable');
    expect(unavailableError.data).toEqual({ reason: 'sync-fleet-unavailable' });
    expect(unavailableError.message).not.toContain(privatePath);
  });

  test('prefers the exact signal reason over a concurrent fleet failure', async () => {
    const controller = new AbortController();
    const abortReason = { reason: 'superseded-fleet' };
    let rejectDeep: ((reason?: unknown) => void) | undefined;
    const deepFailure = new Promise<never>((_resolve, reject) => {
      rejectDeep = reject;
    });
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const router = createSyncRpcRouter({
      getFleet: async () => {
        started?.();
        return await deepFailure;
      },
    });

    const pendingError = catchError(call(router.fleet, {}, { signal: controller.signal }));
    await startedPromise;
    controller.abort(abortReason);
    rejectDeep?.(new Error('concurrent deep failure'));

    expect(await pendingError).toBe(abortReason);
  });

  test('rejects malformed deep output before it crosses RPC', async () => {
    const router = createSyncRpcRouter({
      getFleet: () => Promise.resolve({ data: { ...fleet, databasePath: '/private/usage.sqlite' }, ok: true }),
    });
    const error = requireOrpcError(await catchError(call(router.fleet, {})));
    expect(error.code).toBe('Unavailable');
    expect(error.message).not.toContain('/private');
  });
});

describe('manual merge explicit HTTP adapters', () => {
  test('downloads validated canonical bundle bytes with safe attachment headers', async () => {
    let receivedSignal: AbortSignal | undefined;
    const handlers = createManualMergeExplicitHandlers({
      exportBundle: (signal) => {
        receivedSignal = signal;
        return Promise.resolve(exportSuccess());
      },
      handleUpload: () => Promise.resolve(new Response()),
    });
    const request = postRequest('/api/manual-merge/download');
    const response = await handlers.download(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="ai-usage-machine-a-2026-08-03.json"',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(bundleText);
    expect(receivedSignal).toBe(request.signal);
  });

  test('rejects unsafe metadata, bodies, and methods without leaking private data', async () => {
    const privatePath = '/private/export.json';
    let exports = 0;
    const handlers = createManualMergeExplicitHandlers({
      exportBundle: () => {
        exports += 1;
        return Promise.resolve({
          ...exportSuccess(),
          data: { ...exportSuccess().data, filename: '../private.json' },
        });
      },
      handleUpload: () => Promise.resolve(new Response()),
    });
    const unsafe = await handlers.download(postRequest('/api/manual-merge/download'));
    expect(unsafe.status).toBe(503);
    expect(await unsafe.text()).not.toContain('private.json');

    const body = await handlers.download(
      new Request('http://localhost/api/manual-merge/download', { body: '{}', method: 'POST' }),
    );
    const method = await handlers.download(new Request('http://localhost/api/manual-merge/download'));
    expect(body.status).toBe(400);
    expect(method.status).toBe(405);
    expect(method.headers.get('allow')).toBe('POST');
    expect(exports).toBe(1);

    const failureHandlers = createManualMergeExplicitHandlers({
      exportBundle: () => Promise.reject(new Error(privatePath)),
      handleUpload: () => Promise.resolve(new Response()),
    });
    const failure = await failureHandlers.download(postRequest('/api/manual-merge/download'));
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain(privatePath);
  });

  test('returns a bounded cancellation response when download acquisition aborts', async () => {
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const handlers = createManualMergeExplicitHandlers({
      exportBundle: async (signal) => {
        started?.();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      handleUpload: () => Promise.resolve(new Response()),
    });
    const responsePromise = handlers.download(postRequest('/api/manual-merge/download', controller.signal));
    await startedPromise;
    controller.abort(new DOMException('cancelled', 'AbortError'));
    const response = await responsePromise;

    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ error: { reason: 'aborted' }, ok: false });
  });

  test('forwards the exact upload request so deep staging owns abort and late cleanup', async () => {
    const controller = new AbortController();
    let cleanupCount = 0;
    let receivedRequest: Request | undefined;
    let resolveLateStaging: (() => void) | undefined;
    let stagingStarted: (() => void) | undefined;
    const stagingStartedPromise = new Promise<void>((resolve) => {
      stagingStarted = resolve;
    });
    const lateStaging = new Promise<void>((resolve) => {
      resolveLateStaging = resolve;
    });
    const handlers = createManualMergeExplicitHandlers({
      exportBundle: () => Promise.resolve(exportSuccess()),
      handleUpload: async (request) => {
        receivedRequest = request;
        stagingStarted?.();
        await new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        lateStaging.then(() => {
          cleanupCount += 1;
        });
        return new Response(null, { status: 499 });
      },
    });
    const upload = postRequest('/api/manual-merge/upload', controller.signal);
    const responsePromise = handlers.upload(upload);
    await stagingStartedPromise;
    controller.abort();
    const response = await responsePromise;
    resolveLateStaging?.();
    await lateStaging;
    await Promise.resolve();

    expect(response.status).toBe(499);
    expect(receivedRequest).toBe(upload);
    expect(receivedRequest?.signal.aborted).toBe(true);
    expect(cleanupCount).toBe(1);
  });
});
