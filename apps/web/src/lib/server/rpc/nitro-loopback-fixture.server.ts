import { createWebRpcHttpHandler, enforceRpcResponseBound } from './handler.server';
import { ReportRpcServiceError } from './report';
import { enforceRpcRequestPolicy } from './request-policy-handler';
import type { WebRpcRouterDependencies } from './router';
import type { SkillsCapability } from './skills';

const OVERSIZED_RESPONSE_BYTES = 12 * 1024 * 1024 + 1;
const FIXTURE_MODE_HEADER = 'x-ai-usage-loopback-mode';
const FIXTURE_OWNER_HEADER = 'x-ai-usage-request-owner';
const FIXTURE_RESPONSE_HEADER = 'x-ai-usage-loopback-response';

const unavailable = (): Promise<never> => Promise.reject(new Error('Synthetic deep service unavailable.'));

const unavailableServices = <Services>(overrides: object = {}): Services =>
  new Proxy(overrides, {
    get: (target, property) => (Reflect.has(target, property) ? Reflect.get(target, property) : unavailable),
  }) as Services;

let concurrentEntrants = 0;
let releaseConcurrentPair: (() => void) | undefined;
const concurrentPair = new Promise<void>((resolvePair) => {
  releaseConcurrentPair = resolvePair;
});

const awaitConcurrentPair = async (): Promise<void> => {
  concurrentEntrants += 1;
  if (concurrentEntrants === 2) {
    releaseConcurrentPair?.();
  }
  await concurrentPair;
};

const reportDependencies = (request: Request): WebRpcRouterDependencies['report'] => {
  const owner = request.headers.get(FIXTURE_OWNER_HEADER) ?? 'default';
  const getReportPerfEnabled: WebRpcRouterDependencies['report']['getReportPerfEnabled'] = async () => {
    if (owner === 'alpha' || owner === 'beta') {
      await awaitConcurrentPair();
      return owner === 'alpha';
    }
    return true;
  };
  const getReportRevisionManifest: WebRpcRouterDependencies['report']['getReportRevisionManifest'] = () => {
    if (owner === 'private-error') {
      return Promise.reject(
        new ReportRpcServiceError(
          'Unavailable',
          'The synthetic manifest is temporarily unavailable.',
          '/private/history.db',
        ),
      );
    }
    return Promise.resolve({
      manifest: {
        captureFingerprint: 'synthetic-loopback',
        expiresAt: 2,
        generatedAt: '2026-01-01T00:00:00.000Z',
        publishedAt: 1,
        revision: 'synthetic-loopback',
        rowsBytes: 0,
        supportBytes: 0,
      },
      ok: true,
      requestFingerprint: 'report-manifest:v1:{}',
    });
  };
  return unavailableServices<WebRpcRouterDependencies['report']>({
    getReportPerfEnabled,
    getReportRevisionManifest,
  });
};

const createFixtureDependencies = async (request: Request): Promise<WebRpcRouterDependencies> => ({
  report: reportDependencies(request),
  session: unavailableServices<WebRpcRouterDependencies['session']>(),
  skills: {
    preflight: () => ({ allowed: false, tag: 'ForbiddenDemo' }),
    selectCapability: () => unavailableServices<SkillsCapability>(),
  },
  sync: unavailableServices<WebRpcRouterDependencies['sync']>(),
});

const fixtureRpcHandler = createWebRpcHttpHandler({
  createDependencies: createFixtureDependencies,
  enforcePolicy: async (request) =>
    await enforceRpcRequestPolicy(request, request.headers.get(FIXTURE_MODE_HEADER) === 'demo' ? 'demo' : 'live'),
});

export const handleNitroLoopbackFixtureRequest = async (request: Request): Promise<Response> => {
  if (request.headers.get(FIXTURE_RESPONSE_HEADER) !== 'oversized') {
    return await fixtureRpcHandler(request);
  }
  const policyResult = await enforceRpcRequestPolicy(request, 'live');
  if (policyResult instanceof Response) {
    return policyResult;
  }
  return await enforceRpcResponseBound(
    new Response(new Uint8Array(OVERSIZED_RESPONSE_BYTES), {
      headers: { 'x-private-path': '/private/history.db' },
    }),
  );
};
