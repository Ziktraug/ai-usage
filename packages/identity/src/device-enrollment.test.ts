import { describe, expect, test } from 'bun:test';
import type { Authorizer } from '@ai-usage/authorization';
import { createAuthorizedResourceScope, readAuthorizedResourceScopeIds } from '@ai-usage/authorization/scope-internal';
import { createPersonId, createSpaceId } from '@ai-usage/platform-core/identity';
import {
  type ConfirmDeviceCredentialUseRecord,
  createDeviceEnrollmentService,
  type DeviceEnrollmentStore,
  type DeviceStoreResult,
  type ExchangeEnrollmentGrantRecord,
  type RotateDeviceCredentialRecord,
  type StoredDeviceCredential,
  type StoredDeviceEnrollmentGrant,
} from './device-enrollment';
import {
  createDeploymentTokenKey,
  createDeploymentTokenKeyRing,
  revealDeviceCredentialTokenForTransport,
  revealEnrollmentGrantTokenForTransport,
} from './device-tokens';

const now = new Date('2026-08-29T12:00:00.000Z');
const personId = createPersonId();
const spaceId = createSpaceId();
const key = createDeploymentTokenKey(Buffer.alloc(32, 7).toString('base64url'), 3);
const keyRing = createDeploymentTokenKeyRing([key], 3);
const context = { activeSpaceId: spaceId, trustedDevice: false } as const;
const principal = { kind: 'person' as const, personId };
const bearerTokenPattern = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u;

const success = <Value>(value: Value): DeviceStoreResult<Value> => ({ kind: 'success', value });

const createAuthorizer = (allowed = true): Authorizer => ({
  check: () => Promise.resolve(allowed ? { kind: 'allow', reason: 'test' } : { kind: 'deny', reason: 'test' }),
  listResources: () => Promise.reject(new Error('not used')),
  materializeResourceScope: (input) =>
    Promise.resolve(
      createAuthorizedResourceScope({
        activeSpaceId: input.context.activeSpaceId,
        permission: input.permission,
        resourceIds: [],
        resourceKind: input.resourceKind,
      }),
    ),
});

interface FakeStoreFixture {
  readonly credentials: Map<string, StoredDeviceCredential>;
  readonly grants: Map<string, StoredDeviceEnrollmentGrant>;
  readonly store: DeviceEnrollmentStore;
}

const createFakeStore = (): FakeStoreFixture => {
  const credentials = new Map<string, StoredDeviceCredential>();
  const grants = new Map<string, StoredDeviceEnrollmentGrant>();

  const store: DeviceEnrollmentStore = {
    confirmDeviceCredentialUse: (input: ConfirmDeviceCredentialUseRecord) => {
      const found = [...credentials.values()].find((candidate) => candidate.id === input.credentialId);
      if (!found || found.revokedAt !== null || found.device.status === 'revoked') {
        return Promise.resolve({ code: 'revoked', kind: 'error' });
      }
      if (
        found.verifier.keyVersion !== input.expectedVerifier.keyVersion ||
        found.verifier.keyedDigest !== input.expectedVerifier.keyedDigest
      ) {
        return Promise.resolve({ code: 'invalid', kind: 'error' });
      }
      const updated = { ...found, lastUsedAt: input.usedAt };
      credentials.set(found.verifier.publicTokenId, updated);
      return Promise.resolve(success(updated));
    },
    createEnrollmentGrant: ({ metadata, verifier }) => {
      if (grants.has(verifier.publicTokenId)) {
        return Promise.resolve({ code: 'conflict', kind: 'error' });
      }
      grants.set(verifier.publicTokenId, { ...metadata, verifier });
      return Promise.resolve(success(undefined));
    },
    exchangeEnrollmentGrant: (input: ExchangeEnrollmentGrantRecord) => {
      const found = grants.get(input.expectedGrant.verifier.publicTokenId);
      if (!found || found.consumedAt !== null) {
        return Promise.resolve({ code: 'revoked', kind: 'error' });
      }
      grants.set(found.verifier.publicTokenId, { ...found, consumedAt: input.exchangedAt });
      const credential: StoredDeviceCredential = { ...input.credential, device: input.device };
      credentials.set(input.credential.verifier.publicTokenId, credential);
      return Promise.resolve(success(credential));
    },
    findDeviceCredential: (publicTokenId) => Promise.resolve(credentials.get(publicTokenId) ?? null),
    findEnrollmentGrant: (publicTokenId) => Promise.resolve(grants.get(publicTokenId) ?? null),
    listAuthorizedDevices: ({ scope }) => {
      const ids = new Set(readAuthorizedResourceScopeIds(scope));
      return Promise.resolve(
        success({
          items: [...credentials.values()]
            .filter((credential) => ids.has(credential.device.id))
            .map((credential) => ({
              credentialCreatedAt: credential.createdAt,
              credentialLastUsedAt: credential.lastUsedAt,
              device: credential.device,
            })),
          kind: 'page' as const,
          nextCursor: null,
        }),
      );
    },
    renameDevice: ({ deviceId, label }) => {
      const found = [...credentials.values()].find((candidate) => candidate.device.id === deviceId);
      if (!found) {
        return Promise.resolve({ code: 'invalid', kind: 'error' });
      }
      const updated = { ...found, device: { ...found.device, label } };
      credentials.set(found.verifier.publicTokenId, updated);
      return Promise.resolve(success(updated.device));
    },
    revokeAllAuthorizedDevices: ({ revokedAt, scope }) => {
      const ids = new Set(readAuthorizedResourceScopeIds(scope));
      let count = 0;
      for (const [publicTokenId, credential] of credentials) {
        if (ids.has(credential.device.id) && credential.device.status !== 'revoked') {
          credentials.set(publicTokenId, {
            ...credential,
            device: { ...credential.device, status: 'revoked' },
            revokedAt,
          });
          count += 1;
        }
      }
      return Promise.resolve(success(count));
    },
    revokeDevice: ({ deviceId, revokedAt }) => {
      const matching = [...credentials.entries()].filter(([, candidate]) => candidate.device.id === deviceId);
      if (matching.length === 0) {
        return Promise.resolve({ code: 'invalid', kind: 'error' });
      }
      let device = matching[0]?.[1].device;
      if (!device) {
        return Promise.resolve({ code: 'invalid', kind: 'error' });
      }
      device = { ...device, status: 'revoked' };
      for (const [publicTokenId, credential] of matching) {
        credentials.set(publicTokenId, { ...credential, device, revokedAt });
      }
      return Promise.resolve(success(device));
    },
    rotateDeviceCredential: (input: RotateDeviceCredentialRecord) => {
      const matching = [...credentials.entries()].filter(([, candidate]) => candidate.device.id === input.deviceId);
      const device = matching[0]?.[1].device;
      if (!device || device.status === 'revoked') {
        return Promise.resolve({ code: 'revoked', kind: 'error' });
      }
      for (const [publicTokenId, credential] of matching) {
        credentials.set(publicTokenId, { ...credential, revokedAt: input.rotatedAt, rotatedAt: input.rotatedAt });
      }
      const created: StoredDeviceCredential = { ...input.credential, device };
      credentials.set(input.credential.verifier.publicTokenId, created);
      return Promise.resolve(success(created));
    },
  };

  return { credentials, grants, store };
};

describe('Device enrollment application service', () => {
  test('creates a single-use 15-minute grant without storing its plaintext token', async () => {
    const fixture = createFakeStore();
    const service = createDeviceEnrollmentService({
      authorizer: createAuthorizer(),
      clock: () => now,
      keyRing,
      store: fixture.store,
    });

    const result = await service.requestEnrollmentGrant({ context, label: 'Workstation', principal });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      throw new Error('Expected enrollment grant creation to succeed.');
    }
    expect(String(result.value.grant.expiresAt)).toBe('2026-08-29T12:15:00.000Z');
    const plaintext = revealEnrollmentGrantTokenForTransport(result.value.token);
    expect(plaintext).toMatch(bearerTokenPattern);
    expect(JSON.stringify([...fixture.grants.values()])).not.toContain(plaintext);
    expect(String(result.value.token)).toBe('[REDACTED]');
  });

  test('allows exactly one concurrent exchange and creates a distinct Device credential', async () => {
    const fixture = createFakeStore();
    const service = createDeviceEnrollmentService({
      authorizer: createAuthorizer(),
      clock: () => now,
      keyRing,
      store: fixture.store,
    });
    const created = await service.requestEnrollmentGrant({ context, label: 'Laptop', principal });
    if (created.kind !== 'success') {
      throw new Error('Expected enrollment grant creation to succeed.');
    }
    const grantPlaintext = revealEnrollmentGrantTokenForTransport(created.value.token);

    const exchanges = await Promise.all([
      service.exchangeEnrollmentGrant(created.value.token),
      service.exchangeEnrollmentGrant(created.value.token),
    ]);

    expect(exchanges.filter((result) => result.kind === 'success')).toHaveLength(1);
    expect(exchanges.filter((result) => result.kind === 'error')).toHaveLength(1);
    const exchanged = exchanges.find((result) => result.kind === 'success');
    if (exchanged?.kind !== 'success') {
      throw new Error('Expected one enrollment exchange to succeed.');
    }
    const credentialPlaintext = revealDeviceCredentialTokenForTransport(exchanged.value.token);
    expect(credentialPlaintext).not.toBe(grantPlaintext);
    expect(JSON.stringify([...fixture.credentials.values()])).not.toContain(credentialPlaintext);
    expect(JSON.stringify(exchanged.value.credential)).not.toContain('keyedDigest');
    expect(JSON.stringify(exchanged.value.credential)).not.toContain('publicTokenId');
    expect(exchanged.value.device.status).toBe('active');
  });

  test('rejects an enrollment grant at its expiry boundary without creating a Device credential', async () => {
    const fixture = createFakeStore();
    let currentTime = now;
    const service = createDeviceEnrollmentService({
      authorizer: createAuthorizer(),
      clock: () => currentTime,
      keyRing,
      store: fixture.store,
    });
    const created = await service.requestEnrollmentGrant({ context, label: 'Expired laptop', principal });
    if (created.kind !== 'success') {
      throw new Error('Expected enrollment grant creation to succeed.');
    }
    currentTime = new Date('2026-08-29T12:15:00.000Z');

    await expect(service.exchangeEnrollmentGrant(created.value.token)).resolves.toEqual({
      error: { code: 'identity-expired', operation: 'exchange-enrollment-grant' },
      kind: 'error',
    });
    expect(fixture.credentials.size).toBe(0);
  });

  test('atomically cuts over rotation so the stolen old credential fails', async () => {
    const fixture = createFakeStore();
    const service = createDeviceEnrollmentService({
      authorizer: createAuthorizer(),
      clock: () => now,
      keyRing,
      store: fixture.store,
    });
    const created = await service.requestEnrollmentGrant({ context, label: 'Desktop', principal });
    if (created.kind !== 'success') {
      throw new Error('Expected enrollment grant creation to succeed.');
    }
    const exchanged = await service.exchangeEnrollmentGrant(created.value.token);
    if (exchanged.kind !== 'success') {
      throw new Error('Expected enrollment exchange to succeed.');
    }
    await expect(service.authenticateDevice(exchanged.value.token)).resolves.toMatchObject({ kind: 'success' });

    const rotated = await service.rotateDeviceCredential({
      context,
      deviceId: exchanged.value.device.id,
      principal,
    });
    if (rotated.kind !== 'success') {
      throw new Error('Expected Device credential rotation to succeed.');
    }

    await expect(service.authenticateDevice(exchanged.value.token)).resolves.toEqual({
      error: { code: 'identity-revoked', operation: 'authenticate-device' },
      kind: 'error',
    });
    await expect(service.authenticateDevice(rotated.value.token)).resolves.toMatchObject({ kind: 'success' });
  });

  test('fails closed before persistence when enrollment authorization is denied', async () => {
    const fixture = createFakeStore();
    const service = createDeviceEnrollmentService({
      authorizer: createAuthorizer(false),
      clock: () => now,
      keyRing,
      store: fixture.store,
    });

    await expect(service.requestEnrollmentGrant({ context, label: 'Denied', principal })).resolves.toEqual({
      error: { code: 'identity-denied', operation: 'create-enrollment-grant' },
      kind: 'error',
    });
    expect(fixture.grants.size).toBe(0);
  });
});
