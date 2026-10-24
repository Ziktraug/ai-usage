import type {
  DeviceCredentialId,
  DeviceEnrollmentGrantId,
  DeviceId,
  Instant,
  PersonId,
  SpaceId,
} from '@ai-usage/platform-core/identity';

export const DEVICE_ENROLLMENT_GRANT_LIFETIME_SECONDS = 15 * 60;

export interface DeviceCredentialMetadata {
  readonly createdAt: Instant;
  readonly deviceId: DeviceId;
  readonly id: DeviceCredentialId;
  readonly keyVersion: number;
  readonly lastUsedAt: Instant | null;
  readonly revokedAt: Instant | null;
  readonly rotatedAt: Instant | null;
}

export interface DeviceEnrollmentGrantMetadata {
  readonly consumedAt: Instant | null;
  readonly createdAt: Instant;
  readonly expiresAt: Instant;
  readonly id: DeviceEnrollmentGrantId;
  readonly keyVersion: number;
  readonly label: string;
  readonly personId: PersonId;
  readonly spaceId: SpaceId;
}

export type IdentityOperation =
  | 'authenticate-device'
  | 'create-enrollment-grant'
  | 'exchange-enrollment-grant'
  | 'list-devices'
  | 'rename-device'
  | 'revoke-all-devices'
  | 'revoke-device'
  | 'rotate-device-credential';

export type IdentityServiceErrorCode =
  | 'identity-conflict'
  | 'identity-denied'
  | 'identity-expired'
  | 'identity-invalid-input'
  | 'identity-revoked'
  | 'identity-unavailable';

export interface IdentityServiceError {
  readonly code: IdentityServiceErrorCode;
  readonly operation: IdentityOperation;
}

export type IdentityServiceResult<Value> =
  | { readonly kind: 'error'; readonly error: IdentityServiceError }
  | { readonly kind: 'success'; readonly value: Value };
