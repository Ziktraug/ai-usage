import { createSharedAuthenticationService, type SharedAuthenticationService } from '@ai-usage/identity/better-auth';
import { createDeviceEnrollmentService, type DeviceEnrollmentService } from '@ai-usage/identity/device-enrollment';
import {
  parseDeviceCredentialToken,
  parseEnrollmentGrantToken,
  revealDeviceCredentialTokenForTransport,
  revealEnrollmentGrantTokenForTransport,
} from '@ai-usage/identity/device-tokens';
import {
  type DeviceId,
  parseDeviceId,
  parseIdentityText,
  parseSpaceId,
  type SpaceId,
} from '@ai-usage/platform-core/identity';
import type { PlatformStore } from '@ai-usage/postgres-store/writer';
import {
  parseReplicationBatch,
  type ReplicationBatch,
  type ReplicationProblemCode,
  ReplicationProtocolError,
  type ReplicationStreamId,
  replicationBounds,
} from '@ai-usage/replication-protocol';
import { type PlatformServerConfig, revealServerSecret } from './config';

const maximumRequestBodyBytes = 16 * 1024;
const unsignedIntegerPattern = /^\d+$/u;
const deviceCredentialRotationPathPattern = /^\/api\/devices\/([^/]+)\/credential-rotation$/u;
const devicePathPattern = /^\/api\/devices\/([^/]+)$/u;
const noStoreHeaders = {
  'cache-control': 'no-store, max-age=0',
  pragma: 'no-cache',
  'referrer-policy': 'no-referrer',
} as const;

interface ApplicationServices {
  readonly authentication: SharedAuthenticationService;
  readonly devices: DeviceEnrollmentService;
}

export interface ReplicationIngestMetric {
  readonly eventCount: number | null;
  readonly outcome: 'acknowledged' | 'rejected';
  readonly problemCode?: ReplicationProblemCode;
  readonly streamId?: ReplicationStreamId;
}

const json = (status: number, value: unknown): Response => Response.json(value, { headers: noStoreHeaders, status });

const empty = (status: number): Response => new Response(null, { headers: noStoreHeaders, status });

const errorResponse = (status: number, code: string): Response => json(status, { error: { code } });

type JsonBodyResult =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'success'; readonly value: Record<string, unknown> }
  | { readonly kind: 'too-large' };

const readJsonBody = async (request: Request, maximumBytes: number): Promise<JsonBodyResult> => {
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!unsignedIntegerPattern.test(declaredLength) || Number(declaredLength) > maximumBytes)
  ) {
    return unsignedIntegerPattern.test(declaredLength) ? { kind: 'too-large' } : { kind: 'invalid' };
  }
  const reader = request.body?.getReader();
  if (!reader) {
    return { kind: 'invalid' };
  }
  try {
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      byteLength += next.value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: 'too-large' };
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? { kind: 'success', value: parsed as Record<string, unknown> }
      : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  } finally {
    reader.releaseLock();
  }
};

const parseJsonBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  const result = await readJsonBody(request, maximumRequestBodyBytes);
  return result.kind === 'success' ? result.value : null;
};

const sameOrigin = (request: Request, baseUrl: string): boolean => request.headers.get('origin') === baseUrl;

const requireAuthenticatedSession = async (authentication: SharedAuthenticationService, request: Request) => {
  const result = await authentication.resolveSession(request.headers);
  if (result.kind === 'authenticated') {
    return { kind: 'success' as const, session: result.session };
  }
  return {
    kind: 'error' as const,
    response:
      result.kind === 'unavailable'
        ? errorResponse(503, 'session-unavailable')
        : errorResponse(401, 'authentication-required'),
  };
};

const parsePageSize = (value: string | null): number | null => {
  if (value === null) {
    return 20;
  }
  if (!unsignedIntegerPattern.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 100 ? parsed : null;
};

const createServices = (config: PlatformServerConfig, store: PlatformStore): ApplicationServices => ({
  authentication: createSharedAuthenticationService({
    baseUrl: config.baseUrl,
    bootstrapFirstOwner: config.bootstrapFirstOwner,
    clientId: config.githubClientId,
    clientSecret: revealServerSecret(config.githubClientSecret),
    database: store.authentication.database,
    identityStore: store.authentication,
    secrets: config.authenticationSecrets.map(({ secret, version }) => ({
      value: revealServerSecret(secret),
      version,
    })),
  }),
  devices: createDeviceEnrollmentService({
    authorizer: store.authorization,
    keyRing: config.deviceTokenKeyRing,
    store: store.devices,
  }),
});

const handleSession = async (
  request: Request,
  services: ApplicationServices,
  baseUrl: string,
  revokeAll: boolean,
): Promise<Response> => {
  if (!revokeAll && request.method === 'GET') {
    const session = await services.authentication.resolveSession(request.headers);
    if (session.kind === 'anonymous') {
      return empty(204);
    }
    if (session.kind === 'unavailable') {
      return errorResponse(503, 'session-unavailable');
    }
    if (session.kind !== 'authenticated') {
      return empty(204);
    }
    return json(200, { session: session.session });
  }
  if (revokeAll && request.method === 'POST' && sameOrigin(request, baseUrl)) {
    const session = await requireAuthenticatedSession(services.authentication, request);
    if (session.kind === 'error') {
      return session.response;
    }
    const revoked = await services.authentication.revokeAllSessions(request.headers);
    return revoked.kind === 'success' ? empty(204) : errorResponse(503, revoked.error.code);
  }
  return errorResponse(
    revokeAll && request.method === 'POST' ? 403 : 405,
    revokeAll && request.method === 'POST' ? 'origin-denied' : 'method-not-allowed',
  );
};

const handleEnrollmentGrant = async (
  request: Request,
  services: ApplicationServices,
  baseUrl: string,
): Promise<Response> => {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method-not-allowed');
  }
  if (!sameOrigin(request, baseUrl)) {
    return errorResponse(403, 'origin-denied');
  }
  const session = await requireAuthenticatedSession(services.authentication, request);
  if (session.kind === 'error') {
    return session.response;
  }
  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'request-invalid');
  }
  try {
    const spaceId = parseSpaceId(body.spaceId);
    const label = parseIdentityText(body.label, 'device.label');
    const result = await services.devices.requestEnrollmentGrant({
      context: { activeSpaceId: spaceId, trustedDevice: false },
      label,
      principal: session.session.principal.authorizationPrincipal,
    });
    return result.kind === 'success'
      ? json(201, {
          grant: result.value.grant,
          token: revealEnrollmentGrantTokenForTransport(result.value.token),
        })
      : errorResponse(result.error.code === 'identity-denied' ? 403 : 503, result.error.code);
  } catch {
    return errorResponse(400, 'request-invalid');
  }
};

const handleEnrollmentExchange = async (request: Request, services: ApplicationServices): Promise<Response> => {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method-not-allowed');
  }
  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'request-invalid');
  }
  try {
    const result = await services.devices.exchangeEnrollmentGrant(parseEnrollmentGrantToken(body.token));
    if (result.kind === 'error') {
      const status = result.error.code === 'identity-unavailable' ? 503 : 401;
      return errorResponse(status, result.error.code);
    }
    return json(201, {
      credential: result.value.credential,
      device: result.value.device,
      token: revealDeviceCredentialTokenForTransport(result.value.token),
    });
  } catch {
    return errorResponse(400, 'request-invalid');
  }
};

const handleDeviceCredentialVerification = async (
  request: Request,
  services: ApplicationServices,
): Promise<Response> => {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method-not-allowed');
  }
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return errorResponse(401, 'device-credential-required');
  }
  try {
    const result = await services.devices.authenticateDevice(
      parseDeviceCredentialToken(authorization.slice('Bearer '.length)),
    );
    return result.kind === 'success'
      ? json(200, { credential: result.value.credential, device: result.value.device })
      : errorResponse(result.error.code === 'identity-unavailable' ? 503 : 401, result.error.code);
  } catch {
    return errorResponse(401, 'device-credential-invalid');
  }
};

const handleDeviceCollection = async (
  request: Request,
  services: ApplicationServices,
  baseUrl: string,
): Promise<Response> => {
  const session = await requireAuthenticatedSession(services.authentication, request);
  if (session.kind === 'error') {
    return session.response;
  }
  const url = new URL(request.url);
  let spaceId: SpaceId;
  try {
    spaceId = parseSpaceId(url.searchParams.get('spaceId'));
  } catch {
    return errorResponse(400, 'request-invalid');
  }
  const context = { activeSpaceId: spaceId, trustedDevice: false } as const;
  if (request.method === 'GET') {
    const pageSize = parsePageSize(url.searchParams.get('pageSize'));
    if (pageSize === null) {
      return errorResponse(400, 'request-invalid');
    }
    const result = await services.devices.listDevices({
      context,
      cursor: url.searchParams.get('cursor'),
      pageSize,
      principal: session.session.principal.authorizationPrincipal,
    });
    return result.kind === 'success' ? json(200, result.value) : errorResponse(503, result.error.code);
  }
  if (request.method === 'DELETE') {
    if (!sameOrigin(request, baseUrl)) {
      return errorResponse(403, 'origin-denied');
    }
    const result = await services.devices.revokeAllDevices({
      context,
      principal: session.session.principal.authorizationPrincipal,
    });
    return result.kind === 'success'
      ? json(200, { revokedDeviceCount: result.value })
      : errorResponse(result.error.code === 'identity-denied' ? 403 : 503, result.error.code);
  }
  return errorResponse(405, 'method-not-allowed');
};

const handleDevice = async (
  request: Request,
  services: ApplicationServices,
  baseUrl: string,
  deviceIdValue: string,
  rotate: boolean,
): Promise<Response> => {
  if (!sameOrigin(request, baseUrl)) {
    return errorResponse(403, 'origin-denied');
  }
  const session = await requireAuthenticatedSession(services.authentication, request);
  if (session.kind === 'error') {
    return session.response;
  }
  let deviceId: DeviceId;
  let spaceId: SpaceId;
  try {
    deviceId = parseDeviceId(deviceIdValue);
    spaceId = parseSpaceId(new URL(request.url).searchParams.get('spaceId'));
  } catch {
    return errorResponse(400, 'request-invalid');
  }
  const input = {
    context: { activeSpaceId: spaceId, trustedDevice: false },
    deviceId,
    principal: session.session.principal.authorizationPrincipal,
  } as const;
  if (rotate && request.method === 'POST') {
    const result = await services.devices.rotateDeviceCredential(input);
    return result.kind === 'success'
      ? json(201, {
          credential: result.value.credential,
          device: result.value.device,
          token: revealDeviceCredentialTokenForTransport(result.value.token),
        })
      : errorResponse(result.error.code === 'identity-denied' ? 403 : 503, result.error.code);
  }
  if (!rotate && request.method === 'PATCH') {
    const body = await parseJsonBody(request);
    if (!body) {
      return errorResponse(400, 'request-invalid');
    }
    try {
      const result = await services.devices.renameDevice({
        ...input,
        label: parseIdentityText(body.label, 'device.label'),
      });
      return result.kind === 'success'
        ? json(200, { device: result.value })
        : errorResponse(result.error.code === 'identity-denied' ? 403 : 503, result.error.code);
    } catch {
      return errorResponse(400, 'request-invalid');
    }
  }
  if (!rotate && request.method === 'DELETE') {
    const result = await services.devices.revokeDevice(input);
    return result.kind === 'success'
      ? json(200, { device: result.value })
      : errorResponse(result.error.code === 'identity-denied' ? 403 : 503, result.error.code);
  }
  return errorResponse(405, 'method-not-allowed');
};

const replicationProblemStatus = (code: ReplicationProblemCode): number => {
  switch (code) {
    case 'request-too-large':
      return 413;
    case 'unauthenticated':
    case 'revoked':
      return 401;
    case 'capture-context-forbidden':
      return 403;
    case 'batch-id-conflict':
    case 'event-id-conflict':
    case 'generation-gap':
    case 'overlap-conflict':
      return 409;
    case 'protocol-incompatible':
      return 426;
    case 'rate-limited':
      return 429;
    case 'server-unavailable':
      return 503;
    default:
      return 400;
  }
};

const replicationProblem = (code: ReplicationProblemCode): Response => json(replicationProblemStatus(code), { code });

const handleReplicationBatch = async (
  request: Request,
  services: ApplicationServices,
  store: PlatformStore,
  onMetric?: (metric: ReplicationIngestMetric) => void,
): Promise<Response> => {
  const reject = (
    code: ReplicationProblemCode,
    context?: { readonly eventCount: number; readonly streamId: ReplicationStreamId },
  ): Response => {
    try {
      onMetric?.({
        eventCount: context?.eventCount ?? null,
        outcome: 'rejected',
        problemCode: code,
        ...(context === undefined ? {} : { streamId: context.streamId }),
      });
    } catch {
      // Metrics are observational and never participate in authentication or durable apply.
    }
    return replicationProblem(code);
  };
  if (request.method !== 'POST') {
    return errorResponse(405, 'method-not-allowed');
  }
  const contentEncoding = request.headers.get('content-encoding');
  if (contentEncoding !== null && contentEncoding !== 'identity') {
    return reject('invalid-batch');
  }
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return reject('unauthenticated');
  }
  let authenticated: Awaited<ReturnType<ApplicationServices['devices']['authenticateDevice']>>;
  try {
    authenticated = await services.devices.authenticateDevice(
      parseDeviceCredentialToken(authorization.slice('Bearer '.length)),
    );
  } catch {
    return reject('unauthenticated');
  }
  if (authenticated.kind === 'error') {
    if (authenticated.error.code === 'identity-unavailable') {
      return reject('server-unavailable');
    }
    return reject(authenticated.error.code === 'identity-revoked' ? 'revoked' : 'unauthenticated');
  }
  if (request.headers.get('content-type')?.toLowerCase() !== 'application/json') {
    return reject('invalid-batch');
  }
  const body = await readJsonBody(request, replicationBounds.batchBytes);
  if (body.kind === 'too-large') {
    return reject('request-too-large');
  }
  if (body.kind === 'invalid') {
    return reject('invalid-batch');
  }
  let batch: ReplicationBatch;
  try {
    batch = parseReplicationBatch(body.value);
  } catch (error) {
    return reject(
      error instanceof ReplicationProtocolError && error.code === 'unsupported-version'
        ? 'protocol-incompatible'
        : 'invalid-batch',
    );
  }
  if (batch.deviceId !== authenticated.value.device.id) {
    return reject('unauthenticated', { eventCount: batch.events.length, streamId: batch.streamId });
  }
  const result = await store.replication.applyBatch({
    authenticatedCredentialId: authenticated.value.credential.id,
    authenticatedDevice: authenticated.value.device,
    batch,
  });
  try {
    onMetric?.({
      eventCount: batch.events.length,
      outcome: result.kind === 'ack' ? 'acknowledged' : 'rejected',
      ...(result.kind === 'problem' ? { problemCode: result.problem.code } : {}),
      streamId: batch.streamId,
    });
  } catch {
    // Metrics are observational and never participate in the committed ACK path.
  }
  return result.kind === 'ack'
    ? json(200, result.ack)
    : json(replicationProblemStatus(result.problem.code), result.problem);
};

export const createPlatformApplicationHandler = (
  config: PlatformServerConfig,
  store: PlatformStore,
  onReplicationMetric?: (metric: ReplicationIngestMetric) => void,
): ((request: Request) => Promise<Response>) => {
  const services = createServices(config, store);
  return (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/auth/')) {
      return services.authentication.handle(request);
    }
    if (url.pathname === '/api/session' || url.pathname === '/api/session/revoke-all') {
      return handleSession(request, services, config.baseUrl, url.pathname.endsWith('/revoke-all'));
    }
    if (url.pathname === '/api/device-enrollment-grants') {
      return handleEnrollmentGrant(request, services, config.baseUrl);
    }
    if (url.pathname === '/api/device-enrollment-exchanges') {
      return handleEnrollmentExchange(request, services);
    }
    if (url.pathname === '/api/device-credentials/verify') {
      return handleDeviceCredentialVerification(request, services);
    }
    if (url.pathname === '/api/replication/batches') {
      return handleReplicationBatch(request, services, store, onReplicationMetric);
    }
    if (url.pathname === '/api/devices') {
      return handleDeviceCollection(request, services, config.baseUrl);
    }
    const rotationMatch = deviceCredentialRotationPathPattern.exec(url.pathname);
    if (rotationMatch?.[1]) {
      return handleDevice(request, services, config.baseUrl, rotationMatch[1], true);
    }
    const deviceMatch = devicePathPattern.exec(url.pathname);
    if (deviceMatch?.[1]) {
      return handleDevice(request, services, config.baseUrl, deviceMatch[1], false);
    }
    return Promise.resolve(errorResponse(404, 'not-found'));
  };
};
