import type { Authorizer } from '@ai-usage/authorization';
import type { AuthorizationGrantSubject, ProjectGrantRole } from '@ai-usage/authorization/organization-model';
import type { Instant, PersonId, ProjectId, SpaceId } from '@ai-usage/platform-core/identity';

export interface CreateOrganizationWithAdminInput {
  readonly actorPersonId: PersonId;
  readonly createdAt: Instant;
  readonly spaceId: SpaceId;
}

export interface GrantProjectAccessInput {
  readonly actorPersonId: PersonId;
  readonly expiresAt: Instant | null;
  readonly grantedAt: Instant;
  readonly grantId: string;
  readonly projectId: ProjectId;
  readonly role: ProjectGrantRole;
  readonly spaceId: SpaceId;
  readonly subject: AuthorizationGrantSubject;
}

export interface RevokeProjectAccessInput {
  readonly actorPersonId: PersonId;
  readonly grantId: string;
  readonly revokedAt: Instant;
  readonly spaceId: SpaceId;
}

export interface PlatformAuthorizationAdministration {
  readonly createOrganizationWithAdmin: (input: CreateOrganizationWithAdminInput) => Promise<void>;
  readonly grantProjectAccess: (input: GrantProjectAccessInput) => Promise<void>;
  readonly revokeProjectAccess: (input: RevokeProjectAccessInput) => Promise<void>;
}

export interface PlatformAuthorizationStore extends Authorizer {
  readonly administration: PlatformAuthorizationAdministration;
}
