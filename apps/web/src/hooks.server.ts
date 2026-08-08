import {
  isSessionQueryPerformanceCaptureEnabled,
  readSessionQueryPerformanceCapture,
  resetSessionQueryPerformanceCapture,
} from '@ai-usage/usage-store/reader';
import type { Handle, HandleFetch } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { demoRouteDecision } from '$lib/features/shell/demo-policy.server';
import { webReadObservabilityLifecycle } from '$lib/server/observability/web-read-lifecycle.server';
import { resetReportHydrationBytes, snapshotReportHydrationBytes } from '$lib/server/perf/report-hydration-perf';
import { E2E_SKILLS_FIXTURE_HEADER } from '$lib/server/rpc/e2e-fixture-profile';
import { handleResponseCompression } from '../src/server/response-compression.server';
import { getServerRuntimeMode } from '../src/server/runtime-mode.server';
import { handleTrustedLocalRequest } from '../src/server/trusted-local-hook.server';

let observabilityInitialization: Promise<void> | undefined;
const initializeObservability = (): Promise<void> => {
  observabilityInitialization ??= webReadObservabilityLifecycle.initialize().then(() => undefined);
  return observabilityInitialization;
};

const SESSION_QUERY_PERF_PATH = '/__ai-usage/perf/session-query';

const handleSessionQueryPerfSnapshot = (request: Request): Response | undefined => {
  if (!isSessionQueryPerformanceCaptureEnabled()) {
    return;
  }
  const { pathname } = new URL(request.url);
  if (pathname !== SESSION_QUERY_PERF_PATH) {
    return;
  }
  if (request.method === 'DELETE') {
    resetSessionQueryPerformanceCapture();
    resetReportHydrationBytes();
    return new Response(null, {
      headers: { 'cache-control': 'no-store', 'x-ai-usage-sveltekit': 'active' },
      status: 204,
    });
  }
  if (request.method !== 'GET') {
    return new Response(null, {
      headers: { 'cache-control': 'no-store', 'x-ai-usage-sveltekit': 'active' },
      status: 405,
    });
  }
  return new Response(
    JSON.stringify({
      hydration: snapshotReportHydrationBytes(),
      sqlite: readSessionQueryPerformanceCapture(),
    }),
    {
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'x-ai-usage-sveltekit': 'active',
      },
      status: 200,
    },
  );
};

export const handleFetch: HandleFetch = async ({ event, fetch, request }) => {
  const visualSkillsFixtureRequested =
    process.env.AI_USAGE_SVELTEKIT_PRIVATE_E2E_OVERRIDES === '1' &&
    event.request.headers.get(E2E_SKILLS_FIXTURE_HEADER) === 'visual' &&
    new URL(request.url).pathname.startsWith('/rpc/skills/');
  if (!visualSkillsFixtureRequested) {
    return await fetch(request);
  }
  const headers = new Headers(request.headers);
  headers.set(E2E_SKILLS_FIXTURE_HEADER, 'visual');
  return await fetch(new Request(request, { headers }));
};

process.once('sveltekit:shutdown', async () => {
  await webReadObservabilityLifecycle.dispose();
  process.exit(0);
});

const handleApplicationRequest: Handle = async ({ event, resolve }) => {
  const perfSnapshot = handleSessionQueryPerfSnapshot(event.request);
  if (perfSnapshot) {
    return perfSnapshot;
  }
  const e2eOverridesEnabled = process.env.AI_USAGE_SVELTEKIT_PRIVATE_E2E_OVERRIDES === '1';
  const runtimeMode =
    e2eOverridesEnabled && event.request.headers.get('x-ai-usage-sveltekit-mode') === 'demo'
      ? 'demo'
      : getServerRuntimeMode();
  event.locals.runtimeMode = runtimeMode;
  const decision = demoRouteDecision(event.url.pathname, runtimeMode);
  if (decision === 'not-found') {
    return new Response(null, {
      headers: {
        'cache-control': 'no-store',
        'x-ai-usage-sveltekit': 'active',
      },
      status: 404,
    });
  }
  if (decision === 'redirect-report') {
    return new Response(null, {
      headers: {
        location: '/',
        'x-ai-usage-sveltekit': 'active',
      },
      status: 307,
    });
  }
  if (e2eOverridesEnabled && event.request.headers.get('x-ai-usage-sveltekit-acquisition-tripwire') === 'armed') {
    throw new Error('Synthetic acquisition tripwire reached resolve');
  }
  await initializeObservability();
  const errorFixtureRequested =
    e2eOverridesEnabled &&
    event.url.pathname === '/' &&
    event.request.headers.get('x-ai-usage-sveltekit-error') === 'once' &&
    !event.cookies.get('ai-usage-sveltekit-error-seen');
  if (errorFixtureRequested) {
    event.locals.shellE2eError = true;
    event.cookies.set('ai-usage-sveltekit-error-seen', '1', {
      httpOnly: true,
      path: '/',
      sameSite: 'strict',
    });
  }
  const response = await resolve(event, {
    filterSerializedResponseHeaders: (name) => name === 'content-type',
  });
  response.headers.set('x-ai-usage-sveltekit', 'active');
  if (errorFixtureRequested && response.status === 503) {
    response.headers.set('x-ai-usage-expected-error', 'shell-route');
  } else if (e2eOverridesEnabled && event.url.pathname === '/definitely-missing' && response.status === 404) {
    response.headers.set('x-ai-usage-expected-error', 'not-found-fixture');
  }
  return response;
};

// Compression is outermost so it also covers the trust-rejection and demo-policy short circuits.
export const handle: Handle = sequence(handleResponseCompression, handleTrustedLocalRequest, handleApplicationRequest);
