import { describe, expect, test } from 'bun:test';
import { createDeviceEnrollmentService } from '@ai-usage/identity/device-enrollment';
import { revealDeviceCredentialTokenForTransport } from '@ai-usage/identity/device-tokens';
import { createCaptureContextId, createPersonId, createSpaceId, instantNow } from '@ai-usage/platform-core/identity';
import { createPlatformStore } from '@ai-usage/postgres-store/writer';
import {
  createReplicationBatch,
  createReplicationBatchId,
  createReplicationEvent,
  createReplicationEventId,
  parseReplicationAck,
  parseReplicationGeneration,
  replicationBounds,
  USAGE_REPLICATION_STREAM_ID,
} from '@ai-usage/replication-protocol';
import { startPostgresCluster } from '../../../tools/pg-harness';
import { createPlatformApplicationHandler } from './application';
import { parsePlatformServerConfig } from './config';

const runPostgresTests = process.env.AI_USAGE_RUN_POSTGRES_TESTS === '1';
const baseUrl = 'https://platform.example.invalid';

if (runPostgresTests) {
  describe('replication HTTP endpoint', () => {
    test('authenticates Device HMAC credentials and bounds the strict protocol body', async () => {
      const cluster = await startPostgresCluster('replication-http');
      const store = await createPlatformStore({
        connectTimeoutMs: 5000,
        databaseUrl: cluster.url,
        migrationMode: 'apply',
        poolSize: 8,
        queryTimeoutMs: 5000,
        tlsMode: 'disable',
      });
      const config = parsePlatformServerConfig({
        AI_USAGE_AUTH_SECRETS: `1:${Buffer.alloc(32, 81).toString('base64url')}`,
        AI_USAGE_DEVICE_TOKEN_KEYS: `4:${Buffer.alloc(32, 82).toString('base64url')}`,
        AI_USAGE_FIRST_OWNER_BOOTSTRAP: 'false',
        AI_USAGE_GITHUB_CLIENT_ID: 'github-client-id',
        AI_USAGE_GITHUB_CLIENT_SECRET: 'github-client-secret-with-enough-entropy',
        AI_USAGE_PLATFORM_BASE_URL: baseUrl,
        AI_USAGE_PLATFORM_DATABASE_TLS: 'disable',
        AI_USAGE_PLATFORM_DATABASE_URL: cluster.url,
        NODE_ENV: 'test',
      });
      try {
        const observedAt = instantNow(() => new Date('2026-08-30T13:00:00.000Z'));
        const personId = createPersonId();
        const spaceId = createSpaceId();
        await store.identity.createPersonalIdentity({
          person: { displayName: 'HTTP replication owner', id: personId, personalSpaceId: spaceId, status: 'active' },
          space: { createdAt: observedAt, displayName: 'HTTP replication', id: spaceId, kind: 'personal' },
        });
        const devices = createDeviceEnrollmentService({
          authorizer: store.authorization,
          clock: () => new Date(observedAt),
          keyRing: config.deviceTokenKeyRing,
          store: store.devices,
        });
        const grant = await devices.requestEnrollmentGrant({
          context: { activeSpaceId: spaceId, trustedDevice: false },
          label: 'HTTP replication Device',
          principal: { kind: 'person', personId },
        });
        if (grant.kind !== 'success') {
          throw new Error('Expected enrollment grant.');
        }
        const exchanged = await devices.exchangeEnrollmentGrant(grant.value.token);
        if (exchanged.kind !== 'success') {
          throw new Error('Expected enrollment exchange.');
        }
        const context = {
          deviceId: exchanged.value.device.id,
          id: createCaptureContextId(),
          personId,
          projectId: null,
          scmAccountId: null,
          scmInstallationId: null,
          source: 'personal-fallback' as const,
          spaceId,
        };
        const event = createReplicationEvent({
          captureContextId: context.id,
          changeKind: 'device-fact-upsert',
          eventId: createReplicationEventId(),
          factKey: `device:${exchanged.value.device.id}`,
          generation: parseReplicationGeneration(1),
          payload: {
            deviceId: exchanged.value.device.id,
            kind: 'device-fact-upsert',
            label: exchanged.value.device.label,
            lastSeenAt: observedAt,
            status: 'active',
          },
        });
        const batch = createReplicationBatch({
          batchId: createReplicationBatchId(),
          captureContexts: [context],
          deviceId: exchanged.value.device.id,
          events: [event],
          fromGenerationExclusive: parseReplicationGeneration(0),
          streamId: USAGE_REPLICATION_STREAM_ID,
          toGenerationInclusive: parseReplicationGeneration(1),
        });
        const token = revealDeviceCredentialTokenForTransport(exchanged.value.token);
        const metrics: unknown[] = [];
        const application = createPlatformApplicationHandler(config, store, (metric) => metrics.push(metric));
        const publish = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
          application(
            new Request(`${baseUrl}/api/replication/batches`, {
              body: JSON.stringify(body),
              headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
              method: 'POST',
            }),
          );

        expect(
          (
            await application(
              new Request(`${baseUrl}/api/replication/batches`, {
                body: JSON.stringify(batch),
                method: 'POST',
              }),
            )
          ).status,
        ).toBe(401);
        expect((await publish(batch, { 'content-type': 'text/plain' })).status).toBe(400);
        expect((await publish(batch, { 'content-encoding': 'gzip' })).status).toBe(400);
        const oversized = await publish(batch, { 'content-length': String(replicationBounds.batchBytes + 1) });
        expect(oversized.status).toBe(413);
        expect(await oversized.json()).toEqual({ code: 'request-too-large' });
        const incompatible = await publish({ ...batch, protocolVersion: 2 });
        expect(incompatible.status).toBe(426);
        expect(await incompatible.json()).toEqual({ code: 'protocol-incompatible' });

        const first = await publish(batch);
        expect(first.status).toBe(200);
        const firstAck = parseReplicationAck(await first.json());
        expect(firstAck).toMatchObject({
          acceptedThroughGeneration: 1,
          appliedBatchId: batch.batchId,
          counts: { applied: 1, duplicate: 0, projected: 1, tombstoned: 0 },
          deviceId: exchanged.value.device.id,
        });
        const duplicate = await publish(batch);
        expect(duplicate.status).toBe(200);
        expect(parseReplicationAck(await duplicate.json())).toEqual(firstAck);

        await devices.revokeDevice({
          context: { activeSpaceId: spaceId, trustedDevice: false },
          deviceId: exchanged.value.device.id,
          principal: { kind: 'person', personId },
        });
        const revoked = await publish(batch);
        expect(revoked.status).toBe(401);
        expect(await revoked.json()).toEqual({ code: 'revoked' });
        expect(metrics).toContainEqual({
          eventCount: 1,
          outcome: 'acknowledged',
          streamId: 'usage-v1',
        });
        expect(JSON.stringify(metrics)).not.toContain(batch.events[0]?.factKey ?? 'device:');
      } finally {
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);
  });
}
