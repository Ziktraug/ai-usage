import { describe, expect, test } from 'bun:test';
import type { WebContractClient } from '@ai-usage/web-contract';
import { ORPCError } from '@orpc/server';
import { createWebRpcClient } from '../../rpc/client';
import { E2E_SKILLS_FIXTURE_HEADER } from './e2e-fixture-profile';
import { createWebRpcHttpHandler } from './handler.server';
import { createInProcessWebRpcClient, ssrSkillsFixtureVariant } from './in-process-client.server';
import { enforceRpcRequestPolicy } from './request-policy-handler';
import type { WebRpcRouterDependencies } from './router';

const unavailable = (): Promise<never> => Promise.reject(new Error('Synthetic deep service unavailable.'));

const services = <Services>(overrides: object = {}): Services =>
  new Proxy(overrides, {
    get: (target, property) => (Reflect.has(target, property) ? Reflect.get(target, property) : unavailable),
  }) as Services;

const dependencies = (overrides: Partial<WebRpcRouterDependencies> = {}): WebRpcRouterDependencies => ({
  delegation: services(),
  report: services(),
  session: services(),
  skills: { preflight: () => ({ allowed: false, tag: 'ForbiddenDemo' }), selectCapability: () => services() },
  sync: services(),
  work: services(),
  workAttempts: services(),
  workRouting: services(),
  workThreads: services(),
  ...overrides,
});

const documentRequest = (): Request => new Request('http://127.0.0.1:3000/', { headers: { host: '127.0.0.1:3000' } });

/** The browser's path: the real RPCLink against the real `/rpc` handler. */
const httpClient = (
  routerDependencies: WebRpcRouterDependencies,
  runtimeMode: 'demo' | 'live' = 'live',
): WebContractClient => {
  const handler = createWebRpcHttpHandler({
    createDependencies: () => Promise.resolve(routerDependencies),
    enforcePolicy: (request) => enforceRpcRequestPolicy(request, runtimeMode),
  });
  return createWebRpcClient({
    fetch: async (request) => {
      const headers = new Headers(request.headers);
      headers.set('host', '127.0.0.1:3000');
      headers.set('origin', 'http://127.0.0.1:3000');
      headers.set('sec-fetch-site', 'same-origin');
      return await handler(new Request(request, { headers }));
    },
    url: 'http://127.0.0.1:3000/rpc',
  });
};

const inProcessClient = async (
  routerDependencies: WebRpcRouterDependencies,
  runtimeMode: 'demo' | 'live' = 'live',
): Promise<WebContractClient> =>
  await createInProcessWebRpcClient(documentRequest(), {
    createDependencies: () => Promise.resolve(routerDependencies),
    runtimeMode,
  });

interface ObservedError {
  readonly code: string;
  readonly defined: boolean;
  readonly status: number;
}

const failureOf = async (call: () => Promise<unknown>): Promise<ObservedError & { readonly data: unknown }> => {
  try {
    await call();
  } catch (error) {
    if (error instanceof ORPCError) {
      return { code: error.code, data: error.data, defined: error.defined, status: error.status };
    }
    throw error;
  }
  throw new Error('Expected the RPC call to fail.');
};

const shapeOf = ({ code, defined, status }: ObservedError): ObservedError => ({ code, defined, status });

describe('in-process Web RPC client', () => {
  test('runs the procedure the browser calls and returns its validated output', async () => {
    let calls = 0;
    const routerDependencies = dependencies({
      report: services({
        getReportPerfEnabled: () => {
          calls += 1;
          return Promise.resolve(true);
        },
      }),
    });

    expect(await (await inProcessClient(routerDependencies)).runtime.reportPerfEnabled({})).toBe(true);
    expect(await httpClient(routerDependencies).runtime.reportPerfEnabled({})).toBe(true);
    expect(calls).toBe(2);
  });

  test('answers a declared typed error exactly as /rpc does', async () => {
    const routerDependencies = dependencies({
      workRouting: services({ isDemo: () => Promise.resolve(true) }),
    });

    const inProcess = await failureOf(async () => (await inProcessClient(routerDependencies)).workRouting.context({}));
    const overHttp = await failureOf(() => httpClient(routerDependencies).workRouting.context({}));

    expect(inProcess).toEqual({
      code: 'ForbiddenDemo',
      data: { reason: 'demo-read-only' },
      defined: true,
      status: 500,
    });
    expect(overHttp).toEqual(inProcess);
  });

  test('refuses an output its contract rejects exactly as /rpc does', async () => {
    const routerDependencies = dependencies({
      report: services({ getReportPerfEnabled: () => Promise.resolve('not a boolean') }),
    });

    const inProcess = await failureOf(async () =>
      (await inProcessClient(routerDependencies)).runtime.reportPerfEnabled({}),
    );
    const overHttp = await failureOf(() => httpClient(routerDependencies).runtime.reportPerfEnabled({}));

    expect(shapeOf(inProcess)).toEqual({ code: 'INTERNAL_SERVER_ERROR', defined: false, status: 500 });
    expect(shapeOf(overHttp)).toEqual(shapeOf(inProcess));
  });

  test('keeps the demo to synthetic procedures, refusing the rest before any service runs', async () => {
    let liveReads = 0;
    const routerDependencies = dependencies({
      report: services({
        getReportPerfEnabled: () => {
          liveReads += 1;
          return Promise.resolve(true);
        },
      }),
      workThreads: services({ list: () => Promise.reject(new Error('synthetic task service unavailable')) }),
    });
    const demo = await inProcessClient(routerDependencies, 'demo');

    const inProcess = await failureOf(() => demo.runtime.reportPerfEnabled({}));
    const overHttp = await failureOf(() => httpClient(routerDependencies, 'demo').runtime.reportPerfEnabled({}));
    // A synthetic-only procedure still runs; its service failure is its own typed envelope.
    const tasks = await demo.workThreads.list({ cursor: null, limit: 50, project: null, search: null, tab: 'open' });

    expect(shapeOf(inProcess)).toEqual({ code: 'NOT_FOUND', defined: false, status: 404 });
    expect(shapeOf(overHttp)).toEqual(shapeOf(inProcess));
    expect(liveReads).toBe(0);
    expect(tasks).toMatchObject({ ok: false });
  });

  test('refuses every mutation before any service runs, so a document load stays read-only', async () => {
    let writes = 0;
    const routerDependencies = dependencies({
      sync: services({
        setMachineLabel: () => {
          writes += 1;
          return Promise.resolve({});
        },
      }),
    });

    const refused = await failureOf(async () =>
      (await inProcessClient(routerDependencies)).sync.setMachineLabel({ label: 'Desk' }),
    );

    expect(shapeOf(refused)).toEqual({ code: 'METHOD_NOT_SUPPORTED', defined: false, status: 405 });
    expect(writes).toBe(0);
  });

  test('follows the visual Skills fixture of the document only under the private e2e overrides', () => {
    const visual = new Request('http://127.0.0.1:3000/skills', { headers: { [E2E_SKILLS_FIXTURE_HEADER]: 'visual' } });

    expect(ssrSkillsFixtureVariant(visual, true)).toBe('visual');
    expect(ssrSkillsFixtureVariant(visual, false)).toBe('extended');
    expect(ssrSkillsFixtureVariant(new Request('http://127.0.0.1:3000/skills'), true)).toBe('extended');
  });
});
