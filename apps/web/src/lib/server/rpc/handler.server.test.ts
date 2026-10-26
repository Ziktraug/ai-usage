import { describe, expect, test } from 'bun:test';
import { MAX_PORTABLE_USAGE_BYTES } from '@ai-usage/report-core/portable-usage';
import { QueryClient } from '@tanstack/svelte-query';
import {
  invalidateWorkThreadQueries,
  workThreadDetailKey,
  workThreadDetailQueryOptions,
  workThreadListKey,
  workThreadListQueryOptions,
} from '../../query/options/work-threads';
import { webQueryPolicies } from '../../query/policies';
import { createWebRpcClient } from '../../rpc/client';
import { createWorkThreadCommandAction, createWorkThreadsClient } from '../../rpc/work-threads-client';
import { createE2ESkillsCapability } from './context.server';
import { E2E_SKILLS_FIXTURE_HEADER, e2eSkillsFixtureVariantForHeaders } from './e2e-fixture-profile';
import { createWebRpcHttpHandler, enforceRpcResponseBound } from './handler.server';
import {
  enforceRequestPolicy,
  enforceRpcRequestPolicy,
  explicitPolicyForPath,
  rpcOperationPolicies,
  rpcPathForOperation,
} from './request-policy-handler';
import type { WebRpcRouterDependencies } from './router';
import type { SkillsCapability } from './skills';

type RpcProcedure = (input: unknown) => Promise<unknown>;
type RpcNode = Readonly<Record<string, unknown>>;

const unavailable = (): Promise<never> => Promise.reject(new Error('Synthetic deep service unavailable.'));

const unavailableServices = <Services>(overrides: object = {}): Services =>
  new Proxy(overrides, {
    get: (target, property) => (Reflect.has(target, property) ? Reflect.get(target, property) : unavailable),
  }) as Services;

const dependencies = (): WebRpcRouterDependencies => ({
  delegation: unavailableServices<WebRpcRouterDependencies['delegation']>(),
  memory: unavailableServices<WebRpcRouterDependencies['memory']>(),
  projects: unavailableServices<WebRpcRouterDependencies['projects']>(),
  report: unavailableServices<WebRpcRouterDependencies['report']>(),
  replication: unavailableServices<WebRpcRouterDependencies['replication']>(),
  session: unavailableServices<WebRpcRouterDependencies['session']>(),
  skills: {
    preflight: () => ({ allowed: false, tag: 'ForbiddenDemo' }),
    selectCapability: () => unavailableServices<SkillsCapability>(),
  },
  sync: unavailableServices<WebRpcRouterDependencies['sync']>(),
  work: unavailableServices<WebRpcRouterDependencies['work']>(),
  workAttempts: unavailableServices<WebRpcRouterDependencies['workAttempts']>(),
  workRouting: unavailableServices<WebRpcRouterDependencies['workRouting']>(),
  workThreads: unavailableServices<WebRpcRouterDependencies['workThreads']>(),
});

const trustedHandlerFetch = (handler: (request: Request) => Promise<Response>) => async (request: Request) => {
  const headers = new Headers(request.headers);
  headers.set('host', '127.0.0.1:3000');
  headers.set('origin', 'http://127.0.0.1:3000');
  headers.set('sec-fetch-site', 'same-origin');
  return await handler(new Request(request, { headers }));
};

const procedureAtPath = (client: unknown, pathname: string): RpcProcedure => {
  let node = client;
  for (const segment of pathname.slice(1).split('/')) {
    if ((typeof node !== 'object' && typeof node !== 'function') || node === null) {
      throw new Error(`Missing RPC client segment ${segment}.`);
    }
    node = (node as RpcNode)[segment];
  }
  if (typeof node !== 'function') {
    throw new Error(`Missing RPC procedure ${pathname}.`);
  }
  return node as RpcProcedure;
};

describe('Web RPC HTTP convergence', () => {
  test('uses the extended Skills fixture unless a request explicitly selects visual data', () => {
    expect(e2eSkillsFixtureVariantForHeaders(new Headers())).toBe('extended');
    expect(e2eSkillsFixtureVariantForHeaders(new Headers({ [E2E_SKILLS_FIXTURE_HEADER]: 'visual' }))).toBe('visual');
    expect(e2eSkillsFixtureVariantForHeaders(new Headers({ [E2E_SKILLS_FIXTURE_HEADER]: 'unsupported' }))).toBe(
      'extended',
    );
  });

  test('routes every non-file operation through the real RPCLink and handler with its frozen method', async () => {
    let dependencyAcquisitions = 0;
    const observed: { method: string; pathname: string }[] = [];
    const handler = createWebRpcHttpHandler({
      createDependencies: () => {
        dependencyAcquisitions += 1;
        return Promise.resolve(dependencies());
      },
    });
    const client = createWebRpcClient({
      fetch: async (request) => {
        observed.push({ method: request.method, pathname: new URL(request.url).pathname });
        return await trustedHandlerFetch(handler)(request);
      },
      url: 'http://127.0.0.1:3000/rpc',
    });

    for (const policy of rpcOperationPolicies) {
      const pathname = `/rpc${rpcPathForOperation(policy.operation)}`;
      try {
        await procedureAtPath(client, rpcPathForOperation(policy.operation))({});
      } catch {
        // Invalid synthetic inputs and unavailable fake services are expected;
        // this test owns the real transport selection and handler match only.
      }
      expect(observed.at(-1)).toEqual({ method: policy.method, pathname });
    }

    expect(observed).toHaveLength(56);
    expect(dependencyAcquisitions).toBe(56);
    expect(rpcOperationPolicies.find(({ operation }) => operation === 'stopWorkAttempt')).toMatchObject({
      method: 'POST',
      target: 'workAttempts.stop',
      transport: 'mutation',
      requestSize: 'bounded-rpc-json',
      responseSize: 'bounded-json',
    });
  });
  test('serves opaque project identity through the real Skills RPC routes only in an injected extended context', async () => {
    const capability = await createE2ESkillsCapability('extended');
    const handler = createWebRpcHttpHandler({
      createDependencies: () =>
        Promise.resolve({
          ...dependencies(),
          skills: {
            preflight: () => ({ allowed: true }),
            selectCapability: () => capability,
          },
        }),
    });
    const client = createWebRpcClient({
      fetch: trustedHandlerFetch(handler),
      url: 'http://127.0.0.1:3000/rpc',
    });

    const [knownPaths, inventories] = await Promise.all([
      client.skills.knownProjectPaths({}),
      client.skills.projectInventories({}),
    ]);

    expect(knownPaths[0]).toMatchObject({
      groupId: 'project/opaque',
      path: '/fixture/projects/opaque-project-source',
    });
    expect(inventories[0]).toMatchObject({
      observations: [{ name: 'skill-name' }],
      projectPath: '/fixture/projects/opaque-project-source',
    });
  });

  test('rejects demo, unknown, false-prefix, method, trust, CSRF, URL, and body failures before acquisition', async () => {
    let dependencyAcquisitions = 0;
    const handler = createWebRpcHttpHandler({
      createDependencies: () => {
        dependencyAcquisitions += 1;
        return Promise.resolve(dependencies());
      },
    });
    const trustedHeaders = {
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
      'sec-fetch-site': 'same-origin',
    };
    const requests = [
      new Request('http://127.0.0.1:3000/rpcreport/revisionManifest', { headers: trustedHeaders }),
      new Request('http://127.0.0.1:3000/rpc/unknown', { headers: trustedHeaders }),
      new Request('http://127.0.0.1:3000/rpc/report/revisionManifest', {
        headers: trustedHeaders,
        method: 'POST',
      }),
      new Request('http://127.0.0.1:3000/rpc/report/revisionManifest'),
      new Request('http://127.0.0.1:3000/rpc/projectGroup/save', {
        headers: { host: '127.0.0.1:3000' },
        method: 'POST',
      }),
      new Request(`http://127.0.0.1:3000/rpc/skills/projectMarkdown?value=${'x'.repeat(17 * 1024)}`, {
        headers: trustedHeaders,
      }),
      new Request('http://127.0.0.1:3000/rpc/projectGroup/save', {
        body: 'x'.repeat(12 * 1024 * 1024 + 1),
        headers: trustedHeaders,
        method: 'POST',
      }),
    ];

    const statuses: number[] = [];
    expect(requests.at(-1)?.headers.get('content-length')).toBeNull();
    for (const request of requests) {
      statuses.push((await handler(request)).status);
    }
    expect(statuses).toEqual([404, 404, 405, 400, 403, 414, 413]);
    expect(dependencyAcquisitions).toBe(0);
  });

  test('rejects withdrawn account and promotion routes before dependency acquisition', async () => {
    let dependencyAcquisitions = 0;
    const handler = createWebRpcHttpHandler({
      createDependencies: () => {
        dependencyAcquisitions += 1;
        return Promise.resolve(dependencies());
      },
    });
    for (const path of [
      '/sessionDistillation/history',
      '/sessionDistillation/projects',
      '/sessionDistillation/discover',
      '/sessionDistillation/browse',
      '/sessionDistillation/evidence',
      '/sessionDistillation/get',
      '/sessionDistillation/status',
      '/session-distillation/history',
      '/session-distillation/projects',
      '/session-distillation/discover',
      '/session-distillation/browse',
      '/session-distillation/evidence',
      '/session-distillation/get',
      '/session-distillation/status',
      '/memory/promote',
    ]) {
      const response = await trustedHandlerFetch(handler)(
        new Request(`http://127.0.0.1:3000/rpc${path}`, {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json' },
        }),
      );
      expect(response.status).toBe(404);
    }
    expect(dependencyAcquisitions).toBe(0);
  });

  test('rejects non-synthetic demo RPC paths uniformly before dependency acquisition', async () => {
    let dependencyAcquisitions = 0;
    const handler = createWebRpcHttpHandler({
      createDependencies: () => {
        dependencyAcquisitions += 1;
        return Promise.resolve(dependencies());
      },
      enforcePolicy: async (request) => await enforceRpcRequestPolicy(request, 'demo'),
    });
    const known = await handler(new Request('http://127.0.0.1:3000/rpc/report/revisionManifest'));
    const unknown = await handler(new Request('http://127.0.0.1:3000/rpc/private/secret'));
    expect({ known: known.status, unknown: unknown.status }).toEqual({ known: 404, unknown: 404 });
    expect(await known.text()).toBe('');
    expect(await unknown.text()).toBe('');
    expect(dependencyAcquisitions).toBe(0);
  });

  test('replaces an oversized response with a closed sanitized error', async () => {
    const oversized = new Response('x'.repeat(12 * 1024 * 1024 + 1), {
      headers: { 'x-private-path': '/private/history.db' },
    });
    const response = await enforceRpcResponseBound(oversized);
    expect(response.status).toBe(502);
    expect(response.headers.get('x-private-path')).toBeNull();
    expect(await response.json()).toEqual({
      error: { message: 'The RPC response exceeded its byte limit.', tag: 'ResponseTooLarge' },
      ok: false,
    });
  });

  test('closes dependency failures without forwarding private diagnostics', async () => {
    const privateDiagnostic = 'private path: /home/operator/history.db token=secret\nforged-line';
    const handler = createWebRpcHttpHandler({
      createDependencies: () => Promise.reject(new Error(privateDiagnostic)),
    });
    const response = await trustedHandlerFetch(handler)(
      new Request('http://127.0.0.1:3000/rpc/report/revisionManifest'),
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({
      error: { message: 'The RPC operation is temporarily unavailable.', tag: 'Unavailable' },
      ok: false,
    });
    expect(body).not.toContain('/home/operator');
    expect(body).not.toContain('token=secret');
    expect(body).not.toContain('forged-line');
  });

  test('isolates dependencies for concurrent requests', async () => {
    const acquiredOwners: string[] = [];
    const handler = createWebRpcHttpHandler({
      createDependencies: (request) => {
        const owner = request.headers.get('x-ai-usage-request-owner') ?? 'missing';
        acquiredOwners.push(owner);
        return Promise.resolve({
          ...dependencies(),
          report: unavailableServices<WebRpcRouterDependencies['report']>({
            getReportPerfEnabled: () => Promise.resolve(owner === 'alpha'),
          }),
        });
      },
    });
    const clientFor = (owner: string) =>
      createWebRpcClient({
        fetch: trustedHandlerFetch(handler),
        headers: { 'x-ai-usage-request-owner': owner },
        url: 'http://127.0.0.1:3000/rpc',
      });

    const [alpha, beta] = await Promise.all([
      clientFor('alpha').runtime.reportPerfEnabled({}),
      clientFor('beta').runtime.reportPerfEnabled({}),
    ]);
    expect({ alpha, beta }).toEqual({ alpha: true, beta: false });
    expect(acquiredOwners.sort()).toEqual(['alpha', 'beta']);
  });

  test('forwards client cancellation through Request to the deep service', async () => {
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let deepSignal: AbortSignal | undefined;
    const handler = createWebRpcHttpHandler({
      createDependencies: () =>
        Promise.resolve({
          ...dependencies(),
          report: unavailableServices<WebRpcRouterDependencies['report']>({
            getReportPerfEnabled: ({ signal }: { signal: AbortSignal | undefined }) => {
              deepSignal = signal;
              enteredResolve?.();
              return new Promise<boolean>((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
              });
            },
          }),
        }),
    });
    const client = createWebRpcClient({
      fetch: trustedHandlerFetch(handler),
      url: 'http://127.0.0.1:3000/rpc',
    });
    const controller = new AbortController();
    const pending = client.runtime.reportPerfEnabled({}, { signal: controller.signal });
    await entered;
    const reason = new Error('synthetic client cancellation');
    controller.abort(reason);

    await expect(pending).rejects.toThrow();
    expect(deepSignal?.aborted).toBe(true);
  });

  test('applies the shared boundary to every explicit HTTP route', async () => {
    const cases = [
      { method: 'POST', path: '/api/manual-merge/download' },
      { method: 'POST', path: '/api/manual-merge/upload' },
      { method: 'GET', path: '/api/source-control' },
      { method: 'POST', path: '/api/source-control/command' },
    ] as const;
    for (const entry of cases) {
      const policy = explicitPolicyForPath(entry.path);
      expect(policy?.method).toBe(entry.method);
      if (!policy) {
        throw new Error(`Missing explicit request policy for ${entry.path}.`);
      }
      const trusted = new Request(`http://127.0.0.1:3000${entry.path}`, {
        headers: {
          host: '127.0.0.1:3000',
          origin: 'http://127.0.0.1:3000',
          'sec-fetch-site': 'same-origin',
        },
        method: entry.method,
      });
      expect(await enforceRequestPolicy(trusted, policy, 'live')).not.toBeInstanceOf(Response);
      const demo = await enforceRequestPolicy(trusted, policy, 'demo');
      expect(demo).toBeInstanceOf(Response);
      expect((demo as Response).status).toBe(404);
      const untrusted = await enforceRequestPolicy(
        new Request(`http://127.0.0.1:3000${entry.path}`, { method: entry.method }),
        policy,
        'live',
      );
      expect(untrusted).toBeInstanceOf(Response);
    }

    const uploadPolicy = explicitPolicyForPath('/api/manual-merge/upload');
    if (!uploadPolicy) {
      throw new Error('Missing manual upload policy.');
    }
    const oversizedUpload = new Request('http://127.0.0.1:3000/api/manual-merge/upload', {
      headers: {
        'content-length': String(MAX_PORTABLE_USAGE_BYTES + 1),
        host: '127.0.0.1:3000',
        origin: 'http://127.0.0.1:3000',
        'sec-fetch-site': 'same-origin',
      },
      method: 'POST',
    });
    const oversizedResult = await enforceRequestPolicy(oversizedUpload, uploadPolicy, 'live');
    expect(oversizedResult).toBeInstanceOf(Response);
    expect((oversizedResult as Response).status).toBe(413);
  });
});

describe('synthetic Work thread RPC boundary', () => {
  test('admits only synthetic thread procedures in demo and retains method, trust, and CSRF checks', async () => {
    for (const path of ['list', 'detail', 'command']) {
      const request = new Request(`http://127.0.0.1:3000/rpc/workThreads/${path}`, {
        method: 'POST',
        headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
      });
      expect(await enforceRpcRequestPolicy(request, 'demo')).not.toBeInstanceOf(Response);
    }
    const command = 'http://127.0.0.1:3000/rpc/workThreads/command';
    const wrongMethod = await enforceRpcRequestPolicy(
      new Request(command, { headers: { host: '127.0.0.1:3000' } }),
      'demo',
    );
    const crossOrigin = await enforceRpcRequestPolicy(
      new Request(command, {
        method: 'POST',
        headers: { host: '127.0.0.1:3000', origin: 'https://untrusted.invalid' },
      }),
      'demo',
    );
    const missingOrigin = await enforceRpcRequestPolicy(
      new Request(command, { method: 'POST', headers: { host: '127.0.0.1:3000' } }),
      'demo',
    );
    expect(wrongMethod).toBeInstanceOf(Response);
    expect(crossOrigin).toBeInstanceOf(Response);
    expect(missingOrigin).toBeInstanceOf(Response);
    if (!(wrongMethod instanceof Response && crossOrigin instanceof Response && missingOrigin instanceof Response)) {
      throw new Error('Expected boundary rejection.');
    }
    expect(wrongMethod.status).toBe(405);
    expect(crossOrigin.status).toBe(403);
    expect(missingOrigin.status).toBe(403);
  });
});

describe('Work thread command client and cache identity', () => {
  const threadId = '10000000-0000-4000-8000-000000000001';
  test('one user action retains its command ID through an uncertain response and retry', async () => {
    const commandIds: string[] = [];
    const command = createWorkThreadCommandAction({ op: 'set-note', threadId, note: 'A synthetic note' });
    const handler = createWebRpcHttpHandler({
      createDependencies: () =>
        Promise.resolve({
          ...dependencies(),
          workThreads: {
            list: unavailable,
            detail: unavailable,
            command: (input) => {
              commandIds.push(input.commandId);
              if (commandIds.length === 1) {
                return unavailable();
              }
              return Promise.resolve({ ok: true, applied: false, threadId, followRevision: 1 });
            },
          },
        }),
    });
    const rpc = createWebRpcClient({ fetch: trustedHandlerFetch(handler), url: 'http://127.0.0.1:3000/rpc' });
    const client = createWorkThreadsClient(rpc.workThreads);
    await expect(client.command(command)).rejects.toMatchObject({ tag: 'Unavailable' });
    await expect(client.command(command)).resolves.toMatchObject({ ok: true, applied: false });
    expect(commandIds).toEqual([command.commandId, command.commandId]);
    expect(createWorkThreadCommandAction({ op: 'set-note', threadId, note: 'A second action' }).commandId).not.toBe(
      command.commandId,
    );
  });
  test('revision conflicts cross the transport unchanged and invalidation refreshes every list plus only that task', async () => {
    const handler = createWebRpcHttpHandler({
      createDependencies: () =>
        Promise.resolve({
          ...dependencies(),
          workThreads: {
            list: unavailable,
            detail: unavailable,
            command: () =>
              Promise.resolve({
                ok: false,
                failure: 'revision-conflict',
                currentRevision: 3,
                message: 'This task changed.',
              }),
          },
        }),
    });
    const rpc = createWebRpcClient({ fetch: trustedHandlerFetch(handler), url: 'http://127.0.0.1:3000/rpc' });
    const client = createWorkThreadsClient(rpc.workThreads);
    const result = await client.command(
      createWorkThreadCommandAction({
        acknowledgedRemainders: [],
        expectedRevision: 1,
        op: 'set-follow-state',
        reason: null,
        threadId,
        to: 'done',
        waitingFor: null,
        waitingOn: null,
      }),
    );
    expect(result).toMatchObject({ ok: false, failure: 'revision-conflict', currentRevision: 3 });
    const cache = new QueryClient();
    const following = workThreadListKey({ cursor: null, limit: 50, project: null, search: null, tab: 'open' });
    const done = workThreadListKey({ cursor: 'next', limit: 10, project: 'Test', search: '42', tab: 'done' });
    const detail = workThreadDetailKey(threadId);
    const other = workThreadDetailKey('other');
    expect(following.slice(0, 3)).toEqual(['web', 'collection-swr', 'work-threads']);
    expect(detail).toEqual(['web', 'collection-swr', 'work-threads', 'detail', threadId]);
    for (const key of [following, done, detail, other]) {
      cache.setQueryData(key, { cached: true });
    }
    await invalidateWorkThreadQueries(cache, threadId);
    for (const key of [following, done, detail]) {
      expect(cache.getQueryState(key)?.isInvalidated).toBe(true);
    }
    expect(cache.getQueryState(other)?.isInvalidated).toBe(false);
    cache.clear();
  });
  test('task list and detail revalidate collected facts on interval and focus without redundant fresh-mount reads', () => {
    const client = { detail: unavailable, list: unavailable };
    const input = { cursor: null, limit: 50, project: null, search: null, tab: 'open' as const };
    const context = { browser: true, enabled: true };
    for (const options of [
      workThreadListQueryOptions(client, input, context),
      workThreadDetailQueryOptions(client, threadId, context),
    ]) {
      expect(options.refetchInterval).toBe(webQueryPolicies.collectionFactsSwr.refetchInterval);
      expect(options.refetchInterval).toBeGreaterThan(0);
      expect(options.staleTime).toBe(webQueryPolicies.collectionFactsSwr.staleTime);
      expect(options.refetchOnWindowFocus).toBe(true);
      expect(options.refetchOnMount).toBe(true);
      expect(options.retry).toBe(false);
      expect(options.enabled).toBe(true);
    }
    expect(workThreadListQueryOptions(client, input, { browser: false, enabled: true }).enabled).toBe(false);
    expect(workThreadDetailQueryOptions(client, threadId, { browser: true, enabled: false }).enabled).toBe(false);
  });
  test('cancellation stays cancellation and unavailable reads never become empty success', async () => {
    const handler = createWebRpcHttpHandler({ createDependencies: () => Promise.resolve(dependencies()) });
    const rpc = createWebRpcClient({ fetch: trustedHandlerFetch(handler), url: 'http://127.0.0.1:3000/rpc' });
    const client = createWorkThreadsClient(rpc.workThreads);
    await expect(
      client.list({ cursor: null, limit: 50, project: null, search: null, tab: 'open' }),
    ).resolves.toMatchObject({ ok: false, error: { tag: 'Unavailable' } });
    const controller = new AbortController();
    controller.abort();
    await expect(client.detail({ threadId }, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
