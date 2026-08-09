import { expect, test } from 'bun:test';
import type { Handle } from '@sveltejs/kit';
import { handleTrustedLocalRequest } from './trusted-local-hook.server';

interface HookResult {
  readonly resolved: boolean;
  readonly response: Response;
}

const invokeTrustedLocalHook = async (request: Request, isSubRequest = false): Promise<HookResult> => {
  let resolved = false;
  const response = await handleTrustedLocalRequest({
    event: { isSubRequest, request, url: new URL(request.url) } as Parameters<Handle>[0]['event'],
    resolve: () => {
      resolved = true;
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  });
  return { resolved, response };
};

test('rejects hostile and missing external Host before resolving the SvelteKit route', async () => {
  const result = await invokeTrustedLocalHook(
    new Request('http://127.0.0.1/', { headers: { host: 'attacker.example' } }),
  );

  const missingHost = await invokeTrustedLocalHook(new Request('http://127.0.0.1/'));

  expect(result.resolved).toBe(false);
  expect(result.response.status).toBe(403);
  expect(await result.response.json()).toMatchObject({ error: { tag: 'UntrustedHost' }, ok: false });
  expect(missingHost.resolved).toBe(false);
  expect(missingHost.response.status).toBe(400);
  expect(await missingHost.response.json()).toMatchObject({ error: { tag: 'MissingHost' }, ok: false });
});

test('resolves numeric-loopback and framework-owned internal requests', async () => {
  const external = await invokeTrustedLocalHook(
    new Request('http://127.0.0.1:43123/', { headers: { host: '127.0.0.1:43123' } }),
  );
  const ownedInternal = await invokeTrustedLocalHook(new Request('http://127.0.0.1:43123/internal-render'), true);

  expect(external).toMatchObject({ resolved: true, response: { status: 204 } });
  expect(ownedInternal).toMatchObject({ resolved: true, response: { status: 204 } });
});
