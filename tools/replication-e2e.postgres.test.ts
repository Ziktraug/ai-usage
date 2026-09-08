import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSingleUserAuthorizer } from '@ai-usage/authorization/single-user';
import { createDeviceEnrollmentService } from '@ai-usage/identity/device-enrollment';
import { createMemoryApplicationService } from '@ai-usage/memory-service/application';
import { type MemoryJsonValue, memoryFingerprint } from '@ai-usage/memory-service/domain';
import { openLocalIdentityKernel } from '@ai-usage/memory-sqlite/identity';
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
// Built at runtime so no editor or formatter can flatten the NUL byte into whitespace.
const nul = String.fromCharCode(0);

const serverConfig = (databaseUrl: string) =>
  parsePlatformServerConfig({
    AI_USAGE_AUTH_SECRETS: `1:${Buffer.alloc(32, 101).toString('base64url')}`,
    AI_USAGE_DEVICE_TOKEN_KEYS: `5:${Buffer.alloc(32, 102).toString('base64url')}`,
    AI_USAGE_FIRST_OWNER_BOOTSTRAP: 'false',
    AI_USAGE_GITHUB_CLIENT_ID: 'github-client-id',
    AI_USAGE_GITHUB_CLIENT_SECRET: 'github-client-secret-with-enough-entropy',
    AI_USAGE_PLATFORM_BASE_URL: baseUrl,
    AI_USAGE_PLATFORM_DATABASE_TLS: 'disable',
    AI_USAGE_PLATFORM_DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
  });

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
      const config = serverConfig(cluster.url);
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
        const seenStatuses: number[] = [];
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
            fetch: async (url, init) => {
              seenRequests.push(url.toString());
              const response = await application(new Request(url, init));
              seenStatuses.push(response.status);
              return response;
            },
          });
          const result = await runReplicationWorkerCycle({
            clock: () => new Date(observedAt),
            outbox: outboxPort(outbox),
            transport,
          });
          expect(result).toMatchObject({ kind: 'acknowledged', publishedEvents: 1 });
          expect(outbox.status()).toMatchObject({ acknowledged: 1, inFlight: 0, pending: 0 });
          return { context, outbox, transport };
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
        const publishedB = await publishDevice(deviceB);
        expect(await database.queryRowCount('SELECT 1 FROM replicated_fact_projections')).toBe(2);
        expect(
          await database.queryRowCount(
            `SELECT 1 FROM replicated_fact_projections
             WHERE fact_key = $1 AND status = 'active'`,
            [`device:${deviceA.device.id}`],
          ),
        ).toBe(1);

        // Device B reuses Device A's fact key. The server answers 409
        // fact-owner-conflict, the client classifies it as permanent, and the
        // stream blocks visibly instead of retrying; Device A's projection is intact.
        publishedB.outbox.enqueue({
          captureContext: publishedB.context,
          changeKind: 'device-fact-upsert',
          enqueuedAt: observedAt,
          eventId: createReplicationEventId(),
          factKey: `device:${deviceA.device.id}`,
          payload: {
            deviceId: deviceB.device.id,
            kind: 'device-fact-upsert',
            label: 'Impersonated Device A',
            lastSeenAt: observedAt,
            status: 'active',
          },
        });
        expect(
          await runReplicationWorkerCycle({
            clock: () => new Date(observedAt),
            outbox: outboxPort(publishedB.outbox),
            transport: publishedB.transport,
          }),
        ).toMatchObject({ kind: 'blocked', reason: 'fact-owner-conflict' });
        expect(publishedB.outbox.status()).toMatchObject({
          acknowledged: 1,
          blocked: 1,
          inFlight: 0,
          lastErrorCode: 'fact-owner-conflict',
          pending: 0,
        });
        expect(await database.queryRowCount('SELECT 1 FROM replicated_fact_projections')).toBe(2);
        expect(
          await database.queryRowCount(
            `SELECT 1 FROM replicated_fact_projections
             WHERE fact_key = $1 AND device_id = $2 AND status = 'active' AND payload ->> 'label' = $3`,
            [`device:${deviceA.device.id}`, deviceA.device.id, deviceA.device.label],
          ),
        ).toBe(1);
        expect(seenRequests).toEqual(Array.from({ length: 3 }, () => `${baseUrl}/api/replication/batches`));
        expect(seenStatuses).toEqual([200, 200, 409]);
      } finally {
        for (const local of localDatabases) {
          local.close();
        }
        await database.close().catch(() => undefined);
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);

    test('keeps a NUL-bearing Memory item local, publishes the next item, and refuses a crafted NUL batch', async () => {
      const cluster = await startPostgresCluster('replication-e2e-memory-nul');
      const store = await createPlatformStore({
        connectTimeoutMs: 5000,
        databaseUrl: cluster.url,
        migrationMode: 'apply',
        poolSize: 8,
        queryTimeoutMs: 5000,
        tlsMode: 'disable',
      });
      const database = createPlatformTestingDatabase(cluster.url);
      const config = serverConfig(cluster.url);
      const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-replication-e2e-memory-'));
      const memoryDatabasePath = path.join(directory, 'memory.sqlite');
      const kernel = await openLocalIdentityKernel({ databasePath: memoryDatabasePath });
      const usageDatabase = new Database(':memory:');
      try {
        const personId = createPersonId();
        const spaceId = createSpaceId();
        await store.identity.createPersonalIdentity({
          person: { displayName: 'Memory owner', id: personId, personalSpaceId: spaceId, status: 'active' },
          space: { createdAt: observedAt, displayName: 'Memory', id: spaceId, kind: 'personal' },
        });
        const devices = createDeviceEnrollmentService({
          authorizer: store.authorization,
          clock: () => new Date(observedAt),
          keyRing: config.deviceTokenKeyRing,
          store: store.devices,
        });
        const grant = await devices.requestEnrollmentGrant({
          context: { activeSpaceId: spaceId, trustedDevice: false },
          label: 'Memory Device',
          principal: { kind: 'person', personId },
        });
        if (grant.kind !== 'success') {
          throw new Error('Expected enrollment grant.');
        }
        const enrollment = await devices.exchangeEnrollmentGrant(grant.value.token);
        if (enrollment.kind !== 'success') {
          throw new Error('Expected enrollment exchange.');
        }
        const application = createPlatformApplicationHandler(config, store);
        const seenStatuses: number[] = [];
        const transportWith = (rewriteBody?: (body: string) => string) =>
          createHttpReplicationTransport({
            baseUrl,
            credentialToken: enrollment.value.token,
            fetch: async (url, init) => {
              if (rewriteBody !== undefined && typeof init.body !== 'string') {
                throw new Error('Expected the replication client to send a JSON string body.');
              }
              const response = await application(
                new Request(
                  url,
                  rewriteBody === undefined ? init : { ...init, body: rewriteBody(init.body as string) },
                ),
              );
              seenStatuses.push(response.status);
              return response;
            },
          });

        // The local Memory kernel is configured exactly as the usage engine does it:
        // the explicit shared Capture Context names the enrolled Device.
        const identity = await kernel.getBootstrapIdentity();
        let now = new Date(observedAt);
        const authorizer = createSingleUserAuthorizer({
          listKnownResources: async () =>
            (await kernel.memory.listAuthorizationResourceIds(identity.space.id)).map((id) => ({
              id,
              kind: 'memory' as const,
              spaceId: identity.space.id,
            })),
          localPersonId: identity.person.id,
          personalSpaceId: identity.space.id,
        });
        const service = createMemoryApplicationService(authorizer, kernel.memory, () => now);
        const authorization = { activeSpaceId: identity.space.id, trustedDevice: true } as const;
        const principal = { kind: 'person' as const, personId: identity.person.id };
        const accept = async (title: string, structuredContent: MemoryJsonValue) => {
          now = new Date(now.getTime() + 60_000);
          const evidence = { source: `synthetic evidence for ${title}` } as const;
          const observation = await service.recordObservation({
            authorization,
            captureContextId: null,
            content: evidence,
            fingerprint: memoryFingerprint(evidence),
            principal,
            projectId: null,
            sensitivity: 'normal',
            sourceKind: 'user',
            sourceLocator: `synthetic:${title}`,
          });
          if (observation.kind !== 'success') {
            throw new Error(`Observation for ${title} was not recorded.`);
          }
          const proposal = await service.createProposal({
            authorization,
            guidance: ['Keep the decision.'],
            observationIds: [observation.value.id],
            principal,
            projectId: null,
            proposedKind: 'decision',
            sensitivity: 'normal',
            structuredContent,
            summary: `${title} summary.`,
            title,
            trustCandidate: 'explicit',
          });
          if (proposal.kind !== 'success') {
            throw new Error(`Proposal for ${title} was not created.`);
          }
          const accepted = await service.acceptProposal({
            authorization,
            principal,
            proposalId: proposal.value,
            scope: 'space',
            spaceId: identity.space.id,
          });
          if (accepted.kind !== 'success') {
            throw new Error(`Proposal for ${title} was not accepted.`);
          }
          return accepted.value.item.id;
        };
        const auditRows = (action: string) => {
          const memoryDatabase = new Database(memoryDatabasePath, { readonly: true, strict: true });
          try {
            return memoryDatabase
              .query('SELECT result, subject_id, subject_type FROM memory_audit_events WHERE action = $action')
              .all({ action });
          } finally {
            memoryDatabase.close(false);
          }
        };
        expect(
          await kernel.configureReplication({
            captureContext: {
              deviceId: enrollment.value.device.id,
              id: createCaptureContextId(),
              personId,
              projectId: null,
              scmAccountId: null,
              scmInstallationId: null,
              source: 'personal-fallback',
              spaceId,
            },
            configuredAt: now,
            localProjectId: null,
            localSpaceId: identity.space.id,
          }),
        ).toMatchObject({ backfilled: 0, unpublishable: 0 });

        // A NUL inside structured content is valid Memory but not storable JSONB.
        // The item is accepted locally, never enters the outbox, and is audited.
        const nulItemId = await accept('NUL decision', { value: `a${nul}b` });
        expect(kernel.replication.status()).toMatchObject({ pending: 0, streamId: 'memory-v1' });
        expect(auditRows('replication-skipped-invalid-payload')).toEqual([
          { result: 'rejected', subject_id: nulItemId, subject_type: 'memory-item' },
        ]);

        const ordinaryItemId = await accept('Ordinary decision', { value: 'ab' });
        expect(kernel.replication.status()).toMatchObject({ pending: 1 });
        expect(
          await runReplicationWorkerCycle({
            clock: () => now,
            outbox: outboxPort(kernel.replication),
            transport: transportWith(),
          }),
        ).toMatchObject({ kind: 'acknowledged', publishedEvents: 1 });
        expect(kernel.replication.status()).toMatchObject({
          acknowledged: 1,
          acknowledgedThroughGeneration: 1,
          blocked: 0,
          inFlight: 0,
          pending: 0,
        });
        expect(await database.queryRowCount('SELECT 1 FROM replicated_fact_projections')).toBe(1);
        expect(
          await database.queryRowCount(
            `SELECT 1 FROM replicated_fact_projections
             WHERE space_id = $1 AND fact_key = $2 AND device_id = $3 AND status = 'active'`,
            [spaceId, `memory-item:${ordinaryItemId}`, enrollment.value.device.id],
          ),
        ).toBe(1);
        expect(
          await database.queryRowCount('SELECT 1 FROM replication_event_receipts WHERE fact_key = $1', [
            `memory-item:${nulItemId}`,
          ]),
        ).toBe(0);

        // A crafted body that bypasses the client's protocol validation: the
        // server refuses the NUL at parse time with 400 invalid-batch, writes
        // nothing, and the client blocks that stream instead of retrying.
        const usageOutbox = createSqliteReplicationOutbox(usageDatabase);
        usageOutbox.initialize({
          createdAt: observedAt,
          deviceId: enrollment.value.device.id,
          streamId: USAGE_REPLICATION_STREAM_ID,
        });
        usageOutbox.enqueue({
          captureContext: {
            deviceId: enrollment.value.device.id,
            id: createCaptureContextId(),
            personId,
            projectId: null,
            scmAccountId: null,
            scmInstallationId: null,
            source: 'personal-fallback',
            spaceId,
          },
          changeKind: 'device-fact-upsert',
          enqueuedAt: observedAt,
          eventId: createReplicationEventId(),
          factKey: `device:${enrollment.value.device.id}`,
          payload: {
            deviceId: enrollment.value.device.id,
            kind: 'device-fact-upsert',
            label: 'Crafted label',
            lastSeenAt: observedAt,
            status: 'active',
          },
        });
        expect(
          await runReplicationWorkerCycle({
            clock: () => now,
            outbox: outboxPort(usageOutbox),
            transport: transportWith((body) => {
              if (!body.includes('"Crafted label"')) {
                throw new Error('Expected the canonical batch body to carry the Device label.');
              }
              return body.replace('"Crafted label"', '"Crafted\\u0000label"');
            }),
          }),
        ).toMatchObject({ kind: 'blocked', reason: 'invalid-batch' });
        expect(usageOutbox.status()).toMatchObject({ acknowledged: 0, blocked: 1, lastErrorCode: 'invalid-batch' });
        expect(seenStatuses).toEqual([200, 400]);
        expect(await database.queryRowCount('SELECT 1 FROM replicated_fact_projections')).toBe(1);
        expect(await database.queryRowCount('SELECT 1 FROM replication_event_receipts')).toBe(1);
        expect(
          await database.queryRowCount('SELECT 1 FROM replication_stream_states WHERE stream_id = $1', [
            USAGE_REPLICATION_STREAM_ID,
          ]),
        ).toBe(0);
      } finally {
        usageDatabase.close();
        await kernel.close().catch(() => undefined);
        await rm(directory, { force: true, recursive: true });
        await database.close().catch(() => undefined);
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);
  });
}
