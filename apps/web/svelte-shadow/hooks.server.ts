import type { Handle } from '@sveltejs/kit';
import { demoRouteDecision } from '$lib/features/shell/demo-policy.server';
import { normalizeOwnedRpcSubrequest } from '$lib/server/rpc/subrequest-normalization.server';
import { getServerRuntimeMode } from '../src/server/runtime-mode.server';

process.once('sveltekit:shutdown', () => {
  setTimeout(() => process.exit(0), 0);
});

export const handle: Handle = async ({ event, resolve }) => {
  const e2eOverridesEnabled = process.env.AI_USAGE_SVELTEKIT_SHADOW_PRIVATE_E2E_OVERRIDES === '1';
  const runtimeMode =
    e2eOverridesEnabled && event.request.headers.get('x-ai-usage-shadow-mode') === 'demo'
      ? 'demo'
      : getServerRuntimeMode();
  event.locals.runtimeMode = runtimeMode;
  const decision = demoRouteDecision(event.url.pathname, runtimeMode);
  if (decision === 'not-found') {
    return new Response(null, {
      headers: {
        'cache-control': 'no-store',
        'x-ai-usage-shadow': 'sveltekit',
      },
      status: 404,
    });
  }
  if (decision === 'redirect-report') {
    return new Response(null, {
      headers: {
        location: '/',
        'x-ai-usage-shadow': 'sveltekit',
      },
      status: 307,
    });
  }
  if (event.url.pathname === '/rpc' || event.url.pathname.startsWith('/rpc/')) {
    const rpcRequest = normalizeOwnedRpcSubrequest({
      isSubRequest: event.isSubRequest,
      request: event.request,
      url: event.url,
    });
    const { handleWebRpcRequest } = await import('../src/lib/server/rpc/handler.server');
    const response = await handleWebRpcRequest(rpcRequest);
    response.headers.set('x-ai-usage-shadow', 'sveltekit');
    return response;
  }
  if (e2eOverridesEnabled && event.request.headers.get('x-ai-usage-shadow-acquisition-tripwire') === 'armed') {
    throw new Error('Synthetic acquisition tripwire reached resolve');
  }
  const errorFixtureRequested =
    e2eOverridesEnabled &&
    event.url.pathname === '/' &&
    event.request.headers.get('x-ai-usage-shadow-error') === 'once' &&
    !event.cookies.get('ai-usage-shadow-error-seen');
  if (errorFixtureRequested) {
    event.locals.shellE2eError = true;
    event.cookies.set('ai-usage-shadow-error-seen', '1', {
      httpOnly: true,
      path: '/',
      sameSite: 'strict',
    });
  }
  const response = await resolve(event, {
    filterSerializedResponseHeaders: (name) => name === 'content-type',
  });
  response.headers.set('x-ai-usage-shadow', 'sveltekit');
  if (errorFixtureRequested && response.status === 503) {
    response.headers.set('x-ai-usage-expected-error', 'shell-route');
  } else if (e2eOverridesEnabled && event.url.pathname === '/definitely-missing' && response.status === 404) {
    response.headers.set('x-ai-usage-expected-error', 'not-found-fixture');
  }
  return response;
};
