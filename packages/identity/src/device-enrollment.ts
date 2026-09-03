import type {
  AuthorizationPrincipal,
  AuthorizationRequestContext,
  AuthorizedResourceScope,
  AuthorizedResourceScopeResult,
  Authorizer,
} from '@ai-usage/authorization';
import {
  createDeviceCredentialId,
  createDeviceEnrollmentGrantId,
  createDeviceId,
  type Device,
  type DeviceCredentialId,
  type DeviceId,
  type Instant,
  instantNow,
  parseIdentityText,
  type SpaceId,
} from '@ai-usage/platform-core/identity';
import {
  createDeviceCredentialToken,
  createEnrollmentGrantToken,
  type DeploymentTokenKeyRing,
  type DeviceCredentialToken,
  type DeviceTokenVerifier,
  type EnrollmentGrantToken,
  verifyDeviceCredentialToken,
  verifyEnrollmentGrantToken,
} from './device-tokens';
import {
  DEVICE_ENROLLMENT_GRANT_LIFETIME_SECONDS,
  type DeviceCredentialMetadata,
  type DeviceEnrollmentGrantMetadata,
  type IdentityOperation,
  type IdentityServiceErrorCode,
  type IdentityServiceResult,
} from './index';

const maximumDeviceLabelLength = 256;
const maximumPageSize = 100;

export interface StoredDeviceEnrollmentGrant extends DeviceEnrollmentGrantMetadata {
  readonly verifier: DeviceTokenVerifier;
}

export interface StoredDeviceCredential extends DeviceCredentialMetadata {
  readonly device: Device;
  readonly verifier: DeviceTokenVerifier;
}

export interface DeviceListItem {
  readonly credentialCreatedAt: Instant | null;
  readonly credentialLastUsedAt: Instant | null;
  readonly device: Device;
}

export interface AuthorizedDeviceListQuery {
  readonly cursor?: string | null;
  readonly pageSize: number;
  readonly scope: AuthorizedResourceScope;
}

export interface AuthorizedDevicePage {
  readonly items: readonly DeviceListItem[];
  readonly kind: 'page';
  readonly nextCursor: string | null;
}

export type DeviceStoreFailureCode = 'conflict' | 'denied' | 'expired' | 'invalid' | 'revoked' | 'unavailable';

export type DeviceStoreResult<Value> =
  | { readonly kind: 'success'; readonly value: Value }
  | { readonly code: DeviceStoreFailureCode; readonly kind: 'error' };

export interface CreateEnrollmentGrantRecord {
  readonly authorization: {
    readonly context: AuthorizationRequestContext;
    readonly principal: Extract<AuthorizationPrincipal, { readonly kind: 'person' }>;
  };
  readonly metadata: DeviceEnrollmentGrantMetadata;
  readonly verifier: DeviceTokenVerifier;
}

export interface ExchangeEnrollmentGrantRecord {
  readonly authorization: {
    readonly context: AuthorizationRequestContext;
    readonly principal: Extract<AuthorizationPrincipal, { readonly kind: 'person' }>;
  };
  readonly credential: DeviceCredentialMetadata & { readonly verifier: DeviceTokenVerifier };
  readonly device: Device;
  readonly exchangedAt: Instant;
  readonly expectedGrant: StoredDeviceEnrollmentGrant;
}

export interface ConfirmDeviceCredentialUseRecord {
  readonly credentialId: DeviceCredentialId;
  readonly expectedVerifier: DeviceTokenVerifier;
  readonly usedAt: Instant;
}

export interface RotateDeviceCredentialRecord {
  readonly authorization: {
    readonly context: AuthorizationRequestContext;
    readonly principal: Extract<AuthorizationPrincipal, { readonly kind: 'person' }>;
  };
  readonly credential: DeviceCredentialMetadata & { readonly verifier: DeviceTokenVerifier };
  readonly deviceId: DeviceId;
  readonly rotatedAt: Instant;
  readonly spaceId: SpaceId;
}

export interface DeviceEnrollmentStore {
  readonly confirmDeviceCredentialUse: (
    input: ConfirmDeviceCredentialUseRecord,
  ) => Promise<DeviceStoreResult<StoredDeviceCredential>>;
  readonly createEnrollmentGrant: (input: CreateEnrollmentGrantRecord) => Promise<DeviceStoreResult<undefined>>;
  readonly exchangeEnrollmentGrant: (
    input: ExchangeEnrollmentGrantRecord,
  ) => Promise<DeviceStoreResult<StoredDeviceCredential>>;
  readonly findDeviceCredential: (publicTokenId: string) => Promise<StoredDeviceCredential | null>;
  readonly findEnrollmentGrant: (publicTokenId: string) => Promise<StoredDeviceEnrollmentGrant | null>;
  readonly listAuthorizedDevices: (
    query: AuthorizedDeviceListQuery,
  ) => Promise<DeviceStoreResult<AuthorizedDevicePage>>;
  readonly renameDevice: (input: {
    readonly authorization: {
      readonly context: AuthorizationRequestContext;
      readonly principal: Extract<AuthorizationPrincipal, { readonly kind: 'person' }>;
    };
    readonly deviceId: DeviceId;
    readonly label: string;
    readonly spaceId: SpaceId;
  }) => Promise<DeviceStoreResult<Device>>;
  readonly revokeAllAuthorizedDevices: (input: {
    readonly revokedAt: Instant;
    readonly scope: AuthorizedResourceScope;
  }) => Promise<DeviceStoreResult<number>>;
  readonly revokeDevice: (input: {
    readonly authorization: {
      readonly context: AuthorizationRequestContext;
      readonly principal: Extract<AuthorizationPrincipal, { readonly kind: 'person' }>;
    };
    readonly deviceId: DeviceId;
    readonly revokedAt: Instant;
    readonly spaceId: SpaceId;
  }) => Promise<DeviceStoreResult<Device>>;
  readonly rotateDeviceCredential: (
    input: RotateDeviceCredentialRecord,
  ) => Promise<DeviceStoreResult<StoredDeviceCredential>>;
}

export interface RequestEnrollmentGrantInput {
  readonly context: AuthorizationRequestContext;
  readonly label: string;
  readonly principal: AuthorizationPrincipal;
}

export interface EnrollmentGrantReceipt {
  readonly grant: DeviceEnrollmentGrantMetadata;
  readonly token: EnrollmentGrantToken;
}

export interface ExchangeEnrollmentGrantReceipt {
  readonly credential: DeviceCredentialMetadata;
  readonly device: Device;
  readonly token: DeviceCredentialToken;
}

export interface DeviceCredentialResolution {
  readonly credential: DeviceCredentialMetadata;
  readonly device: Device;
}

export interface DeviceLifecycleInput {
  readonly context: AuthorizationRequestContext;
  readonly deviceId: DeviceId;
  readonly principal: AuthorizationPrincipal;
}

export interface ListDevicesInput {
  readonly context: AuthorizationRequestContext;
  readonly cursor?: string | null;
  readonly pageSize: number;
  readonly principal: AuthorizationPrincipal;
}

export interface RenameDeviceInput extends DeviceLifecycleInput {
  readonly label: string;
}

export interface RotateDeviceCredentialReceipt {
  readonly credential: DeviceCredentialMetadata;
  readonly device: Device;
  readonly token: DeviceCredentialToken;
}

export interface DeviceEnrollmentService {
  readonly authenticateDevice: (
    token: DeviceCredentialToken,
  ) => Promise<IdentityServiceResult<DeviceCredentialResolution>>;
  readonly exchangeEnrollmentGrant: (
    token: EnrollmentGrantToken,
  ) => Promise<IdentityServiceResult<ExchangeEnrollmentGrantReceipt>>;
  readonly listDevices: (input: ListDevicesInput) => Promise<IdentityServiceResult<AuthorizedDevicePage>>;
  readonly renameDevice: (input: RenameDeviceInput) => Promise<IdentityServiceResult<Device>>;
  readonly requestEnrollmentGrant: (
    input: RequestEnrollmentGrantInput,
  ) => Promise<IdentityServiceResult<EnrollmentGrantReceipt>>;
  readonly revokeAllDevices: (input: Omit<DeviceLifecycleInput, 'deviceId'>) => Promise<IdentityServiceResult<number>>;
  readonly revokeDevice: (input: DeviceLifecycleInput) => Promise<IdentityServiceResult<Device>>;
  readonly rotateDeviceCredential: (
    input: DeviceLifecycleInput,
  ) => Promise<IdentityServiceResult<RotateDeviceCredentialReceipt>>;
}

export interface DeviceEnrollmentServiceConfig {
  readonly authorizer: Authorizer;
  readonly clock?: () => Date;
  readonly keyRing: DeploymentTokenKeyRing;
  readonly store: DeviceEnrollmentStore;
}

const failure = <Value>(
  operation: IdentityOperation,
  code: IdentityServiceErrorCode,
): IdentityServiceResult<Value> => ({ error: { code, operation }, kind: 'error' });

const mapStoreFailure = <Value>(
  operation: IdentityOperation,
  result: Extract<DeviceStoreResult<unknown>, { readonly kind: 'error' }>,
): IdentityServiceResult<Value> => {
  switch (result.code) {
    case 'conflict':
      return failure(operation, 'identity-conflict');
    case 'denied':
      return failure(operation, 'identity-denied');
    case 'expired':
      return failure(operation, 'identity-expired');
    case 'invalid':
      return failure(operation, 'identity-invalid-input');
    case 'revoked':
      return failure(operation, 'identity-revoked');
    default:
      return failure(operation, 'identity-unavailable');
  }
};

const personPrincipal = (
  principal: AuthorizationPrincipal,
): Extract<AuthorizationPrincipal, { readonly kind: 'person' }> | null =>
  principal.kind === 'person' ? principal : null;

const authorize = async (
  authorizer: Authorizer,
  input: DeviceLifecycleInput | RequestEnrollmentGrantInput,
  permission: 'manage_device' | 'revoke_device',
  resource: { readonly id: string; readonly kind: 'device' | 'space'; readonly spaceId: SpaceId },
): Promise<'allow' | 'deny' | 'unavailable'> => {
  try {
    const decision = await authorizer.check({
      context: input.context,
      permission,
      principal: input.principal,
      resource,
    });
    if (decision.kind === 'allow') {
      return 'allow';
    }
    return decision.kind === 'error' ? 'unavailable' : 'deny';
  } catch {
    return 'unavailable';
  }
};

const addSeconds = (value: Date, seconds: number): Instant =>
  instantNow(() => new Date(value.getTime() + seconds * 1000));

const safeStoreCall = async <Value>(operation: () => Promise<Value>): Promise<Value | null> => {
  try {
    return await operation();
  } catch {
    return null;
  }
};

const credentialMetadata = (credential: StoredDeviceCredential): DeviceCredentialMetadata => ({
  createdAt: credential.createdAt,
  deviceId: credential.deviceId,
  id: credential.id,
  keyVersion: credential.keyVersion,
  lastUsedAt: credential.lastUsedAt,
  revokedAt: credential.revokedAt,
  rotatedAt: credential.rotatedAt,
});

export const createDeviceEnrollmentService = (config: DeviceEnrollmentServiceConfig): DeviceEnrollmentService => {
  const clock = config.clock ?? (() => new Date());

  const service: DeviceEnrollmentService = {
    authenticateDevice: async (token) => {
      const operation = 'authenticate-device' as const;
      const found = await safeStoreCall(() => config.store.findDeviceCredential(token.publicTokenId));
      if (!found) {
        return failure(operation, 'identity-invalid-input');
      }
      if (
        found.revokedAt !== null ||
        found.device.status === 'revoked' ||
        !verifyDeviceCredentialToken(token, found.verifier, config.keyRing)
      ) {
        return failure(operation, found.revokedAt === null ? 'identity-invalid-input' : 'identity-revoked');
      }
      const usedAt = instantNow(clock);
      const confirmed = await safeStoreCall(() =>
        config.store.confirmDeviceCredentialUse({
          credentialId: found.id,
          expectedVerifier: found.verifier,
          usedAt,
        }),
      );
      if (!confirmed) {
        return failure(operation, 'identity-unavailable');
      }
      if (confirmed.kind === 'error') {
        return mapStoreFailure(operation, confirmed);
      }
      return {
        kind: 'success',
        value: { credential: credentialMetadata(confirmed.value), device: confirmed.value.device },
      };
    },

    exchangeEnrollmentGrant: async (token) => {
      const operation = 'exchange-enrollment-grant' as const;
      const grant = await safeStoreCall(() => config.store.findEnrollmentGrant(token.publicTokenId));
      if (!grant) {
        return failure(operation, 'identity-invalid-input');
      }
      const now = clock();
      if (!verifyEnrollmentGrantToken(token, grant.verifier, config.keyRing)) {
        return failure(operation, 'identity-invalid-input');
      }
      if (grant.consumedAt !== null) {
        return failure(operation, 'identity-revoked');
      }
      if (Date.parse(grant.expiresAt) <= now.getTime()) {
        return failure(operation, 'identity-expired');
      }
      const principal = { kind: 'person' as const, personId: grant.personId };
      const context = { activeSpaceId: grant.spaceId, trustedDevice: false };
      const authorization = await authorize(
        config.authorizer,
        { context, label: grant.label, principal },
        'manage_device',
        { id: grant.spaceId, kind: 'space', spaceId: grant.spaceId },
      );
      if (authorization !== 'allow') {
        return failure(operation, authorization === 'deny' ? 'identity-denied' : 'identity-unavailable');
      }

      const exchangedAt = instantNow(() => now);
      const device: Device = {
        id: createDeviceId(),
        label: grant.label,
        lastSeenAt: null,
        ownerPersonId: grant.personId,
        owningSpaceId: grant.spaceId,
        status: 'active',
      };
      const generated = createDeviceCredentialToken(config.keyRing.current);
      const credential: DeviceCredentialMetadata & { readonly verifier: DeviceTokenVerifier } = {
        createdAt: exchangedAt,
        deviceId: device.id,
        id: createDeviceCredentialId(),
        keyVersion: generated.verifier.keyVersion,
        lastUsedAt: null,
        revokedAt: null,
        rotatedAt: null,
        verifier: generated.verifier,
      };
      const exchanged = await safeStoreCall(() =>
        config.store.exchangeEnrollmentGrant({
          authorization: { context, principal },
          credential,
          device,
          exchangedAt,
          expectedGrant: grant,
        }),
      );
      if (!exchanged) {
        return failure(operation, 'identity-unavailable');
      }
      if (exchanged.kind === 'error') {
        return mapStoreFailure(operation, exchanged);
      }
      return {
        kind: 'success',
        value: {
          credential: credentialMetadata(exchanged.value),
          device: exchanged.value.device,
          token: generated.token,
        },
      };
    },

    listDevices: async (input) => {
      const operation = 'list-devices' as const;
      if (!Number.isSafeInteger(input.pageSize) || input.pageSize <= 0 || input.pageSize > maximumPageSize) {
        return failure(operation, 'identity-invalid-input');
      }
      let scope: AuthorizedResourceScopeResult;
      try {
        scope = await config.authorizer.materializeResourceScope({
          context: input.context,
          permission: 'view_device',
          principal: input.principal,
          resourceKind: 'device',
        });
      } catch {
        return failure(operation, 'identity-unavailable');
      }
      if (scope.kind === 'error') {
        return failure(operation, 'identity-unavailable');
      }
      const listed = await safeStoreCall(() =>
        config.store.listAuthorizedDevices({
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          pageSize: input.pageSize,
          scope,
        }),
      );
      if (!listed) {
        return failure(operation, 'identity-unavailable');
      }
      return listed.kind === 'error' ? mapStoreFailure(operation, listed) : { kind: 'success', value: listed.value };
    },

    renameDevice: async (input) => {
      const operation = 'rename-device' as const;
      const principal = personPrincipal(input.principal);
      if (!principal) {
        return failure(operation, 'identity-denied');
      }
      let label: string;
      try {
        label = parseIdentityText(input.label, 'device.label', maximumDeviceLabelLength);
      } catch {
        return failure(operation, 'identity-invalid-input');
      }
      const authorization = await authorize(config.authorizer, input, 'manage_device', {
        id: input.deviceId,
        kind: 'device',
        spaceId: input.context.activeSpaceId,
      });
      if (authorization !== 'allow') {
        return failure(operation, authorization === 'deny' ? 'identity-denied' : 'identity-unavailable');
      }
      const renamed = await safeStoreCall(() =>
        config.store.renameDevice({
          authorization: { context: input.context, principal },
          deviceId: input.deviceId,
          label,
          spaceId: input.context.activeSpaceId,
        }),
      );
      if (!renamed) {
        return failure(operation, 'identity-unavailable');
      }
      return renamed.kind === 'error' ? mapStoreFailure(operation, renamed) : { kind: 'success', value: renamed.value };
    },

    requestEnrollmentGrant: async (input) => {
      const operation = 'create-enrollment-grant' as const;
      const principal = personPrincipal(input.principal);
      if (!principal) {
        return failure(operation, 'identity-denied');
      }
      let label: string;
      try {
        label = parseIdentityText(input.label, 'device.label', maximumDeviceLabelLength);
      } catch {
        return failure(operation, 'identity-invalid-input');
      }
      const authorization = await authorize(config.authorizer, input, 'manage_device', {
        id: input.context.activeSpaceId,
        kind: 'space',
        spaceId: input.context.activeSpaceId,
      });
      if (authorization !== 'allow') {
        return failure(operation, authorization === 'deny' ? 'identity-denied' : 'identity-unavailable');
      }
      const created = clock();
      const createdAt = instantNow(() => created);
      const generated = createEnrollmentGrantToken(config.keyRing.current);
      const grant: DeviceEnrollmentGrantMetadata = {
        consumedAt: null,
        createdAt,
        expiresAt: addSeconds(created, DEVICE_ENROLLMENT_GRANT_LIFETIME_SECONDS),
        id: createDeviceEnrollmentGrantId(),
        keyVersion: generated.verifier.keyVersion,
        label,
        personId: principal.personId,
        spaceId: input.context.activeSpaceId,
      };
      const stored = await safeStoreCall(() =>
        config.store.createEnrollmentGrant({
          authorization: { context: input.context, principal },
          metadata: grant,
          verifier: generated.verifier,
        }),
      );
      if (!stored) {
        return failure(operation, 'identity-unavailable');
      }
      if (stored.kind === 'error') {
        return mapStoreFailure(operation, stored);
      }
      return { kind: 'success', value: { grant, token: generated.token } };
    },

    revokeAllDevices: async (input) => {
      const operation = 'revoke-all-devices' as const;
      let scope: AuthorizedResourceScopeResult;
      try {
        scope = await config.authorizer.materializeResourceScope({
          context: input.context,
          permission: 'revoke_device',
          principal: input.principal,
          resourceKind: 'device',
        });
      } catch {
        return failure(operation, 'identity-unavailable');
      }
      if (scope.kind === 'error') {
        return failure(operation, 'identity-unavailable');
      }
      const revoked = await safeStoreCall(() =>
        config.store.revokeAllAuthorizedDevices({ revokedAt: instantNow(clock), scope }),
      );
      if (!revoked) {
        return failure(operation, 'identity-unavailable');
      }
      return revoked.kind === 'error' ? mapStoreFailure(operation, revoked) : { kind: 'success', value: revoked.value };
    },

    revokeDevice: async (input) => {
      const operation = 'revoke-device' as const;
      const principal = personPrincipal(input.principal);
      if (!principal) {
        return failure(operation, 'identity-denied');
      }
      const authorization = await authorize(config.authorizer, input, 'revoke_device', {
        id: input.deviceId,
        kind: 'device',
        spaceId: input.context.activeSpaceId,
      });
      if (authorization !== 'allow') {
        return failure(operation, authorization === 'deny' ? 'identity-denied' : 'identity-unavailable');
      }
      const revoked = await safeStoreCall(() =>
        config.store.revokeDevice({
          authorization: { context: input.context, principal },
          deviceId: input.deviceId,
          revokedAt: instantNow(clock),
          spaceId: input.context.activeSpaceId,
        }),
      );
      if (!revoked) {
        return failure(operation, 'identity-unavailable');
      }
      return revoked.kind === 'error' ? mapStoreFailure(operation, revoked) : { kind: 'success', value: revoked.value };
    },

    rotateDeviceCredential: async (input) => {
      const operation = 'rotate-device-credential' as const;
      const principal = personPrincipal(input.principal);
      if (!principal) {
        return failure(operation, 'identity-denied');
      }
      const authorization = await authorize(config.authorizer, input, 'manage_device', {
        id: input.deviceId,
        kind: 'device',
        spaceId: input.context.activeSpaceId,
      });
      if (authorization !== 'allow') {
        return failure(operation, authorization === 'deny' ? 'identity-denied' : 'identity-unavailable');
      }
      const rotatedAt = instantNow(clock);
      const generated = createDeviceCredentialToken(config.keyRing.current);
      const credential: DeviceCredentialMetadata & { readonly verifier: DeviceTokenVerifier } = {
        createdAt: rotatedAt,
        deviceId: input.deviceId,
        id: createDeviceCredentialId(),
        keyVersion: generated.verifier.keyVersion,
        lastUsedAt: null,
        revokedAt: null,
        rotatedAt: null,
        verifier: generated.verifier,
      };
      const rotated = await safeStoreCall(() =>
        config.store.rotateDeviceCredential({
          authorization: { context: input.context, principal },
          credential,
          deviceId: input.deviceId,
          rotatedAt,
          spaceId: input.context.activeSpaceId,
        }),
      );
      if (!rotated) {
        return failure(operation, 'identity-unavailable');
      }
      if (rotated.kind === 'error') {
        return mapStoreFailure(operation, rotated);
      }
      return {
        kind: 'success',
        value: {
          credential: credentialMetadata(rotated.value),
          device: rotated.value.device,
          token: generated.token,
        },
      };
    },
  };

  return Object.freeze(service);
};
