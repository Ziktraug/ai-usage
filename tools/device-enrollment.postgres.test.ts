import { describe, expect, test } from 'bun:test';
import { createDeviceEnrollmentService } from '@ai-usage/identity/device-enrollment';
import {
  createDeploymentTokenKey,
  createDeploymentTokenKeyRing,
  revealDeviceCredentialTokenForTransport,
  revealEnrollmentGrantTokenForTransport,
} from '@ai-usage/identity/device-tokens';
import { createPersonId, createSpaceId, instantNow } from '@ai-usage/platform-core/identity';
import { createPlatformTestingDatabase } from '@ai-usage/postgres-store/testing';
import { createPlatformStore } from '@ai-usage/postgres-store/writer';
import { startPostgresCluster } from './pg-harness';

const runPostgresTests = process.env.AI_USAGE_RUN_POSTGRES_TESTS === '1';

if (runPostgresTests) {
  describe('PostgreSQL Device enrollment', () => {
    test('enforces one-time exchange, atomic credential cutover, and historical provenance', async () => {
      const cluster = await startPostgresCluster('device-enrollment');
      const store = await createPlatformStore({
        connectTimeoutMs: 5000,
        databaseUrl: cluster.url,
        migrationMode: 'apply',
        poolSize: 8,
        queryTimeoutMs: 5000,
        tlsMode: 'disable',
      });
      const database = createPlatformTestingDatabase(cluster.url);
      try {
        const personId = createPersonId();
        const spaceId = createSpaceId();
        const observedAt = instantNow(() => new Date('2026-08-29T12:00:00.000Z'));
        await store.identity.createPersonalIdentity({
          person: { displayName: 'Device owner', id: personId, personalSpaceId: spaceId, status: 'active' },
          space: { createdAt: observedAt, displayName: 'Personal', id: spaceId, kind: 'personal' },
        });
        const tokenKey = createDeploymentTokenKey(Buffer.alloc(32, 11).toString('base64url'), 7);
        const service = createDeviceEnrollmentService({
          authorizer: store.authorization,
          clock: () => new Date('2026-08-29T12:00:00.000Z'),
          keyRing: createDeploymentTokenKeyRing([tokenKey], 7),
          store: store.devices,
        });
        const context = { activeSpaceId: spaceId, trustedDevice: false } as const;
        const principal = { kind: 'person' as const, personId };
        const grant = await service.requestEnrollmentGrant({ context, label: 'PostgreSQL laptop', principal });
        if (grant.kind !== 'success') {
          throw new Error('Expected enrollment grant creation to succeed.');
        }

        const exchanges = await Promise.all([
          service.exchangeEnrollmentGrant(grant.value.token),
          service.exchangeEnrollmentGrant(grant.value.token),
        ]);
        const successes = exchanges.filter((result) => result.kind === 'success');
        expect(successes).toHaveLength(1);
        expect(exchanges.filter((result) => result.kind === 'error')).toHaveLength(1);
        const exchanged = successes[0];
        if (exchanged?.kind !== 'success') {
          throw new Error('Expected exactly one successful enrollment exchange.');
        }

        const grantPlaintext = revealEnrollmentGrantTokenForTransport(grant.value.token);
        const credentialPlaintext = revealDeviceCredentialTokenForTransport(exchanged.value.token);
        expect(
          await database.queryRowCount(
            `SELECT 1
             FROM device_enrollment_grants
             WHERE public_token_id = $1 OR keyed_digest = $1`,
            [grantPlaintext],
          ),
        ).toBe(0);
        expect(
          await database.queryRowCount(
            `SELECT 1
             FROM device_credentials
             WHERE public_token_id = $1 OR keyed_digest = $1`,
            [credentialPlaintext],
          ),
        ).toBe(0);
        await expect(service.authenticateDevice(exchanged.value.token)).resolves.toMatchObject({ kind: 'success' });

        const rotated = await service.rotateDeviceCredential({
          context,
          deviceId: exchanged.value.device.id,
          principal,
        });
        if (rotated.kind !== 'success') {
          throw new Error('Expected Device credential rotation to succeed.');
        }
        await expect(service.authenticateDevice(exchanged.value.token)).resolves.toMatchObject({
          error: { code: 'identity-revoked' },
          kind: 'error',
        });
        await expect(service.authenticateDevice(rotated.value.token)).resolves.toMatchObject({ kind: 'success' });

        await expect(
          service.renameDevice({
            context,
            deviceId: exchanged.value.device.id,
            label: 'Renamed laptop',
            principal,
          }),
        ).resolves.toMatchObject({ kind: 'success', value: { label: 'Renamed laptop' } });
        await expect(service.listDevices({ context, pageSize: 20, principal })).resolves.toMatchObject({
          kind: 'success',
          value: { items: [{ device: { id: exchanged.value.device.id, label: 'Renamed laptop' } }] },
        });
        await expect(
          service.revokeDevice({ context, deviceId: exchanged.value.device.id, principal }),
        ).resolves.toMatchObject({ kind: 'success', value: { status: 'revoked' } });
        await expect(service.authenticateDevice(rotated.value.token)).resolves.toMatchObject({
          error: { code: 'identity-revoked' },
          kind: 'error',
        });
        expect(
          await database.queryRowCount('SELECT 1 FROM devices WHERE id = $1 AND status = $2', [
            exchanged.value.device.id,
            'revoked',
          ]),
        ).toBe(1);
        expect(
          await database.queryRowCount('SELECT 1 FROM device_credentials WHERE device_id = $1', [
            exchanged.value.device.id,
          ]),
        ).toBe(2);
      } finally {
        await database.close().catch(() => undefined);
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);
  });
} else {
  // biome-ignore lint/suspicious/noSkippedTests: PostgreSQL integration requires the repository-owned PostgreSQL 17 binaries.
  describe.skip('PostgreSQL Device enrollment', () => {
    test('requires AI_USAGE_RUN_POSTGRES_TESTS=1', () => undefined);
  });
}
