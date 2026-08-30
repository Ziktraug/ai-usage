import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createDeviceEnrollmentService } from '@ai-usage/identity/device-enrollment';
import {
  createCaptureContextId,
  createPersonId,
  createSpaceId,
  type Device,
  type DeviceCredentialId,
  instantNow,
} from '@ai-usage/platform-core/identity';
import { createPlatformTestingDatabase } from '@ai-usage/postgres-store/testing';
import { createPlatformStore } from '@ai-usage/postgres-store/writer';
import { createHttpReplicationTransport } from '@ai-usage/replication-client';
import { createSqliteReplicationOutbox } from '@ai-usage/replication-outbox';
import { type ReplicationWorkerOutboxPort, runReplicationWorkerCycle } from '@ai-usage/replication-outbox/worker';
import { createReplicationEventId, USAGE_REPLICATION_STREAM_ID } from '@ai-usage/replication-protocol';
import { createPlatformApplicationHandler } from '@ai-usage/server/application';
import { parsePlatformServerConfig } from '@ai-usage/server/config';
import { startPostgresCluster } from './pg-harness';

const runPostgresTests = process.env.AI_USAGE_RUN_POSTGRES_TESTS === '1';
const baseUrl = 'https://platform.example.invalid';
const observedAt = instantNow(() => new Date('2026-08-30T14:00:00.000Z'));

const outboxPort = (outbox: ReturnType<typeof createSqliteReplicationOutbox>): ReplicationWorkerOutboxPort => ({
  acknowledge: async (batch, ack) => outbox.acknowledge(batch, ack),
  block: async (input) => outbox.block(input),
  claimReady: async (input) => outbox.claimReady(input),
  retry: async (input) => outbox.retry(input),
  status: async () => outbox.status(),
});

if (runPostgresTests) {
  describe('outbound Device replication', () => {
    test('runs SQLite outbox to HTTPS transport to PostgreSQL and keeps an offline Device projection', async () => {
      const cluster = await startPostgresCluster('replication-e2e');
      const store = await createPlatformStore({
        connectTimeoutMs: 5000,
        databaseUrl: cluster.url,
        migrationMode: 'apply',
        poolSize: 8,
        queryTimeoutMs: 5000,
        tlsMode: 'disable',
      });
      const database = createPlatformTestingDatabase(cluster.url);
      const localDatabases: Database[] = [];
      const config = parsePlatformServerConfig({
        AI_USAGE_AUTH_SECRETS: `1:${Buffer.alloc(32, 101).toString('base64url')}`,
        AI_USAGE_DEVICE_TOKEN_KEYS: `5:${Buffer.alloc(32, 102).toString('base64url')}`,
        AI_USAGE_FIRST_OWNER_BOOTSTRAP: 'false',
        AI_USAGE_GITHUB_CLIENT_ID: 'github-client-id',
        AI_USAGE_GITHUB_CLIENT_SECRET: 'github-client-secret-with-enough-entropy',
        AI_USAGE_PLATFORM_BASE_URL: baseUrl,
        AI_USAGE_PLATFORM_DATABASE_TLS: 'disable',
        AI_USAGE_PLATFORM_DATABASE_URL: cluster.url,
        NODE_ENV: 'test',
      });
      try {
        const personId = createPersonId();
        const spaceId = createSpaceId();
        await store.identity.createPersonalIdentity({
          person: { displayName: 'Continuity owner', id: personId, personalSpaceId: spaceId, status: 'active' },
          space: { createdAt: observedAt, displayName: 'Continuity', id: spaceId, kind: 'personal' },
        });
        const devices = createDeviceEnrollmentService({
          authorizer: store.authorization,
          clock: () => new Date(observedAt),
          keyRing: config.deviceTokenKeyRing,
          store: store.devices,
        });
        const application = createPlatformApplicationHandler(config, store);
        const seenRequests: string[] = [];
        const enroll = async (label: string) => {
          const grant = await devices.requestEnrollmentGrant({
            context: { activeSpaceId: spaceId, trustedDevice: false },
            label,
            principal: { kind: 'person', personId },
          });
          if (grant.kind !== 'success') {
            throw new Error('Expected enrollment grant.');
          }
          const exchange = await devices.exchangeEnrollmentGrant(grant.value.token);
          if (exchange.kind !== 'success') {
            throw new Error('Expected enrollment exchange.');
          }
          return exchange.value;
        };
        const publishDevice = async (enrollment: {
          readonly credential: { readonly id: DeviceCredentialId };
          readonly device: Device;
          readonly token: Parameters<typeof createHttpReplicationTransport>[0]['credentialToken'];
        }) => {
          const local = new Database(':memory:');
          localDatabases.push(local);
          const outbox = createSqliteReplicationOutbox(local);
          outbox.initialize({
            createdAt: observedAt,
            deviceId: enrollment.device.id,
            streamId: USAGE_REPLICATION_STREAM_ID,
          });
          const context = {
            deviceId: enrollment.device.id,
            id: createCaptureContextId(),
            personId,
            projectId: null,
            scmAccountId: null,
            scmInstallationId: null,
            source: 'personal-fallback' as const,
            spaceId,
          };
          outbox.enqueue({
            captureContext: context,
            changeKind: 'device-fact-upsert',
            enqueuedAt: observedAt,
            eventId: createReplicationEventId(),
            factKey: `device:${enrollment.device.id}`,
            payload: {
              deviceId: enrollment.device.id,
              kind: 'device-fact-upsert',
              label: enrollment.device.label,
              lastSeenAt: observedAt,
              status: 'active',
            },
          });
          const transport = createHttpReplicationTransport({
            baseUrl,
            credentialToken: enrollment.token,
            fetch: (url, init) => {
              seenRequests.push(url.toString());
              return application(new Request(url, init));
            },
          });
          const result = await runReplicationWorkerCycle({
            clock: () => new Date(observedAt),
            outbox: outboxPort(outbox),
            transport,
          });
          expect(result).toMatchObject({ kind: 'acknowledged', publishedEvents: 1 });
          expect(outbox.status()).toMatchObject({ acknowledged: 1, inFlight: 0, pending: 0 });
        };

        const deviceA = await enroll('Offline Device A');
        await publishDevice(deviceA);
        expect(
          await database.queryRowCount(
            `SELECT 1 FROM replicated_fact_projections
             WHERE fact_key = $1 AND status = 'active'`,
            [`device:${deviceA.device.id}`],
          ),
        ).toBe(1);

        const deviceB = await enroll('Online Device B');
        await publishDevice(deviceB);
        expect(await database.queryRowCount('SELECT 1 FROM replicated_fact_projections')).toBe(2);
        expect(
          await database.queryRowCount(
            `SELECT 1 FROM replicated_fact_projections
             WHERE fact_key = $1 AND status = 'active'`,
            [`device:${deviceA.device.id}`],
          ),
        ).toBe(1);
        expect(seenRequests).toEqual([`${baseUrl}/api/replication/batches`, `${baseUrl}/api/replication/batches`]);
      } finally {
        for (const local of localDatabases) {
          local.close();
        }
        await database.close().catch(() => undefined);
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);
  });
} else {
  // biome-ignore lint/suspicious/noSkippedTests: PostgreSQL integration requires the repository-owned PostgreSQL 17 binaries.
  describe.skip('outbound Device replication', () => {
    test('requires AI_USAGE_RUN_POSTGRES_TESTS=1', () => undefined);
  });
}
