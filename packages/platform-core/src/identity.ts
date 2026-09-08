declare const identityIdBrand: unique symbol;
declare const instantBrand: unique symbol;

type IdentityId<Kind extends string> = string & { readonly [identityIdBrand]: Kind };

export type CaptureContextId = IdentityId<'capture-context'>;
export type CheckoutId = IdentityId<'checkout'>;
export type DeviceId = IdentityId<'device'>;
export type DeviceCredentialId = IdentityId<'device-credential'>;
export type DeviceEnrollmentGrantId = IdentityId<'device-enrollment-grant'>;
export type AuthenticationIdentityId = IdentityId<'authentication-identity'>;
export type MemoryImportId = IdentityId<'memory-import'>;
export type MemoryItemId = IdentityId<'memory-item'>;
export type MemoryObservationId = IdentityId<'memory-observation'>;
export type MemoryProposalId = IdentityId<'memory-proposal'>;
export type MemoryRelationId = IdentityId<'memory-relation'>;
export type MemoryRevisionId = IdentityId<'memory-revision'>;
export type PersonId = IdentityId<'person'>;
export type ProjectId = IdentityId<'project'>;
export type RepositoryAliasId = IdentityId<'repository-alias'>;
export type RepositoryId = IdentityId<'repository'>;
export type ScmAccountId = IdentityId<'scm-account'>;
export type ScmCredentialId = IdentityId<'scm-credential'>;
export type ScmInstallationId = IdentityId<'scm-installation'>;
export type SpaceId = IdentityId<'space'>;
export type TeamId = IdentityId<'team'>;
export type ReplicationOutboxEventId = IdentityId<'replication-outbox-event'>;
export type WebSessionId = IdentityId<'web-session'>;
export type Instant = string & { readonly [instantBrand]: true };

export type ScmProvider = 'generic' | 'github' | 'gitlab';

export type IdentityValidationErrorCode = 'id-invalid' | 'instant-invalid' | 'text-invalid';

export class IdentityValidationError extends Error {
  readonly code: IdentityValidationErrorCode;
  readonly field: string;

  constructor(code: IdentityValidationErrorCode, field: string) {
    super('The platform identity value is invalid.');
    this.name = 'IdentityValidationError';
    this.code = code;
    this.field = field;
  }
}

const canonicalUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const containsControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });

const parseIdentityId = <Kind extends string>(value: unknown, field: string): IdentityId<Kind> => {
  if (typeof value !== 'string' || !canonicalUuidPattern.test(value)) {
    throw new IdentityValidationError('id-invalid', field);
  }
  return value as IdentityId<Kind>;
};

const createIdentityId = <Kind extends string>(): IdentityId<Kind> => crypto.randomUUID() as IdentityId<Kind>;

export const parseCaptureContextId = (value: unknown): CaptureContextId =>
  parseIdentityId<'capture-context'>(value, 'captureContextId');
export const parseCheckoutId = (value: unknown): CheckoutId => parseIdentityId<'checkout'>(value, 'checkoutId');
export const parseDeviceId = (value: unknown): DeviceId => parseIdentityId<'device'>(value, 'deviceId');
export const parseDeviceCredentialId = (value: unknown): DeviceCredentialId =>
  parseIdentityId<'device-credential'>(value, 'deviceCredentialId');
export const parseDeviceEnrollmentGrantId = (value: unknown): DeviceEnrollmentGrantId =>
  parseIdentityId<'device-enrollment-grant'>(value, 'deviceEnrollmentGrantId');
export const parseAuthenticationIdentityId = (value: unknown): AuthenticationIdentityId =>
  parseIdentityId<'authentication-identity'>(value, 'authenticationIdentityId');
export const parseMemoryImportId = (value: unknown): MemoryImportId =>
  parseIdentityId<'memory-import'>(value, 'memoryImportId');
export const parseMemoryItemId = (value: unknown): MemoryItemId =>
  parseIdentityId<'memory-item'>(value, 'memoryItemId');
export const parseMemoryObservationId = (value: unknown): MemoryObservationId =>
  parseIdentityId<'memory-observation'>(value, 'memoryObservationId');
export const parseMemoryProposalId = (value: unknown): MemoryProposalId =>
  parseIdentityId<'memory-proposal'>(value, 'memoryProposalId');
export const parseMemoryRelationId = (value: unknown): MemoryRelationId =>
  parseIdentityId<'memory-relation'>(value, 'memoryRelationId');
export const parseMemoryRevisionId = (value: unknown): MemoryRevisionId =>
  parseIdentityId<'memory-revision'>(value, 'memoryRevisionId');
export const parsePersonId = (value: unknown): PersonId => parseIdentityId<'person'>(value, 'personId');
export const parseProjectId = (value: unknown): ProjectId => parseIdentityId<'project'>(value, 'projectId');
export const parseRepositoryAliasId = (value: unknown): RepositoryAliasId =>
  parseIdentityId<'repository-alias'>(value, 'repositoryAliasId');
export const parseRepositoryId = (value: unknown): RepositoryId => parseIdentityId<'repository'>(value, 'repositoryId');
export const parseScmAccountId = (value: unknown): ScmAccountId =>
  parseIdentityId<'scm-account'>(value, 'scmAccountId');
export const parseScmCredentialId = (value: unknown): ScmCredentialId =>
  parseIdentityId<'scm-credential'>(value, 'scmCredentialId');
export const parseScmInstallationId = (value: unknown): ScmInstallationId =>
  parseIdentityId<'scm-installation'>(value, 'scmInstallationId');
export const parseSpaceId = (value: unknown): SpaceId => parseIdentityId<'space'>(value, 'spaceId');
export const parseTeamId = (value: unknown): TeamId => parseIdentityId<'team'>(value, 'teamId');
export const parseReplicationOutboxEventId = (value: unknown): ReplicationOutboxEventId =>
  parseIdentityId<'replication-outbox-event'>(value, 'replicationOutboxEventId');
export const parseWebSessionId = (value: unknown): WebSessionId =>
  parseIdentityId<'web-session'>(value, 'webSessionId');

export const createCaptureContextId = (): CaptureContextId => createIdentityId<'capture-context'>();
export const createCheckoutId = (): CheckoutId => createIdentityId<'checkout'>();
export const createDeviceId = (): DeviceId => createIdentityId<'device'>();
export const createDeviceCredentialId = (): DeviceCredentialId => createIdentityId<'device-credential'>();
export const createDeviceEnrollmentGrantId = (): DeviceEnrollmentGrantId =>
  createIdentityId<'device-enrollment-grant'>();
export const createAuthenticationIdentityId = (): AuthenticationIdentityId =>
  createIdentityId<'authentication-identity'>();
export const createMemoryImportId = (): MemoryImportId => createIdentityId<'memory-import'>();
export const createMemoryItemId = (): MemoryItemId => createIdentityId<'memory-item'>();
export const createMemoryObservationId = (): MemoryObservationId => createIdentityId<'memory-observation'>();
export const createMemoryProposalId = (): MemoryProposalId => createIdentityId<'memory-proposal'>();
export const createMemoryRelationId = (): MemoryRelationId => createIdentityId<'memory-relation'>();
export const createMemoryRevisionId = (): MemoryRevisionId => createIdentityId<'memory-revision'>();
export const createPersonId = (): PersonId => createIdentityId<'person'>();
export const createProjectId = (): ProjectId => createIdentityId<'project'>();
export const createRepositoryAliasId = (): RepositoryAliasId => createIdentityId<'repository-alias'>();
export const createRepositoryId = (): RepositoryId => createIdentityId<'repository'>();
export const createScmAccountId = (): ScmAccountId => createIdentityId<'scm-account'>();
export const createScmCredentialId = (): ScmCredentialId => createIdentityId<'scm-credential'>();
export const createScmInstallationId = (): ScmInstallationId => createIdentityId<'scm-installation'>();
export const createSpaceId = (): SpaceId => createIdentityId<'space'>();
export const createTeamId = (): TeamId => createIdentityId<'team'>();
export const createReplicationOutboxEventId = (): ReplicationOutboxEventId =>
  createIdentityId<'replication-outbox-event'>();
export const createWebSessionId = (): WebSessionId => createIdentityId<'web-session'>();

export const parseInstant = (value: unknown, field = 'instant'): Instant => {
  if (typeof value !== 'string') {
    throw new IdentityValidationError('instant-invalid', field);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new IdentityValidationError('instant-invalid', field);
  }
  return value as Instant;
};

export const instantNow = (clock: () => Date = () => new Date()): Instant => parseInstant(clock().toISOString());

export const parseIdentityText = (value: unknown, field: string, maximumLength = 256): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    containsControlCharacter(value)
  ) {
    throw new IdentityValidationError('text-invalid', field);
  }
  return value;
};

export interface Space {
  readonly createdAt: Instant;
  readonly displayName: string;
  readonly id: SpaceId;
  readonly kind: 'organization' | 'personal';
}

export interface Person {
  readonly displayName: string;
  readonly id: PersonId;
  readonly personalSpaceId: SpaceId;
  readonly status: 'active' | 'suspended';
}

export interface Device {
  readonly id: DeviceId;
  readonly label: string;
  readonly lastSeenAt: Instant | null;
  readonly ownerPersonId: PersonId;
  readonly owningSpaceId: SpaceId;
  readonly status: 'active' | 'local' | 'pending' | 'revoked';
}

export interface ScmAccount {
  readonly handle: string | null;
  readonly id: ScmAccountId;
  readonly personId: PersonId;
  readonly provider: ScmProvider;
  readonly providerAccountId: string;
}

export interface ScmInstallation {
  readonly id: ScmInstallationId;
  readonly owningSpaceId: SpaceId;
  readonly provider: ScmProvider;
  readonly providerInstallationId: string;
  readonly selectedRepositoryIds: readonly string[];
  readonly status: 'active' | 'revoked' | 'suspended';
}

export interface ScmCredential {
  readonly accountId: ScmAccountId | null;
  readonly createdAt: Instant;
  readonly encryptedSecretReference: string;
  readonly id: ScmCredentialId;
  readonly installationId: ScmInstallationId | null;
  readonly revokedAt: Instant | null;
  readonly rotatedAt: Instant | null;
}

export interface Repository {
  readonly canonicalHost: string;
  readonly canonicalName: string;
  readonly canonicalOwner: string | null;
  readonly id: RepositoryId;
  readonly owningSpaceId: SpaceId;
  readonly provider: ScmProvider;
  readonly providerRepositoryId: string | null;
  readonly status: 'active' | 'archived' | 'renamed' | 'unknown';
}

export interface RepositoryAlias {
  readonly firstObservedAt: Instant;
  readonly id: RepositoryAliasId;
  readonly lastObservedAt: Instant | null;
  readonly normalizedRemote: string;
  readonly owningSpaceId: SpaceId;
  readonly repositoryId: RepositoryId;
  readonly source: 'local-git' | 'manual' | 'provider-api';
}

export interface Project {
  readonly displayName: string;
  readonly id: ProjectId;
  readonly kind: 'local' | 'repository';
  readonly owningSpaceId: SpaceId;
  readonly repositoryId: RepositoryId | null;
  readonly repositorySubpath: string | null;
  readonly status: 'active' | 'archived';
}

export interface Checkout {
  readonly deviceId: DeviceId;
  readonly id: CheckoutId;
  readonly lastObservedAt: Instant;
  readonly localPath: string;
  readonly observedRemote: string | null;
  readonly projectId: ProjectId | null;
  readonly repositoryId: RepositoryId | null;
  readonly status: 'available' | 'missing' | 'unknown';
}

export interface CaptureContext {
  readonly deviceId: DeviceId;
  readonly id: CaptureContextId;
  readonly personId: PersonId;
  readonly projectId: ProjectId | null;
  readonly scmAccountId: ScmAccountId | null;
  readonly scmInstallationId: ScmInstallationId | null;
  readonly source: 'explicit' | 'personal-fallback' | 'project-rule' | 'unassigned';
  readonly spaceId: SpaceId;
}

export const hasExactlyOneScmCredentialOwner = (
  credential: Pick<ScmCredential, 'accountId' | 'installationId'>,
): boolean => (credential.accountId === null) !== (credential.installationId === null);
