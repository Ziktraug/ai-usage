import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createSingleUserAuthorizer } from '@ai-usage/authorization/single-user';
import {
  MEMORY_SERVICE_PROTOCOL_VERSION,
  type MemoryServiceErrorCode,
  memoryServiceBounds,
  parseCheckoutResolutionAction,
  parseMemoryProposalReviewAction,
} from '@ai-usage/memory-service';
import { createMemoryApplicationService, type MemoryApplicationErrorCode } from '@ai-usage/memory-service/application';
import {
  createMemoryServiceToken,
  type MemoryServiceToken,
  publishMemoryServiceRendezvous,
  revealMemoryServiceToken,
} from '@ai-usage/memory-service/node';
import {
  parseMemoryItemReadRequest,
  parseMemoryProjectContextReadRequest,
  parseMemorySearchReadRequest,
} from '@ai-usage/memory-service/read-contract';
import type { LocalIdentityKernel } from '@ai-usage/memory-sqlite/identity';

const jsonMediaType = 'application/json';
const protocolHeader = 'x-ai-usage-memory-protocol-version';
const encoder = new TextEncoder();

export interface LocalMemoryServiceHandler {
  readonly handle: (request: Request, peerAddress: string | null) => Promise<Response>;
}

export interface CreateLocalMemoryServiceHandlerOptions {
  readonly kernel: LocalIdentityKernel;
  readonly token: MemoryServiceToken;
}

export interface LocalMemoryServiceRuntime {
  readonly dispose: () => Promise<void>;
  readonly port: number;
}

export interface StartLocalMemoryServiceOptions extends CreateLocalMemoryServiceHandlerOptions {
  readonly hostname?: string;
  readonly port?: number;
  readonly replaceStaleRendezvous?: boolean;
  readonly stateDirectory: string;
}

const jsonResponse = (value: unknown, status = 200): Response => {
  const body = JSON.stringify(value);
  return new Response(body, {
    headers: {
      'cache-control': 'no-store',
      'content-length': String(encoder.encode(body).byteLength),
      'content-type': jsonMediaType,
    },
    status,
  });
};

const successResponse = (data: unknown): Response =>
  jsonResponse({ data, ok: true, protocolVersion: MEMORY_SERVICE_PROTOCOL_VERSION });

const errorResponse = (code: MemoryServiceErrorCode, message: string, status: number): Response =>
  jsonResponse({ error: { code, message }, ok: false, protocolVersion: MEMORY_SERVICE_PROTOCOL_VERSION }, status);

const proposalActionErrorResponse = (code: MemoryApplicationErrorCode): Response => {
  if (code === 'authorization-denied') {
    return errorResponse('forbidden', 'Memory proposal action could not be applied.', 403);
  }
  if (code === 'invalid-input') {
    return errorResponse('invalid-request', 'Memory proposal action could not be applied.', 400);
  }
  if (code === 'not-found') {
    return errorResponse('service-unavailable', 'Memory proposal action could not be applied.', 404);
  }
  if (code === 'conflict' || code === 'stale') {
    return errorResponse('service-unavailable', 'Memory proposal action could not be applied.', 409);
  }
  return errorResponse('service-unavailable', 'Memory proposal action could not be applied.', 503);
};

const memoryReadErrorResponse = (code: MemoryApplicationErrorCode): Response => {
  if (code === 'authorization-denied') {
    return errorResponse('forbidden', 'Memory retrieval is not permitted.', 403);
  }
  if (code === 'authorization-unavailable') {
    return errorResponse('authorization-unavailable', 'Memory retrieval authorization is unavailable.', 503);
  }
  if (code === 'invalid-input') {
    return errorResponse('invalid-request', 'Memory retrieval request is invalid.', 400);
  }
  if (code === 'not-found') {
    return errorResponse('not-found', 'Memory retrieval result was not found.', 404);
  }
  return errorResponse('service-unavailable', 'Memory retrieval is unavailable.', 503);
};

const tokenMatches = (request: Request, token: MemoryServiceToken): boolean => {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return false;
  }
  const supplied = encoder.encode(authorization.slice('Bearer '.length));
  const expected = encoder.encode(revealMemoryServiceToken(token));
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
};

const readBoundedJson = async (request: Request): Promise<unknown> => {
  const contentLengthValue = request.headers.get('content-length');
  if (contentLengthValue !== null) {
    const contentLength = Number(contentLengthValue);
    if (!(Number.isSafeInteger(contentLength) && contentLength >= 0)) {
      throw new Error('invalid-content-length');
    }
    if (contentLength > memoryServiceBounds.maxRequestBytes) {
      throw new Error('request-too-large');
    }
  }
  if (request.body === null) {
    throw new Error('missing-body');
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > memoryServiceBounds.maxRequestBytes) {
        throw new Error('request-too-large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
};

export const createLocalMemoryServiceHandler = async ({
  kernel,
  token,
}: CreateLocalMemoryServiceHandlerOptions): Promise<LocalMemoryServiceHandler> => {
  const bootstrap = await kernel.getBootstrapIdentity();
  const principal = { kind: 'person' as const, personId: bootstrap.person.id };
  const authorizer = createSingleUserAuthorizer({
    listKnownResources: async () =>
      (await kernel.memory.listAuthorizationResourceIds(bootstrap.space.id)).map((id) => ({
        id,
        kind: 'memory' as const,
        spaceId: bootstrap.space.id,
      })),
    localPersonId: bootstrap.person.id,
    personalSpaceId: bootstrap.space.id,
  });
  const memoryApplication = createMemoryApplicationService(authorizer, kernel.memory);
  const memoryAuthorization = { activeSpaceId: bootstrap.space.id, trustedDevice: true } as const;
  const authorize = async (permission: 'manage_project' | 'manage_repository_binding' | 'view_repository_metadata') =>
    await authorizer.check({
      context: { activeSpaceId: bootstrap.space.id, trustedDevice: true },
      permission,
      principal,
      resource: { id: bootstrap.space.id, kind: 'space', spaceId: bootstrap.space.id },
    });

  const handler: LocalMemoryServiceHandler = {
    handle: async (request, peerAddress) => {
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return errorResponse('forbidden', 'Memory service request origin is not permitted.', 403);
      }
      if (peerAddress !== '127.0.0.1' || url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
        return errorResponse('forbidden', 'Memory service request origin is not permitted.', 403);
      }
      if (request.headers.get(protocolHeader) !== String(MEMORY_SERVICE_PROTOCOL_VERSION)) {
        return errorResponse('protocol-mismatch', 'Memory service protocol version mismatch.', 426);
      }
      if (!tokenMatches(request, token)) {
        return errorResponse('authentication-failed', 'Memory service authentication failed.', 401);
      }
      if (
        url.pathname === '/v1/memory-search' ||
        url.pathname === '/v1/memory-items/get' ||
        url.pathname === '/v1/memory-project-context'
      ) {
        if (request.method !== 'POST') {
          return new Response(null, { status: 405 });
        }
        if ((request.headers.get('content-type') ?? '').split(';', 1)[0]?.trim() !== jsonMediaType) {
          return errorResponse('invalid-request', 'Memory retrieval requires JSON.', 415);
        }
        let body: unknown;
        try {
          body = await readBoundedJson(request);
        } catch (error) {
          const tooLarge = error instanceof Error && error.message === 'request-too-large';
          return errorResponse(
            tooLarge ? 'request-too-large' : 'invalid-request',
            tooLarge ? 'Memory retrieval request exceeds its byte limit.' : 'Memory retrieval request is invalid.',
            tooLarge ? 413 : 400,
          );
        }
        if (url.pathname === '/v1/memory-search') {
          let query: ReturnType<typeof parseMemorySearchReadRequest>;
          try {
            query = parseMemorySearchReadRequest(body, bootstrap.space.id);
          } catch {
            return errorResponse('invalid-request', 'Memory search request is invalid.', 400);
          }
          const result = await memoryApplication.searchMemory({
            ...query,
            authorization: memoryAuthorization,
            principal,
            signal: request.signal,
          });
          return result.kind === 'success' ? successResponse(result.value) : memoryReadErrorResponse(result.error.code);
        }
        if (url.pathname === '/v1/memory-items/get') {
          let query: ReturnType<typeof parseMemoryItemReadRequest>;
          try {
            query = parseMemoryItemReadRequest(body);
          } catch {
            return errorResponse('invalid-request', 'Memory item request is invalid.', 400);
          }
          const result = await memoryApplication.getMemoryItem({
            authorization: memoryAuthorization,
            itemId: query.itemId,
            principal,
            spaceId: bootstrap.space.id,
          });
          return result.kind === 'success' ? successResponse(result.value) : memoryReadErrorResponse(result.error.code);
        }
        let query: ReturnType<typeof parseMemoryProjectContextReadRequest>;
        try {
          query = parseMemoryProjectContextReadRequest(body);
        } catch {
          return errorResponse('invalid-request', 'Memory Project context request is invalid.', 400);
        }
        const result = await memoryApplication.getProjectContext({
          authorization: memoryAuthorization,
          limit: query.limit,
          principal,
          projectId: query.projectId,
          signal: request.signal,
          spaceId: bootstrap.space.id,
        });
        return result.kind === 'success' ? successResponse(result.value) : memoryReadErrorResponse(result.error.code);
      }
      if (url.pathname === '/v1/memory-proposals') {
        if (request.method !== 'GET' || request.body !== null) {
          return new Response(null, { status: 405 });
        }
        const cursor = url.searchParams.get('cursor');
        if (cursor !== null && cursor.length > 4096) {
          return errorResponse('invalid-request', 'Memory proposal cursor is invalid.', 400);
        }
        const result = await memoryApplication.listPendingProposals({
          authorization: memoryAuthorization,
          ...(cursor === null ? {} : { cursor }),
          pageSize: memoryServiceBounds.maxProposals,
          principal,
          spaceId: bootstrap.space.id,
        });
        if (result.kind === 'error') {
          const forbidden = result.error.code === 'authorization-denied';
          return errorResponse(
            forbidden ? 'forbidden' : 'service-unavailable',
            forbidden ? 'Memory proposal review is not permitted.' : 'Memory proposal review is unavailable.',
            forbidden ? 403 : 503,
          );
        }
        return successResponse({
          nextCursor: result.value.nextCursor,
          proposals: result.value.items.map(({ observationSources, proposal }) => ({
            guidance: proposal.guidance,
            observationSources,
            projectId: proposal.projectId,
            proposalId: proposal.id,
            proposedByKind: proposal.proposedByPrincipal.kind,
            proposedKind: proposal.proposedKind,
            sensitivity: proposal.sensitivity,
            structuredContent: proposal.structuredContent,
            summary: proposal.summary,
            title: proposal.title,
            trustCandidate: proposal.trustCandidate,
          })),
          spaceId: bootstrap.space.id,
        });
      }
      if (url.pathname === '/v1/memory-proposals/actions') {
        if (request.method !== 'POST') {
          return new Response(null, { status: 405 });
        }
        if ((request.headers.get('content-type') ?? '').split(';', 1)[0]?.trim() !== jsonMediaType) {
          return errorResponse('invalid-request', 'Memory proposal actions require JSON.', 415);
        }
        let action: ReturnType<typeof parseMemoryProposalReviewAction>;
        try {
          action = parseMemoryProposalReviewAction(await readBoundedJson(request));
        } catch (error) {
          const tooLarge = error instanceof Error && error.message === 'request-too-large';
          return errorResponse(
            tooLarge ? 'request-too-large' : 'invalid-request',
            tooLarge ? 'Memory proposal action exceeds its byte limit.' : 'Memory proposal action is invalid.',
            tooLarge ? 413 : 400,
          );
        }
        if (action.spaceId !== bootstrap.space.id) {
          return errorResponse('forbidden', 'Memory proposal action is not permitted.', 403);
        }
        if (action.kind === 'accept') {
          const result = await memoryApplication.acceptProposal({
            authorization: memoryAuthorization,
            ...('edits' in action ? { edits: action.edits } : {}),
            principal,
            proposalId: action.proposalId,
            scope: action.scope,
            spaceId: action.spaceId,
          });
          if (result.kind === 'error') {
            return proposalActionErrorResponse(result.error.code);
          }
          return successResponse({
            itemId: result.value.item.id,
            kind: 'accepted',
            revisionId: result.value.revision.id,
          });
        }
        const result = await memoryApplication.rejectProposal({
          authorization: memoryAuthorization,
          principal,
          proposalId: action.proposalId,
          reason: action.reason,
          spaceId: action.spaceId,
        });
        if (result.kind === 'error') {
          return proposalActionErrorResponse(result.error.code);
        }
        return successResponse({ kind: 'rejected', proposalId: action.proposalId });
      }
      if (url.pathname === '/v1/repository-resolutions') {
        if (request.method !== 'GET' || request.body !== null) {
          return new Response(null, { status: 405 });
        }
        const decision = await authorize('view_repository_metadata');
        if (decision.kind === 'error') {
          return errorResponse('authorization-unavailable', 'Memory authorization is unavailable.', 503);
        }
        if (decision.kind !== 'allow') {
          return errorResponse('forbidden', 'Memory resolution review is not permitted.', 403);
        }
        try {
          const reviews = await kernel.listResolutionReviews(bootstrap.space.id);
          return successResponse({ reviews, spaceId: bootstrap.space.id });
        } catch {
          return errorResponse('service-unavailable', 'Memory resolution review is unavailable.', 503);
        }
      }
      if (url.pathname === '/v1/repository-resolutions/actions') {
        if (request.method !== 'POST') {
          return new Response(null, { status: 405 });
        }
        if ((request.headers.get('content-type') ?? '').split(';', 1)[0]?.trim() !== jsonMediaType) {
          return errorResponse('invalid-request', 'Memory resolution actions require JSON.', 415);
        }
        let action: ReturnType<typeof parseCheckoutResolutionAction>;
        try {
          action = parseCheckoutResolutionAction(await readBoundedJson(request));
        } catch (error) {
          const tooLarge = error instanceof Error && error.message === 'request-too-large';
          return errorResponse(
            tooLarge ? 'request-too-large' : 'invalid-request',
            tooLarge ? 'Memory resolution action exceeds its byte limit.' : 'Memory resolution action is invalid.',
            tooLarge ? 413 : 400,
          );
        }
        if (action.spaceId !== bootstrap.space.id) {
          return errorResponse('forbidden', 'Memory resolution action is not permitted.', 403);
        }
        const decision = await authorize(
          action.kind === 'create-project' ? 'manage_project' : 'manage_repository_binding',
        );
        if (decision.kind === 'error') {
          return errorResponse('authorization-unavailable', 'Memory authorization is unavailable.', 503);
        }
        if (decision.kind !== 'allow') {
          return errorResponse('forbidden', 'Memory resolution action is not permitted.', 403);
        }
        try {
          return successResponse(await kernel.applyResolutionAction(action));
        } catch {
          return errorResponse('service-unavailable', 'Memory resolution action could not be applied.', 503);
        }
      }
      return new Response(null, { status: 404 });
    },
  };
  return Object.freeze(handler);
};

export const startLocalMemoryService = async ({
  hostname = '127.0.0.1',
  kernel,
  port = 0,
  replaceStaleRendezvous = true,
  stateDirectory,
  token,
}: StartLocalMemoryServiceOptions): Promise<LocalMemoryServiceRuntime> => {
  if (hostname !== '127.0.0.1') {
    throw new Error('Memory service must bind numeric 127.0.0.1.');
  }
  if (!(Number.isSafeInteger(port) && port >= 0 && port <= 65_535)) {
    throw new Error('Memory service port is invalid.');
  }
  const handler = await createLocalMemoryServiceHandler({ kernel, token });
  const server = Bun.serve({
    fetch: async (request, bunServer) => await handler.handle(request, bunServer.requestIP(request)?.address ?? null),
    hostname,
    port,
  });
  const boundPort = server.port;
  if (!(typeof boundPort === 'number' && Number.isSafeInteger(boundPort) && boundPort >= 1 && boundPort <= 65_535)) {
    await server.stop(true);
    throw new Error('Memory service did not bind a valid numeric port.');
  }
  let rendezvous: Awaited<ReturnType<typeof publishMemoryServiceRendezvous>>;
  try {
    rendezvous = await publishMemoryServiceRendezvous({
      port: boundPort,
      protocolVersion: MEMORY_SERVICE_PROTOCOL_VERSION,
      replaceStale: replaceStaleRendezvous,
      stateDirectory,
      token,
    });
  } catch (error) {
    await server.stop(true);
    throw error;
  }
  let disposal: Promise<void> | undefined;
  return Object.freeze({
    dispose: () => {
      disposal ??= (async () => {
        const failures: unknown[] = [];
        try {
          await rendezvous.remove();
        } catch (error) {
          failures.push(error);
        }
        try {
          await server.stop(true);
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Memory service cleanup failed.');
        }
      })();
      return disposal;
    },
    port: boundPort,
  });
};

export const createRandomMemoryServiceToken = (): MemoryServiceToken =>
  createMemoryServiceToken(randomBytes(32).toString('base64url'));
