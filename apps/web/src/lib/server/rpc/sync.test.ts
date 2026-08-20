import { describe, expect, test } from 'bun:test';
import {
  serializeUsageMergeBundle,
  USAGE_MERGE_BUNDLE_VERSION,
  type UsageMergeBundle,
} from '@ai-usage/report-core/merge-bundle';
import { ORPCError } from '@orpc/client';
import { call } from '@orpc/server';
import {
  createManualMergeExplicitHandlers,
  createSyncRpcRouter,
  type ManualMergeExportCandidate,
  type SyncRpcDependencies,
} from './sync';

const syncRouter = (dependencies: Partial<SyncRpcDependencies>) =>
  createSyncRpcRouter({
    getFleet: () => Promise.reject(new Error('Fleet reads are outside this fixture.')),
    setMachineLabel: () => Promise.reject(new Error('Machine renames are outside this fixture.')),
    ...dependencies,
  });

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
    filename: 'ai-usage-machine-a-2026-08-03T00-00-00-000Z.json',
    machine: bundle.machine,
    rows: bundle.rows.length,
    text: bundleText,
  },
  ok: true as const,
});

const canonicalizeExport = (candidate: ManualMergeExportCandidate, _signal?: AbortSignal) => {
  const expected = exportSuccess().data;
  if (JSON.stringify(candidate) !== JSON.stringify(expected)) {
    throw new Error('The synthetic export is not canonical.');
  }
  return Promise.resolve({
    bytes: expected.bytes,
    filename: expected.filename,
    rows: expected.rows,
    text: expected.text,
  });
};

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
    const router = syncRouter({
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
    const incompatible = syncRouter({
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

    const unavailable = syncRouter({ getFleet: () => Promise.reject(new Error(privatePath)) });
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
    const router = syncRouter({
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
    const router = syncRouter({
      getFleet: () => Promise.resolve({ data: { ...fleet, databasePath: '/private/usage.sqlite' }, ok: true }),
    });
    const error = requireOrpcError(await catchError(call(router.fleet, {})));
    expect(error.code).toBe('Unavailable');
    expect(error.message).not.toContain('/private');
  });

  test('renames the local machine through the engine and returns the engine-confirmed identity', async () => {
    const labels: string[] = [];
    const router = syncRouter({
      setMachineLabel: ({ label }) => {
        labels.push(label);
        return Promise.resolve({ machine: { id: 'machine-a', label } });
      },
    });

    expect(await call(router.setMachineLabel, { label: 'Studio Mac' })).toEqual({
      machine: { id: 'machine-a', label: 'Studio Mac' },
    });
    expect(labels).toEqual(['Studio Mac']);
  });

  test('rejects blank, oversized, and unknown-field label input before the engine is reached', async () => {
    let calls = 0;
    const router = syncRouter({
      setMachineLabel: ({ label }) => {
        calls += 1;
        return Promise.resolve({ machine: { id: 'machine-a', label } });
      },
    });

    for (const input of [{ label: '   ' }, { label: 'L'.repeat(241) }, { label: 'ok', machineId: 'machine-b' }]) {
      expect(await catchError(call(router.setMachineLabel, input as { label: string }))).toBeDefined();
    }
    expect(calls).toBe(0);
    // A multi-byte label is measured the way the engine measures it, not by character count.
    expect(await catchError(call(router.setMachineLabel, { label: 'é'.repeat(121) }))).toBeDefined();
    expect(calls).toBe(0);
    expect(await call(router.setMachineLabel, { label: 'é'.repeat(120) })).toEqual({
      machine: { id: 'machine-a', label: 'é'.repeat(120) },
    });
  });

  test('sanitizes a deep rename failure and a malformed engine identity', async () => {
    const privatePath = '/private/machine.json';
    const failing = syncRouter({ setMachineLabel: () => Promise.reject(new Error(privatePath)) });
    const failure = requireOrpcError(await catchError(call(failing.setMachineLabel, { label: 'Studio Mac' })));
    expect(failure.code).toBe('EngineUnavailable');
    expect(failure.data).toEqual({ reason: 'machine-label-unavailable' });
    expect(failure.message).not.toContain(privatePath);

    const malformed = syncRouter({
      setMachineLabel: () => Promise.resolve({ machine: { configPath: privatePath, id: 'machine-a', label: 'x' } }),
    });
    const malformedError = requireOrpcError(await catchError(call(malformed.setMachineLabel, { label: 'Studio Mac' })));
    expect(malformedError.code).toBe('EngineUnavailable');
    expect(malformedError.message).not.toContain(privatePath);
  });
});

describe('manual merge explicit HTTP adapters', () => {
  test('downloads validated canonical bundle bytes with safe attachment headers', async () => {
    let receivedSignal: AbortSignal | undefined;
    const handlers = createManualMergeExplicitHandlers({
      canonicalizeExport,
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
      'attachment; filename="ai-usage-machine-a-2026-08-03T00-00-00-000Z.json"',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(bundleText);
    expect(receivedSignal).toBe(request.signal);
  });

  test('rejects unsafe metadata, bodies, and methods without leaking private data', async () => {
    const privatePath = '/private/export.json';
    let exports = 0;
    const handlers = createManualMergeExplicitHandlers({
      canonicalizeExport,
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
      canonicalizeExport,
      exportBundle: () => Promise.reject(new Error(privatePath)),
      handleUpload: () => Promise.resolve(new Response()),
    });
    const failure = await failureHandlers.download(postRequest('/api/manual-merge/download'));
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain(privatePath);
  });

  test('rejects safe but noncanonical filenames and serialized bundle bytes', async () => {
    const prettyText = JSON.stringify(JSON.parse(bundleText) as unknown, null, 2);
    const variants = [
      { ...exportSuccess().data, filename: 'safe-export.json' },
      {
        ...exportSuccess().data,
        bytes: new TextEncoder().encode(prettyText).byteLength,
        text: prettyText,
      },
    ];

    for (const data of variants) {
      const handlers = createManualMergeExplicitHandlers({
        canonicalizeExport,
        exportBundle: () => Promise.resolve({ data, ok: true }),
        handleUpload: () => Promise.resolve(new Response()),
      });
      const response = await handlers.download(postRequest('/api/manual-merge/download'));
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(data.filename);
    }
  });

  test('rejects accessor-backed owner results without invoking accessors', async () => {
    let accessorReads = 0;
    let canonicalizations = 0;
    const rootAccessor: Record<string, unknown> = {};
    Object.defineProperty(rootAccessor, 'ok', {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return true;
      },
    });
    const nestedAccessor: Record<string, unknown> = {};
    Object.defineProperty(nestedAccessor, 'text', {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return bundleText;
      },
    });
    const results = [rootAccessor, { data: nestedAccessor, ok: true }];

    for (const result of results) {
      const handlers = createManualMergeExplicitHandlers({
        canonicalizeExport: (candidate, signal) => {
          canonicalizations += 1;
          return canonicalizeExport(candidate, signal);
        },
        exportBundle: () => Promise.resolve(result),
        handleUpload: () => Promise.resolve(new Response()),
      });
      expect((await handlers.download(postRequest('/api/manual-merge/download'))).status).toBe(503);
    }
    expect(accessorReads).toBe(0);
    expect(canonicalizations).toBe(0);
  });

  test('returns a bounded cancellation response when download acquisition aborts', async () => {
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const handlers = createManualMergeExplicitHandlers({
      canonicalizeExport,
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
      canonicalizeExport,
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
