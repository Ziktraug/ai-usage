import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ORPCError } from '@orpc/client';
import { installBrowserQueryRuntime } from '../lib/query/browser-runtime';
import { createWebQueryClient, dehydrateWebQueryClient, type WebQueryHydrationState } from '../lib/query/client';
import { createWebQueryRuntime, type WebQueryRuntime } from '../lib/query/composition';
import { createWebRpcClient } from '../lib/rpc/client';

// SvelteKit's `$app/env` exists only inside its Vite plugin; the report layout reads `dev` from it.
mock.module('$app/env', () => ({ dev: false }));

/**
 * The server document loads acquire through the in-process router client, whose default services open
 * the configured usage store. Both module boundaries are replaced by recorders while a document test
 * runs; outside one they delegate to the real exports, so later test files in this process keep the
 * real behaviour (`mock.module` is process-wide).
 */
interface DocumentAcquisitionRecorder {
  readonly acquisitions: { readonly pageUrl: URL; readonly rpc: unknown }[];
  readonly clientRequests: Request[];
  /**
   * The delta the stand-in acquisition answers with. A test compares a load's result with this one
   * object: a second delta built for the comparison would carry its own `Date.now()` stamps.
   */
  readonly reportQueryState: WebQueryHydrationState;
}
let documentRecorder: DocumentAcquisitionRecorder | undefined;

/** A router client stand-in whose every procedure answers the contract's expected `Unavailable`. */
const unavailableRpcClient = (): unknown => {
  const procedure: unknown = new Proxy(() => undefined, {
    apply: () => Promise.reject(new ORPCError('Unavailable')),
    get: (_target, key) => (key === 'then' ? undefined : procedure),
  });
  return procedure;
};

const realInProcessClient = { ...(await import('#lib/server/rpc/in-process-client.server.ts')) };
mock.module('#lib/server/rpc/in-process-client.server.ts', () => ({
  ...realInProcessClient,
  createInProcessWebRpcClient: (...args: Parameters<typeof realInProcessClient.createInProcessWebRpcClient>) => {
    if (!documentRecorder) {
      return realInProcessClient.createInProcessWebRpcClient(...args);
    }
    documentRecorder.clientRequests.push(args[0]);
    return Promise.resolve(unavailableRpcClient());
  },
}));

const realReportBootstrap = { ...(await import('#lib/features/report/core/report-bootstrap.ts')) };
mock.module('#lib/features/report/core/report-bootstrap.ts', () => ({
  ...realReportBootstrap,
  acquireLiveReportQueryState: (...args: Parameters<typeof realReportBootstrap.acquireLiveReportQueryState>) => {
    if (!documentRecorder) {
      return realReportBootstrap.acquireLiveReportQueryState(...args);
    }
    documentRecorder.acquisitions.push(args[0]);
    return Promise.resolve(documentRecorder.reportQueryState);
  },
}));

/**
 * SvelteKit reruns a load when a dependency it tracked changes: a `url` property it read, or a
 * `parent()` it awaited, outside `untrack`. Each load is called here with an event that records
 * those tracked reads, so a load that would become search-scoped (and refetch on every filter or
 * range change) fails here instead of on a network trace.
 */
interface LoadProbe {
  /** Event properties the load touched, in order. */
  readonly accessed: string[];
  readonly dependencies: string[];
  readonly event: Record<string, unknown>;
  /** Tracked dependencies: `url.<property>` and `parent()` read outside `untrack`. */
  readonly tracked: string[];
  /** `url.<property>` reads made inside `untrack`. */
  readonly untracked: string[];
  /** The `url` the event hands out: a recording proxy over `PAGE_HREF`. */
  readonly url: URL;
}

const PAGE_HREF = 'http://127.0.0.1:4173/work?q=codex&range=30d';

const probeLoadEvent = (fields: Record<string, unknown>, parentData: unknown = {}): LoadProbe => {
  const accessed: string[] = [];
  const tracked: string[] = [];
  const untracked: string[] = [];
  const dependencies: string[] = [];
  let untrackDepth = 0;
  const target = new URL(PAGE_HREF);
  const url = new Proxy(target, {
    get(object, key) {
      (untrackDepth === 0 ? tracked : untracked).push(`url.${String(key)}`);
      const value: unknown = Reflect.get(object, key, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
  const fullEvent: Record<string, unknown> = {
    depends: (...names: string[]) => {
      dependencies.push(...names);
    },
    parent: () => {
      if (untrackDepth === 0) {
        tracked.push('parent()');
      }
      return Promise.resolve(parentData);
    },
    untrack: <T>(read: () => T): T => {
      untrackDepth += 1;
      try {
        return read();
      } finally {
        untrackDepth -= 1;
      }
    },
    url,
    ...fields,
  };
  const event = new Proxy(fullEvent, {
    get(object, key) {
      accessed.push(String(key));
      return Reflect.get(object, key);
    },
  });
  return { accessed, dependencies, event, tracked, untracked, url };
};

type Load = (event: never) => unknown;

/** Route loads are typed against generated `$types`; the probe supplies the fields they read. */
const runLoad = (load: Load, probe: LoadProbe): Promise<unknown> =>
  Promise.resolve((load as unknown as (event: Record<string, unknown>) => unknown)(probe.event));

const emptyServerDelta = (): WebQueryHydrationState => ({ dehydratedState: { mutations: [], queries: [] } });

/** A server delta that already carries a query: the document load acquired it, so intent must not. */
const acquiredServerDelta = (): WebQueryHydrationState => {
  const client = createWebQueryClient();
  client.setQueryData(['acquired'], null);
  return dehydrateWebQueryClient(client);
};

const rpcRequests: string[] = [];
let runtime: WebQueryRuntime | undefined;
let uninstallRuntime: (() => void) | undefined;
let windowDescriptor: PropertyDescriptor | undefined;

// Intent warming runs only with a mounted browser runtime; its RPC transport records each request and
// never answers, so a warmed load waits out the navigation budget without reaching any service.
beforeEach(() => {
  rpcRequests.length = 0;
  windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  runtime = createWebQueryRuntime({
    rpc: createWebRpcClient({
      fetch: (request: Request | string | URL) => {
        rpcRequests.push(new URL(request instanceof Request ? request.url : request).pathname);
        return new Promise<Response>(() => undefined);
      },
      url: 'http://route-load.invalid/rpc',
    }),
  });
  uninstallRuntime = installBrowserQueryRuntime(runtime);
});

afterEach(() => {
  uninstallRuntime?.();
  runtime?.queryClient.clear();
  if (windowDescriptor) {
    Object.defineProperty(globalThis, 'window', windowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

interface IntentRoute {
  /** The route's own data for a live document, around the server delta its load hands to intent warming. */
  readonly data: (queryState: WebQueryHydrationState) => Record<string, unknown>;
  readonly load: () => Promise<Load>;
  readonly name: string;
  readonly parent?: unknown;
}

const intentRoutes: readonly IntentRoute[] = [
  {
    data: (queryState) => ({ mode: 'live', queryState }),
    load: async () => (await import('./campaigns/+page')).load,
    name: 'campaigns/+page.ts',
  },
  {
    data: (queryState) => ({ mode: 'live', queryState }),
    load: async () => (await import('./work/+page')).load,
    name: 'work/+page.ts',
  },
  {
    data: (queryState) => ({ mode: 'live', queryState }),
    load: async () => (await import('./work/sessions/+page')).load,
    name: 'work/sessions/+page.ts',
  },
  {
    data: (queryState) => ({ queryState }),
    load: async () => (await import('./skills/+layout')).load,
    name: 'skills/+layout.ts',
    parent: { runtimeMode: 'live' },
  },
  {
    data: (queryState) => ({ queryState }),
    load: async () => (await import('./sync/+page')).load,
    name: 'sync/+page.ts',
    parent: { runtimeMode: 'live' },
  },
  {
    data: (queryState) => ({ queryState }),
    load: async () => (await import('./delegation/+page')).load,
    name: 'delegation/+page.ts',
    parent: { runtimeMode: 'live' },
  },
  {
    data: (reportQueryState) => ({ reportQueryState }),
    load: async () => (await import('./(report)/+layout')).load,
    name: '(report)/+layout.ts',
    parent: { runtimeMode: 'live' },
  },
];

describe('universal route loads', () => {
  test.each(intentRoutes.map((route) => [route.name, route] as const))(
    '%s warms intent without tracking the URL or its parent',
    async (_name, route) => {
      const load = await route.load();
      const probe = probeLoadEvent({ data: route.data(emptyServerDelta()) }, route.parent);

      await runLoad(load, probe);

      expect(probe.tracked).toEqual([]);
      // The intent prefetch reached the route's RPC: the empty client-navigation delta is warmed.
      expect(rpcRequests.length).toBeGreaterThan(0);
    },
  );

  test.each(intentRoutes.map((route) => [route.name, route] as const))(
    '%s leaves a server delta the document load acquired to hydration',
    async (_name, route) => {
      const load = await route.load();
      const probe = probeLoadEvent({ data: route.data(acquiredServerDelta()) }, route.parent);

      await runLoad(load, probe);

      expect(probe.tracked).toEqual([]);
      expect(rpcRequests).toEqual([]);
    },
  );

  test('the report layout hands the server delta through as the live report state', async () => {
    const { load } = await import('./(report)/+layout');
    const reportQueryState = acquiredServerDelta();

    const data = await runLoad(load, probeLoadEvent({ data: { reportQueryState } }, { runtimeMode: 'live' }));

    expect(data).toEqual({ mode: 'live', queryState: reportQueryState });
  });

  test('the root layout passes its server data through and reads nothing else from the event', async () => {
    const { load } = await import('./+layout');
    const data = { quotaQueryState: emptyServerDelta(), runtimeMode: 'live' };
    const probe = probeLoadEvent({ data });

    expect(await runLoad(load, probe)).toBe(data);
    expect(probe.accessed).toEqual(['data']);
    expect(rpcRequests).toEqual([]);
  });
});

describe('server route loads', () => {
  test('the root layout answers a data request with an empty quota delta and never reads the URL', async () => {
    const { load } = await import('./+layout.server');
    const probe = probeLoadEvent({ isDataRequest: true, locals: {}, request: new Request(PAGE_HREF) });

    expect(await runLoad(load, probe)).toEqual({ quotaQueryState: emptyServerDelta(), runtimeMode: 'live' });
    expect(probe.dependencies).toEqual(['ai-usage:provider-quota']);
    expect(probe.accessed).not.toContain('url');
  });

  test('the root layout document load keeps an unavailable quota rail optional and never reads the URL', async () => {
    const { load } = await import('./+layout.server');
    const probe = probeLoadEvent({
      isDataRequest: false,
      locals: { quotaE2eFailure: true },
      request: new Request(PAGE_HREF),
    });

    expect(await runLoad(load, probe)).toEqual({
      quotaE2eFailure: true,
      quotaQueryState: emptyServerDelta(),
      runtimeMode: 'live',
    });
    expect(probe.accessed).not.toContain('url');
  });

  test('the report layout defers a data request to the mounted report and never reads the URL', async () => {
    const { load } = await import('./(report)/+layout.server');
    const probe = probeLoadEvent({ isDataRequest: true, locals: {}, request: new Request(PAGE_HREF) });

    expect(await runLoad(load, probe)).toEqual({ reportQueryState: emptyServerDelta() });
    expect(probe.dependencies).toEqual(['ai-usage:report-root']);
    expect(probe.tracked).toEqual([]);
  });
});

// A document load that reached the router through an HTTP subrequest would render the same page, so
// the document path runs here against the recorders above: no store opens and no request leaves.
describe('server document acquisition', () => {
  const fetchCalls: unknown[] = [];
  const recordFetch = (input: unknown): Promise<Response> => {
    fetchCalls.push(input);
    return Promise.reject(new Error('A document load must not fetch'));
  };
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fetchCalls.length = 0;
    documentRecorder = { acquisitions: [], clientRequests: [], reportQueryState: acquiredServerDelta() };
    realFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(recordFetch, { preconnect: realFetch.preconnect });
  });

  afterEach(() => {
    documentRecorder = undefined;
    globalThis.fetch = realFetch;
  });

  test('the report layout acquires a detached page URL through the in-process client of the document request', async () => {
    const { load } = await import('./(report)/+layout.server');
    const request = new Request(PAGE_HREF);
    const probe = probeLoadEvent({ fetch: recordFetch, isDataRequest: false, locals: {}, request });

    const acquired = documentRecorder?.reportQueryState;
    expect(acquired?.dehydratedState.queries).toHaveLength(1);
    expect(await runLoad(load, probe)).toEqual({ reportQueryState: acquired });

    expect(probe.tracked).toEqual([]);
    expect(probe.untracked).toEqual(['url.href']);
    expect(probe.dependencies).toEqual(['ai-usage:report-root']);
    expect(documentRecorder?.clientRequests).toHaveLength(1);
    expect(documentRecorder?.clientRequests[0]).toBe(request);
    expect(documentRecorder?.acquisitions).toHaveLength(1);
    expect(documentRecorder?.acquisitions[0]?.pageUrl.href).toBe(PAGE_HREF);
    expect(documentRecorder?.acquisitions[0]?.pageUrl).not.toBe(probe.url);
    expect(probe.accessed).not.toContain('fetch');
    expect(fetchCalls).toEqual([]);
  });

  test('the root layout reads its quota rail through the in-process client of the document request', async () => {
    const { load } = await import('./+layout.server');
    const request = new Request(PAGE_HREF);
    const probe = probeLoadEvent({ fetch: recordFetch, isDataRequest: false, locals: {}, request });

    expect(await runLoad(load, probe)).toEqual({ quotaQueryState: emptyServerDelta(), runtimeMode: 'live' });

    expect(probe.accessed).not.toContain('url');
    expect(documentRecorder?.clientRequests).toHaveLength(1);
    expect(documentRecorder?.clientRequests[0]).toBe(request);
    expect(documentRecorder?.acquisitions).toEqual([]);
    expect(probe.accessed).not.toContain('fetch');
    expect(fetchCalls).toEqual([]);
  });
});
