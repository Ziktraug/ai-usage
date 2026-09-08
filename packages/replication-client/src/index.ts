import type { DeviceCredentialResolution } from '@ai-usage/identity/device-enrollment';
import { type DeviceCredentialToken, revealDeviceCredentialTokenForTransport } from '@ai-usage/identity/device-tokens';
import {
  type Device,
  parseDeviceCredentialId,
  parseDeviceId,
  parseIdentityText,
  parseInstant,
  parsePersonId,
  parseSpaceId,
} from '@ai-usage/platform-core/identity';
import type { ReplicationTransport, ReplicationTransportResult } from '@ai-usage/replication-outbox/worker';
import {
  canonicalReplicationJson,
  parseReplicationAck,
  parseReplicationBatch,
  parseReplicationProblem,
  type ReplicationBatch,
  type ReplicationProblem,
} from '@ai-usage/replication-protocol';

const maximumResponseBytes = 128 * 1024;
const retryAfterPattern = /^\d+$/u;

export class ReplicationClientError extends Error {
  readonly code: 'configuration-invalid' | 'response-invalid';

  constructor(code: 'configuration-invalid' | 'response-invalid') {
    super('The replication client operation failed.');
    this.name = 'ReplicationClientError';
    this.code = code;
  }
}

export interface ReplicationClientConfig {
  readonly allowInsecureLoopback?: boolean;
  readonly baseUrl: string;
  readonly credentialToken: DeviceCredentialToken;
  readonly fetch?: (input: URL, init: RequestInit) => Promise<Response>;
}

export type ResolveReplicationDeviceResult =
  | { readonly kind: 'problem'; readonly problem: ReplicationProblem }
  | { readonly kind: 'resolved'; readonly value: DeviceCredentialResolution };

export interface HttpReplicationClient extends ReplicationTransport {
  readonly resolveDevice: (signal?: AbortSignal) => Promise<ResolveReplicationDeviceResult>;
}

const recordValue = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReplicationClientError('response-invalid');
  }
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): void => {
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !(key in value)) ||
    actual.some((key) => !keys.includes(key))
  ) {
    throw new ReplicationClientError('response-invalid');
  }
};

const optionalInstant = (value: unknown) => (value === null ? null : parseInstant(value));

const parseDeviceStatus = (value: unknown): Device['status'] => {
  if (value !== 'active' && value !== 'local' && value !== 'pending' && value !== 'revoked') {
    throw new ReplicationClientError('response-invalid');
  }
  return value;
};

const parseDeviceResolution = (value: unknown): DeviceCredentialResolution => {
  const document = recordValue(value);
  exactKeys(document, ['credential', 'device']);
  const credential = recordValue(document.credential);
  exactKeys(credential, ['createdAt', 'deviceId', 'id', 'keyVersion', 'lastUsedAt', 'revokedAt', 'rotatedAt']);
  const device = recordValue(document.device);
  exactKeys(device, ['id', 'label', 'lastSeenAt', 'ownerPersonId', 'owningSpaceId', 'status']);
  if (!Number.isSafeInteger(credential.keyVersion) || (credential.keyVersion as number) <= 0) {
    throw new ReplicationClientError('response-invalid');
  }
  const mappedDevice = {
    id: parseDeviceId(device.id),
    label: parseIdentityText(device.label, 'device.label'),
    lastSeenAt: optionalInstant(device.lastSeenAt),
    ownerPersonId: parsePersonId(device.ownerPersonId),
    owningSpaceId: parseSpaceId(device.owningSpaceId),
    status: parseDeviceStatus(device.status),
  };
  const deviceId = parseDeviceId(credential.deviceId);
  if (deviceId !== mappedDevice.id) {
    throw new ReplicationClientError('response-invalid');
  }
  return {
    credential: {
      createdAt: parseInstant(credential.createdAt),
      deviceId,
      id: parseDeviceCredentialId(credential.id),
      keyVersion: credential.keyVersion as number,
      lastUsedAt: optionalInstant(credential.lastUsedAt),
      revokedAt: optionalInstant(credential.revokedAt),
      rotatedAt: optionalInstant(credential.rotatedAt),
    },
    device: mappedDevice,
  };
};

const parseBaseUrl = (value: string, allowInsecureLoopback: boolean): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ReplicationClientError('configuration-invalid');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost';
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    (url.protocol !== 'https:' && !(allowInsecureLoopback && loopback && url.protocol === 'http:'))
  ) {
    throw new ReplicationClientError('configuration-invalid');
  }
  return url;
};

const readBoundedJson = async (response: Response): Promise<unknown> => {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!retryAfterPattern.test(declared) || Number(declared) > maximumResponseBytes)) {
    throw new ReplicationClientError('response-invalid');
  }
  if (!response.body) {
    throw new ReplicationClientError('response-invalid');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > maximumResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ReplicationClientError('response-invalid');
      }
      chunks.push(next.value);
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
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ReplicationClientError('response-invalid');
  }
};

const retryAfterSeconds = (response: Response): number | undefined => {
  const value = response.headers.get('retry-after');
  if (value === null || !retryAfterPattern.test(value)) {
    return;
  }
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 86_400 ? seconds : undefined;
};

const fallbackProblem = (response: Response): ReplicationProblem => {
  if (response.status === 401) {
    return { code: 'unauthenticated' };
  }
  if (response.status === 403) {
    return { code: 'capture-context-forbidden' };
  }
  if (response.status === 413) {
    return { code: 'request-too-large' };
  }
  if (response.status === 426) {
    return { code: 'protocol-incompatible' };
  }
  if (response.status === 429) {
    const retryAfter = retryAfterSeconds(response);
    return { code: 'rate-limited', ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }) };
  }
  return { code: response.status >= 500 ? 'server-unavailable' : 'invalid-batch' };
};

const parseProblemResponse = async (response: Response): Promise<ReplicationProblem> => {
  let parsed: ReplicationProblem;
  try {
    parsed = parseReplicationProblem(await readBoundedJson(response));
  } catch {
    return fallbackProblem(response);
  }
  if (parsed.code === 'rate-limited' && parsed.retryAfterSeconds === undefined) {
    const retryAfter = retryAfterSeconds(response);
    return { ...parsed, ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }) };
  }
  return parsed;
};

export const createHttpReplicationTransport = (config: ReplicationClientConfig): HttpReplicationClient => {
  const baseUrl = parseBaseUrl(config.baseUrl, config.allowInsecureLoopback ?? false);
  const endpoint = new URL('/api/replication/batches', baseUrl);
  const transportFetch = config.fetch ?? ((input: URL, init: RequestInit) => globalThis.fetch(input, init));
  const token = revealDeviceCredentialTokenForTransport(config.credentialToken);
  const authenticatedRequest = (
    endpointUrl: URL,
    init: Omit<RequestInit, 'headers'> & { readonly headers?: Record<string, string> },
  ): Promise<Response> =>
    transportFetch(endpointUrl, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });
  return Object.freeze({
    publish: async (batchValue: ReplicationBatch, signal?: AbortSignal): Promise<ReplicationTransportResult> => {
      const batch = parseReplicationBatch(batchValue);
      const response = await authenticatedRequest(endpoint, {
        body: canonicalReplicationJson(batch),
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
        },
        method: 'POST',
        redirect: 'error',
        ...(signal === undefined ? {} : { signal }),
      });
      if (response.status === 200) {
        const ack = parseReplicationAck(await readBoundedJson(response));
        return { ack, kind: 'ack' };
      }
      return { kind: 'problem', problem: await parseProblemResponse(response) };
    },
    resolveDevice: async (signal?: AbortSignal): Promise<ResolveReplicationDeviceResult> => {
      const response = await authenticatedRequest(new URL('/api/device-credentials/verify', baseUrl), {
        cache: 'no-store',
        method: 'POST',
        redirect: 'error',
        ...(signal === undefined ? {} : { signal }),
      });
      if (response.status !== 200) {
        return { kind: 'problem', problem: await parseProblemResponse(response) };
      }
      return { kind: 'resolved', value: parseDeviceResolution(await readBoundedJson(response)) };
    },
  });
};
