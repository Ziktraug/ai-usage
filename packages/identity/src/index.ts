import type { AuthorizationPrincipal } from '@ai-usage/authorization';
import type {
  AuthenticationIdentityId,
  DeviceCredentialId,
  DeviceEnrollmentGrantId,
  DeviceId,
  Instant,
  PersonId,
  SpaceId,
  WebSessionId,
} from '@ai-usage/platform-core/identity';

export const SHARED_AUTHENTICATION_PROVIDER = 'github' as const;
export const DEVICE_ENROLLMENT_GRANT_LIFETIME_SECONDS = 15 * 60;

export interface AuthenticationIdentity {
  readonly id: AuthenticationIdentityId;
  readonly linkedAt: Instant;
  readonly personId: PersonId;
  readonly provider: typeof SHARED_AUTHENTICATION_PROVIDER;
  readonly providerSubject: string;
  readonly revokedAt: Instant | null;
}

export interface SharedAuthenticationPrincipal {
  readonly authenticationIdentityId: AuthenticationIdentityId;
  readonly authorizationPrincipal: Extract<AuthorizationPrincipal, { readonly kind: 'person' }>;
  readonly personId: PersonId;
  readonly provider: typeof SHARED_AUTHENTICATION_PROVIDER;
}

export interface SharedWebSession {
  readonly absoluteExpiresAt: Instant;
  readonly createdAt: Instant;
  readonly freshUntil: Instant;
  readonly id: WebSessionId;
  readonly idleExpiresAt: Instant;
  readonly principal: SharedAuthenticationPrincipal;
}

export type SharedSessionResolution =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'authenticated'; readonly session: SharedWebSession }
  | { readonly kind: 'expired' | 'revoked' | 'unavailable' };

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
  | 'authenticate-session'
  | 'audit-authentication'
  | 'bootstrap-first-owner'
  | 'create-enrollment-grant'
  | 'exchange-enrollment-grant'
  | 'link-authentication-identity'
  | 'list-devices'
  | 'rename-device'
  | 'revoke-all-devices'
  | 'revoke-all-sessions'
  | 'revoke-device'
  | 'rotate-device-credential'
  | 'unlink-authentication-identity';

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
