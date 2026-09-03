import { expect, test } from 'bun:test';
import {
  createDeploymentTokenKey,
  createDeploymentTokenKeyRing,
  createDeviceCredentialToken,
} from '@ai-usage/identity/device-tokens';
import type { CaptureContextId, DeviceId, Instant, PersonId, SpaceId } from '@ai-usage/platform-core/identity';
import {
  createReplicationBatch,
  createReplicationBatchId,
  createReplicationEvent,
  createReplicationEventId,
  parseReplicationGeneration,
  USAGE_REPLICATION_STREAM_ID,
} from '@ai-usage/replication-protocol';
import { createHttpReplicationTransport, ReplicationClientError } from '.';

const instant = '2026-08-30T12:00:00.000Z' as Instant;
const deviceId = '40000000-0000-4000-8000-000000000001' as DeviceId;
const context = {
  deviceId,
  id: '40000000-0000-4000-8000-000000000002' as CaptureContextId,
  personId: '40000000-0000-4000-8000-000000000003' as PersonId,
  projectId: null,
  scmAccountId: null,
  scmInstallationId: null,
  source: 'personal-fallback' as const,
  spaceId: '40000000-0000-4000-8000-000000000004' as SpaceId,
};
const batch = createReplicationBatch({
  batchId: createReplicationBatchId(),
  captureContexts: [context],
  deviceId,
  events: [
    createReplicationEvent({
      captureContextId: context.id,
      changeKind: 'device-fact-upsert',
      eventId: createReplicationEventId(),
      factKey: `device:${deviceId}`,
      generation: parseReplicationGeneration(1),
      payload: { deviceId, kind: 'device-fact-upsert', label: 'Laptop', lastSeenAt: instant, status: 'active' },
    }),
  ],
  fromGenerationExclusive: parseReplicationGeneration(0),
  streamId: USAGE_REPLICATION_STREAM_ID,
  toGenerationInclusive: parseReplicationGeneration(1),
});
const generated = createDeviceCredentialToken(
  createDeploymentTokenKeyRing([createDeploymentTokenKey(Buffer.alloc(32, 91).toString('base64url'), 1)], 1).current,
);

test('publishes one outbound-only bounded request and parses its ACK', async () => {
  const requests: Request[] = [];
  const transport = createHttpReplicationTransport({
    baseUrl: 'https://platform.example.invalid',
    credentialToken: generated.token,
    fetch: (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Promise.resolve(
        Response.json({
          acceptedThroughGeneration: 1,
          appliedAt: instant,
          appliedBatchId: batch.batchId,
          appliedEventIds: batch.events.map(({ eventId }) => eventId),
          counts: { applied: 1, duplicate: 0, projected: 1, tombstoned: 0 },
          deviceId,
          protocolVersion: 1,
          streamId: USAGE_REPLICATION_STREAM_ID,
          warnings: [],
        }),
      );
    },
  });
  await expect(transport.publish(batch)).resolves.toMatchObject({
    kind: 'ack',
    ack: { appliedBatchId: batch.batchId },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe('https://platform.example.invalid/api/replication/batches');
  expect(requests[0]?.method).toBe('POST');
  expect(requests[0]?.headers.get('authorization')).toStartWith('Bearer ');
});

test('maps bounded server failures and Retry-After without exposing transport details', async () => {
  const transport = createHttpReplicationTransport({
    baseUrl: 'https://platform.example.invalid',
    credentialToken: generated.token,
    fetch: () => Promise.resolve(new Response('{not-json', { headers: { 'retry-after': '17' }, status: 429 })),
  });
  await expect(transport.publish(batch)).resolves.toEqual({
    kind: 'problem',
    problem: { code: 'rate-limited', retryAfterSeconds: 17 },
  });
});

test('resolves the authenticated shared Device without exposing token verifier material', async () => {
  const transport = createHttpReplicationTransport({
    baseUrl: 'https://platform.example.invalid',
    credentialToken: generated.token,
    fetch: (url) => {
      expect(url.pathname).toBe('/api/device-credentials/verify');
      return Promise.resolve(
        Response.json({
          credential: {
            createdAt: instant,
            deviceId,
            id: '40000000-0000-4000-8000-000000000005',
            keyVersion: 1,
            lastUsedAt: instant,
            revokedAt: null,
            rotatedAt: null,
          },
          device: {
            id: deviceId,
            label: 'Laptop',
            lastSeenAt: instant,
            ownerPersonId: context.personId,
            owningSpaceId: context.spaceId,
            status: 'active',
          },
        }),
      );
    },
  });
  await expect(transport.resolveDevice()).resolves.toMatchObject({
    kind: 'resolved',
    value: { credential: { deviceId }, device: { id: deviceId, owningSpaceId: context.spaceId } },
  });
});

test('requires TLS except for an explicit loopback test transport', () => {
  expect(() =>
    createHttpReplicationTransport({
      baseUrl: 'http://platform.example.invalid',
      credentialToken: generated.token,
    }),
  ).toThrow(ReplicationClientError);
  expect(() =>
    createHttpReplicationTransport({
      allowInsecureLoopback: true,
      baseUrl: 'http://127.0.0.1:4318',
      credentialToken: generated.token,
    }),
  ).not.toThrow();
});
