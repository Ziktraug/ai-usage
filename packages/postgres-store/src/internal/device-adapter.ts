import { AUTHORIZATION_MODEL_VERSION } from '@ai-usage/authorization';
import { readAuthorizedResourceScopeAdapterBinding } from '@ai-usage/authorization/scope-internal';
import type {
  AuthorizedDeviceListQuery,
  ConfirmDeviceCredentialUseRecord,
  CreateEnrollmentGrantRecord,
  DeviceStoreResult,
  ExchangeEnrollmentGrantRecord,
  RotateDeviceCredentialRecord,
  StoredDeviceCredential,
  StoredDeviceEnrollmentGrant,
} from '@ai-usage/identity/device-enrollment';
import type { DeviceTokenVerifier } from '@ai-usage/identity/device-tokens';
import {
  type Device,
  parseDeviceCredentialId,
  parseDeviceEnrollmentGrantId,
  parseDeviceId,
  parseIdentityText,
  parseInstant,
  parsePersonId,
  parseSpaceId,
  type SpaceId,
} from '@ai-usage/platform-core/identity';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { PlatformDeviceStore } from '../devices';
import { PlatformStoreError } from '../errors';
import { authorizationScopeSql } from './authorization-query';
import { isPostgreSqlAuthorizationScopeBinding } from './authorization-scope-binding';
import { withPlatformSpaceTransaction } from './space-transaction';

const maximumPageSize = 100;
const publicTokenIdPattern = /^[A-Za-z0-9_-]{22}$/u;
const digestPattern = /^[A-Za-z0-9_-]{43}$/u;

interface GrantRow extends QueryResultRow {
  readonly consumed_at: unknown;
  readonly created_at: unknown;
  readonly expires_at: unknown;
  readonly id: unknown;
  readonly key_version: unknown;
  readonly keyed_digest: unknown;
  readonly label: unknown;
  readonly person_id: unknown;
  readonly public_token_id: unknown;
  readonly space_id: unknown;
}

interface CredentialRow extends QueryResultRow {
  readonly created_at: unknown;
  readonly device_id: unknown;
  readonly device_label: unknown;
  readonly device_last_seen_at: unknown;
  readonly device_owner_person_id: unknown;
  readonly device_space_id: unknown;
  readonly device_status: unknown;
  readonly id: unknown;
  readonly key_version: unknown;
  readonly keyed_digest: unknown;
  readonly last_used_at: unknown;
  readonly public_token_id: unknown;
  readonly revoked_at: unknown;
  readonly rotated_at: unknown;
}

interface DeviceListRow extends QueryResultRow {
  readonly credential_created_at: unknown;
  readonly credential_last_used_at: unknown;
  readonly id: unknown;
  readonly label: unknown;
  readonly last_seen_at: unknown;
  readonly owner_person_id: unknown;
  readonly space_id: unknown;
  readonly status: unknown;
}

interface DeviceRow extends QueryResultRow {
  readonly id: unknown;
  readonly label: unknown;
  readonly last_seen_at: unknown;
  readonly owner_person_id: unknown;
  readonly space_id: unknown;
  readonly status: unknown;
}

interface IdRow extends QueryResultRow {
  readonly id: unknown;
}

interface DeviceCursorPayload {
  readonly activeSpaceId: SpaceId;
  readonly afterDeviceId: string;
  readonly modelVersion: typeof AUTHORIZATION_MODEL_VERSION;
  readonly version: 1;
}

const storeError = <Value>(code: Extract<DeviceStoreResult<Value>, { readonly kind: 'error' }>['code']) =>
  ({ code, kind: 'error' }) as const;

const dateInstant = (value: unknown, field: string) => {
  if (!(value instanceof Date)) {
    throw new PlatformStoreError('validation-failed', `map-${field}`);
  }
  return parseInstant(value.toISOString(), field);
};

const optionalInstant = (value: unknown, field: string) => (value === null ? null : dateInstant(value, field));

const mapVerifier = (row: {
  readonly key_version: unknown;
  readonly keyed_digest: unknown;
  readonly public_token_id: unknown;
}): DeviceTokenVerifier => {
  if (
    typeof row.key_version !== 'number' ||
    !Number.isSafeInteger(row.key_version) ||
    row.key_version <= 0 ||
    typeof row.keyed_digest !== 'string' ||
    !digestPattern.test(row.keyed_digest) ||
    typeof row.public_token_id !== 'string' ||
    !publicTokenIdPattern.test(row.public_token_id)
  ) {
    throw new PlatformStoreError('validation-failed', 'map-device-token-verifier');
  }
  return {
    keyVersion: row.key_version,
    keyedDigest: row.keyed_digest,
    publicTokenId: row.public_token_id,
  };
};

const mapDevice = (row: {
  readonly id: unknown;
  readonly label: unknown;
  readonly last_seen_at: unknown;
  readonly owner_person_id: unknown;
  readonly space_id: unknown;
  readonly status: unknown;
}): Device => {
  if (row.status !== 'local' && row.status !== 'pending' && row.status !== 'active' && row.status !== 'revoked') {
    throw new PlatformStoreError('validation-failed', 'map-device-status');
  }
  return {
    id: parseDeviceId(row.id),
    label: parseIdentityText(row.label, 'device.label'),
    lastSeenAt: optionalInstant(row.last_seen_at, 'device.lastSeenAt'),
    ownerPersonId: parsePersonId(row.owner_person_id),
    owningSpaceId: parseSpaceId(row.space_id),
    status: row.status,
  };
};

const mapCredential = (row: CredentialRow): StoredDeviceCredential => ({
  createdAt: dateInstant(row.created_at, 'deviceCredential.createdAt'),
  device: mapDevice({
    id: row.device_id,
    label: row.device_label,
    last_seen_at: row.device_last_seen_at,
    owner_person_id: row.device_owner_person_id,
    space_id: row.device_space_id,
    status: row.device_status,
  }),
  deviceId: parseDeviceId(row.device_id),
  id: parseDeviceCredentialId(row.id),
  keyVersion: mapVerifier(row).keyVersion,
  lastUsedAt: optionalInstant(row.last_used_at, 'deviceCredential.lastUsedAt'),
  revokedAt: optionalInstant(row.revoked_at, 'deviceCredential.revokedAt'),
  rotatedAt: optionalInstant(row.rotated_at, 'deviceCredential.rotatedAt'),
  verifier: mapVerifier(row),
});

const mapGrant = (row: GrantRow): StoredDeviceEnrollmentGrant => ({
  consumedAt: optionalInstant(row.consumed_at, 'deviceEnrollmentGrant.consumedAt'),
  createdAt: dateInstant(row.created_at, 'deviceEnrollmentGrant.createdAt'),
  expiresAt: dateInstant(row.expires_at, 'deviceEnrollmentGrant.expiresAt'),
  id: parseDeviceEnrollmentGrantId(row.id),
  keyVersion: mapVerifier(row).keyVersion,
  label: parseIdentityText(row.label, 'deviceEnrollmentGrant.label'),
  personId: parsePersonId(row.person_id),
  spaceId: parseSpaceId(row.space_id),
  verifier: mapVerifier(row),
});

const credentialSelection = `
  SELECT credential.id, credential.device_id, credential.public_token_id,
         credential.keyed_digest, credential.key_version, credential.created_at,
         credential.last_used_at, credential.rotated_at, credential.revoked_at,
         device.owner_person_id AS device_owner_person_id,
         device.space_id AS device_space_id,
         device.label AS device_label,
         device.status AS device_status,
         device.last_seen_at AS device_last_seen_at
  FROM device_credentials credential
  INNER JOIN devices device
    ON device.id = credential.device_id AND device.space_id = credential.space_id
`;

const authorizedInTransaction = async (
  client: PoolClient,
  input: {
    readonly authorization: ExchangeEnrollmentGrantRecord['authorization'];
    readonly resourceId: string;
    readonly resourceKind: 'device' | 'space';
    readonly permission: 'manage_device' | 'revoke_device';
  },
): Promise<boolean> => {
  if (input.authorization.context.activeSpaceId.length === 0) {
    return false;
  }
  const query = authorizationScopeSql(input.permission, input.resourceKind);
  if (!query) {
    return false;
  }
  const result = await client.query<IdRow>(`SELECT id FROM (${query}) scope WHERE id = $4::UUID LIMIT 1`, [
    input.authorization.context.activeSpaceId,
    input.authorization.principal.personId,
    input.authorization.context.trustedDevice,
    input.resourceId,
  ]);
  return result.rows.length === 1;
};

const writeIdentityEvent = async (
  client: PoolClient,
  input: {
    readonly eventType: string;
    readonly recordedAt: string;
    readonly spaceId: SpaceId;
    readonly subjectId: string;
    readonly subjectType: 'device' | 'device-enrollment-grant';
  },
): Promise<void> => {
  await client.query(
    `INSERT INTO identity_events
       (id, space_id, event_type, subject_type, subject_id, recorded_at, details)
     VALUES ($1, $2, $3, $4, $5, $6, '{}'::JSONB)`,
    [crypto.randomUUID(), input.spaceId, input.eventType, input.subjectType, input.subjectId, input.recordedAt],
  );
};

const encodeCursor = (payload: DeviceCursorPayload): string => btoa(JSON.stringify(payload));

const decodeCursor = (value: string | null | undefined): DeviceCursorPayload | null => {
  if (value === undefined || value === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(atob(value));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const cursor = parsed as Partial<DeviceCursorPayload>;
    if (
      cursor.version !== 1 ||
      cursor.modelVersion !== AUTHORIZATION_MODEL_VERSION ||
      typeof cursor.activeSpaceId !== 'string' ||
      typeof cursor.afterDeviceId !== 'string'
    ) {
      return null;
    }
    parseSpaceId(cursor.activeSpaceId);
    parseDeviceId(cursor.afterDeviceId);
    return cursor as DeviceCursorPayload;
  } catch {
    return null;
  }
};

const mutationFailure = async (
  pool: Pool,
  deviceId: string,
): Promise<Extract<DeviceStoreResult<never>, { readonly kind: 'error' }>> => {
  try {
    const result = await pool.query<{ readonly status: unknown }>('SELECT status FROM devices WHERE id = $1', [
      deviceId,
    ]);
    return result.rows[0]?.status === 'revoked' ? storeError('revoked') : storeError('invalid');
  } catch {
    return storeError('unavailable');
  }
};

export const createPlatformDeviceStore = (pool: Pool): PlatformDeviceStore => ({
  confirmDeviceCredentialUse: async (
    input: ConfirmDeviceCredentialUseRecord,
  ): Promise<DeviceStoreResult<StoredDeviceCredential>> => {
    try {
      const result = await pool.query<CredentialRow>(
        `WITH updated AS (
           UPDATE device_credentials credential
           SET last_used_at = $5
           FROM devices device
           WHERE credential.id = $1
             AND credential.public_token_id = $2
             AND credential.keyed_digest = $3
             AND credential.key_version = $4
             AND credential.revoked_at IS NULL
             AND device.id = credential.device_id
             AND device.space_id = credential.space_id
             AND device.status = 'active'
           RETURNING credential.id
         )
         ${credentialSelection}
         INNER JOIN updated ON updated.id = credential.id`,
        [
          input.credentialId,
          input.expectedVerifier.publicTokenId,
          input.expectedVerifier.keyedDigest,
          input.expectedVerifier.keyVersion,
          input.usedAt,
        ],
      );
      const row = result.rows[0];
      return row ? { kind: 'success', value: mapCredential(row) } : storeError('revoked');
    } catch {
      return storeError('unavailable');
    }
  },

  createEnrollmentGrant: async (input: CreateEnrollmentGrantRecord): Promise<DeviceStoreResult<undefined>> => {
    try {
      return await withPlatformSpaceTransaction(
        pool,
        input.metadata.spaceId,
        'create-device-enrollment-grant',
        async (client) => {
          if (
            !(await authorizedInTransaction(client, {
              authorization: input.authorization,
              permission: 'manage_device',
              resourceId: input.metadata.spaceId,
              resourceKind: 'space',
            }))
          ) {
            return storeError('denied');
          }
          await client.query(
            `INSERT INTO device_enrollment_grants
               (id, person_id, space_id, label, public_token_id, keyed_digest,
                key_version, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              input.metadata.id,
              input.metadata.personId,
              input.metadata.spaceId,
              input.metadata.label,
              input.verifier.publicTokenId,
              input.verifier.keyedDigest,
              input.verifier.keyVersion,
              input.metadata.createdAt,
              input.metadata.expiresAt,
            ],
          );
          await writeIdentityEvent(client, {
            eventType: 'device-enrollment-grant-created',
            recordedAt: input.metadata.createdAt,
            spaceId: input.metadata.spaceId,
            subjectId: input.metadata.id,
            subjectType: 'device-enrollment-grant',
          });
          return { kind: 'success', value: undefined };
        },
      );
    } catch {
      return storeError('unavailable');
    }
  },

  exchangeEnrollmentGrant: async (
    input: ExchangeEnrollmentGrantRecord,
  ): Promise<DeviceStoreResult<StoredDeviceCredential>> => {
    try {
      return await withPlatformSpaceTransaction(
        pool,
        input.expectedGrant.spaceId,
        'exchange-device-enrollment-grant',
        async (client) => {
          if (
            !(await authorizedInTransaction(client, {
              authorization: input.authorization,
              permission: 'manage_device',
              resourceId: input.expectedGrant.spaceId,
              resourceKind: 'space',
            }))
          ) {
            return storeError('denied');
          }
          const locked = await client.query<{ readonly consumed_at: unknown; readonly expires_at: unknown }>(
            `SELECT consumed_at, expires_at
             FROM device_enrollment_grants
             WHERE id = $1
               AND person_id = $2
               AND space_id = $3
               AND public_token_id = $4
               AND keyed_digest = $5
               AND key_version = $6
             FOR UPDATE`,
            [
              input.expectedGrant.id,
              input.expectedGrant.personId,
              input.expectedGrant.spaceId,
              input.expectedGrant.verifier.publicTokenId,
              input.expectedGrant.verifier.keyedDigest,
              input.expectedGrant.verifier.keyVersion,
            ],
          );
          const lockedGrant = locked.rows[0];
          if (!lockedGrant) {
            return storeError('invalid');
          }
          if (lockedGrant.consumed_at instanceof Date) {
            return storeError('revoked');
          }
          if (
            !(lockedGrant.expires_at instanceof Date) ||
            lockedGrant.expires_at.getTime() <= Date.parse(input.exchangedAt)
          ) {
            return storeError('expired');
          }
          await client.query(
            `INSERT INTO devices (id, owner_person_id, space_id, label, status, last_seen_at)
             VALUES ($1, $2, $3, $4, 'active', NULL)`,
            [input.device.id, input.device.ownerPersonId, input.device.owningSpaceId, input.device.label],
          );
          const consumed = await client.query<IdRow>(
            `UPDATE device_enrollment_grants
             SET consumed_at = $2, consumed_device_id = $3
             WHERE id = $1 AND consumed_at IS NULL
             RETURNING id`,
            [input.expectedGrant.id, input.exchangedAt, input.device.id],
          );
          if (consumed.rows.length !== 1) {
            throw new PlatformStoreError('validation-failed', 'consume-device-enrollment-grant');
          }
          await client.query(
            `INSERT INTO device_credentials
               (id, device_id, space_id, public_token_id, keyed_digest, key_version, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              input.credential.id,
              input.device.id,
              input.device.owningSpaceId,
              input.credential.verifier.publicTokenId,
              input.credential.verifier.keyedDigest,
              input.credential.verifier.keyVersion,
              input.credential.createdAt,
            ],
          );
          await writeIdentityEvent(client, {
            eventType: 'device-enrollment-grant-exchanged',
            recordedAt: input.exchangedAt,
            spaceId: input.device.owningSpaceId,
            subjectId: input.device.id,
            subjectType: 'device',
          });
          return {
            kind: 'success',
            value: { ...input.credential, device: input.device },
          };
        },
      );
    } catch {
      return storeError('unavailable');
    }
  },

  findDeviceCredential: async (publicTokenId): Promise<StoredDeviceCredential | null> => {
    if (!publicTokenIdPattern.test(publicTokenId)) {
      return null;
    }
    const result = await pool.query<CredentialRow>(`${credentialSelection} WHERE credential.public_token_id = $1`, [
      publicTokenId,
    ]);
    const row = result.rows[0];
    return row ? mapCredential(row) : null;
  },

  findEnrollmentGrant: async (publicTokenId): Promise<StoredDeviceEnrollmentGrant | null> => {
    if (!publicTokenIdPattern.test(publicTokenId)) {
      return null;
    }
    const result = await pool.query<GrantRow>(
      `SELECT id, person_id, space_id, label, public_token_id, keyed_digest,
              key_version, created_at, expires_at, consumed_at
       FROM device_enrollment_grants
       WHERE public_token_id = $1`,
      [publicTokenId],
    );
    const row = result.rows[0];
    return row ? mapGrant(row) : null;
  },

  listAuthorizedDevices: async (query: AuthorizedDeviceListQuery) => {
    if (
      !Number.isSafeInteger(query.pageSize) ||
      query.pageSize <= 0 ||
      query.pageSize > maximumPageSize ||
      query.scope.permission !== 'view_device' ||
      query.scope.resourceKind !== 'device' ||
      query.scope.modelVersion !== AUTHORIZATION_MODEL_VERSION
    ) {
      return storeError('invalid');
    }
    const cursor = decodeCursor(query.cursor);
    if (
      query.cursor !== undefined &&
      query.cursor !== null &&
      (!cursor || cursor.activeSpaceId !== query.scope.activeSpaceId)
    ) {
      return storeError('invalid');
    }
    let binding: unknown;
    try {
      binding = readAuthorizedResourceScopeAdapterBinding(query.scope);
    } catch {
      return storeError('invalid');
    }
    if (!isPostgreSqlAuthorizationScopeBinding(binding)) {
      return storeError('invalid');
    }
    if (binding.personId === null) {
      return { kind: 'success', value: { items: [], kind: 'page', nextCursor: null } };
    }
    const authorizationQuery = authorizationScopeSql('view_device', 'device');
    if (!authorizationQuery) {
      return storeError('unavailable');
    }
    try {
      const rows = await withPlatformSpaceTransaction(
        pool,
        query.scope.activeSpaceId,
        'list-authorized-devices',
        async (client) => {
          const result = await client.query<DeviceListRow>(
            `WITH authorized_devices(id) AS (${authorizationQuery})
             SELECT device.id, device.owner_person_id, device.space_id, device.label,
                    device.status, device.last_seen_at,
                    current_credential.created_at AS credential_created_at,
                    current_credential.last_used_at AS credential_last_used_at
             FROM devices device
             INNER JOIN authorized_devices authorized ON authorized.id = device.id
             LEFT JOIN LATERAL (
               SELECT credential.created_at, credential.last_used_at
               FROM device_credentials credential
               WHERE credential.device_id = device.id
                 AND credential.space_id = device.space_id
                 AND credential.revoked_at IS NULL
               ORDER BY credential.created_at DESC
               LIMIT 1
             ) current_credential ON TRUE
             WHERE device.space_id = $1
               AND ($4::UUID IS NULL OR device.id > $4::UUID)
             ORDER BY device.id ASC
             LIMIT $5`,
            [
              query.scope.activeSpaceId,
              binding.personId,
              binding.trustedDevice,
              cursor?.afterDeviceId ?? null,
              query.pageSize + 1,
            ],
          );
          return result.rows;
        },
      );
      const hasNext = rows.length > query.pageSize;
      const pageRows = hasNext ? rows.slice(0, query.pageSize) : rows;
      const items = pageRows.map((row) => ({
        credentialCreatedAt: optionalInstant(row.credential_created_at, 'device.credentialCreatedAt'),
        credentialLastUsedAt: optionalInstant(row.credential_last_used_at, 'device.credentialLastUsedAt'),
        device: mapDevice(row),
      }));
      const lastDeviceId = items.at(-1)?.device.id;
      return {
        kind: 'success',
        value: {
          items,
          kind: 'page',
          nextCursor:
            hasNext && lastDeviceId
              ? encodeCursor({
                  activeSpaceId: query.scope.activeSpaceId,
                  afterDeviceId: lastDeviceId,
                  modelVersion: AUTHORIZATION_MODEL_VERSION,
                  version: 1,
                })
              : null,
        },
      };
    } catch {
      return storeError('unavailable');
    }
  },

  renameDevice: async (input) => {
    try {
      return await withPlatformSpaceTransaction(pool, input.spaceId, 'rename-device', async (client) => {
        if (
          !(await authorizedInTransaction(client, {
            authorization: input.authorization,
            permission: 'manage_device',
            resourceId: input.deviceId,
            resourceKind: 'device',
          }))
        ) {
          return storeError('denied');
        }
        const result = await client.query<DeviceRow>(
          `UPDATE devices
           SET label = $3
           WHERE id = $1 AND space_id = $2 AND status <> 'revoked'
           RETURNING id, owner_person_id, space_id, label, status, last_seen_at`,
          [input.deviceId, input.spaceId, input.label],
        );
        const row = result.rows[0];
        if (!row) {
          return storeError('revoked');
        }
        return { kind: 'success', value: mapDevice(row) };
      });
    } catch {
      return storeError('unavailable');
    }
  },

  revokeAllAuthorizedDevices: async ({ revokedAt, scope }) => {
    if (
      scope.permission !== 'revoke_device' ||
      scope.resourceKind !== 'device' ||
      scope.modelVersion !== AUTHORIZATION_MODEL_VERSION
    ) {
      return storeError('invalid');
    }
    let binding: unknown;
    try {
      binding = readAuthorizedResourceScopeAdapterBinding(scope);
    } catch {
      return storeError('invalid');
    }
    if (!isPostgreSqlAuthorizationScopeBinding(binding) || binding.personId === null) {
      return isPostgreSqlAuthorizationScopeBinding(binding) ? { kind: 'success', value: 0 } : storeError('invalid');
    }
    const authorizationQuery = authorizationScopeSql('revoke_device', 'device');
    if (!authorizationQuery) {
      return storeError('unavailable');
    }
    try {
      return await withPlatformSpaceTransaction(pool, scope.activeSpaceId, 'revoke-all-devices', async (client) => {
        const revoked = await client.query<IdRow>(
          `WITH authorized_devices(id) AS (${authorizationQuery})
           UPDATE devices device
           SET status = 'revoked'
           FROM authorized_devices authorized
           WHERE device.id = authorized.id
             AND device.space_id = $1
             AND device.status <> 'revoked'
           RETURNING device.id`,
          [scope.activeSpaceId, binding.personId, binding.trustedDevice],
        );
        const ids = revoked.rows.map((row) => parseDeviceId(row.id));
        if (ids.length > 0) {
          await client.query(
            `UPDATE device_credentials
             SET revoked_at = $2
             WHERE space_id = $1 AND device_id = ANY($3::UUID[]) AND revoked_at IS NULL`,
            [scope.activeSpaceId, revokedAt, ids],
          );
          for (const id of ids) {
            await writeIdentityEvent(client, {
              eventType: 'device-revoked',
              recordedAt: revokedAt,
              spaceId: scope.activeSpaceId,
              subjectId: id,
              subjectType: 'device',
            });
          }
        }
        return { kind: 'success', value: ids.length };
      });
    } catch {
      return storeError('unavailable');
    }
  },

  revokeDevice: async (input) => {
    try {
      return await withPlatformSpaceTransaction(pool, input.spaceId, 'revoke-device', async (client) => {
        if (
          !(await authorizedInTransaction(client, {
            authorization: input.authorization,
            permission: 'revoke_device',
            resourceId: input.deviceId,
            resourceKind: 'device',
          }))
        ) {
          return storeError('denied');
        }
        const result = await client.query<DeviceRow>(
          `UPDATE devices
           SET status = 'revoked'
           WHERE id = $1 AND space_id = $2 AND status <> 'revoked'
           RETURNING id, owner_person_id, space_id, label, status, last_seen_at`,
          [input.deviceId, input.spaceId],
        );
        const row = result.rows[0];
        if (!row) {
          return storeError('revoked');
        }
        await client.query(
          `UPDATE device_credentials
           SET revoked_at = $3
           WHERE device_id = $1 AND space_id = $2 AND revoked_at IS NULL`,
          [input.deviceId, input.spaceId, input.revokedAt],
        );
        await writeIdentityEvent(client, {
          eventType: 'device-revoked',
          recordedAt: input.revokedAt,
          spaceId: input.spaceId,
          subjectId: input.deviceId,
          subjectType: 'device',
        });
        return { kind: 'success', value: mapDevice(row) };
      });
    } catch {
      return mutationFailure(pool, input.deviceId);
    }
  },

  rotateDeviceCredential: async (input: RotateDeviceCredentialRecord) => {
    try {
      return await withPlatformSpaceTransaction(pool, input.spaceId, 'rotate-device-credential', async (client) => {
        if (
          !(await authorizedInTransaction(client, {
            authorization: input.authorization,
            permission: 'manage_device',
            resourceId: input.deviceId,
            resourceKind: 'device',
          }))
        ) {
          return storeError('denied');
        }
        const deviceResult = await client.query<DeviceRow>(
          `SELECT id, owner_person_id, space_id, label, status, last_seen_at
           FROM devices
           WHERE id = $1 AND space_id = $2 AND status = 'active'
           FOR UPDATE`,
          [input.deviceId, input.spaceId],
        );
        const deviceRow = deviceResult.rows[0];
        if (!deviceRow) {
          return storeError('revoked');
        }
        await client.query(
          `UPDATE device_credentials
           SET revoked_at = $3, rotated_at = $3
           WHERE device_id = $1 AND space_id = $2 AND revoked_at IS NULL`,
          [input.deviceId, input.spaceId, input.rotatedAt],
        );
        await client.query(
          `INSERT INTO device_credentials
             (id, device_id, space_id, public_token_id, keyed_digest, key_version, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            input.credential.id,
            input.deviceId,
            input.spaceId,
            input.credential.verifier.publicTokenId,
            input.credential.verifier.keyedDigest,
            input.credential.verifier.keyVersion,
            input.credential.createdAt,
          ],
        );
        await writeIdentityEvent(client, {
          eventType: 'device-credential-rotated',
          recordedAt: input.rotatedAt,
          spaceId: input.spaceId,
          subjectId: input.deviceId,
          subjectType: 'device',
        });
        return {
          kind: 'success',
          value: { ...input.credential, device: mapDevice(deviceRow) },
        };
      });
    } catch {
      return storeError('unavailable');
    }
  },
});
