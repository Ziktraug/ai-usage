import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { installBrowserQueryRuntime } from '../lib/query/browser-runtime';
import { createWebQueryClient, dehydrateWebQueryClient, type WebQueryHydrationState } from '../lib/query/client';
import { createWebQueryRuntime, type WebQueryRuntime } from '../lib/query/composition';
import { createWebRpcClient } from '../lib/rpc/client';

// SvelteKit's `$app/env` exists only inside its Vite plugin; the report layout reads `dev` from it.
mock.module('$app/env', () => ({ dev: false }));

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
}

const PAGE_HREF = 'http://127.0.0.1:4173/work?q=codex&range=30d';

const probeLoadEvent = (fields: Record<string, unknown>, parentData: unknown = {}): LoadProbe => {
  const accessed: string[] = [];
  const tracked: string[] = [];
  const dependencies: string[] = [];
  let untrackDepth = 0;
  const target = new URL(PAGE_HREF);
  const url = new Proxy(target, {
    get(object, key) {
      if (untrackDepth === 0) {
        tracked.push(`url.${String(key)}`);
      }
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
  return { accessed, dependencies, event, tracked };
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

// Still a source-text check (plan 128 B2, kept on purpose): a document load that reached the router
// through an HTTP subrequest instead of in process would render the same page, and the in-process
// path builds router services that open the configured usage store, so no test here can run it.
describe('server document acquisition (source)', () => {
  test.each(['+layout.server.ts', '(report)/+layout.server.ts'])(
    '%s acquires through the in-process router client',
    async (file) => {
      const source = await Bun.file(new URL(file, import.meta.url)).text();

      expect(source).toContain('createInProcessWebRpcClient(request)');
      expect(source).not.toContain('fetch(request)');
    },
  );
});
