import type {
  DeviceId,
  Instant,
  PersonId,
  ProjectId,
  RepositoryId,
  ScmInstallationId,
  SpaceId,
  TeamId,
} from '@ai-usage/platform-core/identity';

export type AuthorizationRelationStatus = 'active' | 'revoked';
export type SpaceMembershipRole = 'admin' | 'member' | 'security-auditor' | 'usage-auditor';
export type ProjectGrantRole = 'collaborator' | 'maintainer' | 'viewer';
export type RepositoryGrantRole = 'maintainer' | 'viewer';
export type ContentGrantRole = 'editor' | 'manager' | 'viewer';
export type MemoryGrantRole = 'manager' | 'proposer' | 'viewer';
export type WorkGrantRole = 'contributor' | 'manager' | 'viewer';

export type AuthorizationGrantSubject =
  | { readonly kind: 'person'; readonly personId: PersonId }
  | { readonly kind: 'team'; readonly teamId: TeamId };

export interface PersonalAuthorizationSpace {
  readonly ownerPersonId: PersonId;
  readonly spaceId: SpaceId;
}

export interface AuthorizationOrganization {
  readonly spaceId: SpaceId;
  readonly status: 'active' | 'suspended';
}

export interface SpaceMembership {
  readonly personId: PersonId;
  readonly role: SpaceMembershipRole;
  readonly spaceId: SpaceId;
  readonly status: AuthorizationRelationStatus;
}

export interface AuthorizationTeam {
  readonly id: TeamId;
  readonly spaceId: SpaceId;
  readonly status: AuthorizationRelationStatus;
}

export interface TeamMembership {
  readonly personId: PersonId;
  readonly spaceId: SpaceId;
  readonly status: AuthorizationRelationStatus;
  readonly teamId: TeamId;
}

export interface TeamNesting {
  readonly childTeamId: TeamId;
  readonly parentTeamId: TeamId;
  readonly spaceId: SpaceId;
  readonly status: AuthorizationRelationStatus;
}

export interface TimedAuthorizationRelation {
  readonly expiresAt: Instant | null;
  readonly spaceId: SpaceId;
  readonly status: AuthorizationRelationStatus;
}

export interface AuthorizationProject {
  readonly id: ProjectId;
  readonly repositoryId: RepositoryId | null;
  readonly spaceId: SpaceId;
  readonly status: 'active' | 'archived';
}

export interface ProjectGrant extends TimedAuthorizationRelation {
  readonly projectId: ProjectId;
  readonly role: ProjectGrantRole;
  readonly subject: AuthorizationGrantSubject;
}

export interface AuthorizationRepository {
  readonly id: RepositoryId;
  readonly spaceId: SpaceId;
  readonly status: 'active' | 'archived';
}

export interface RepositoryGrant extends TimedAuthorizationRelation {
  readonly repositoryId: RepositoryId;
  readonly role: RepositoryGrantRole;
  readonly subject: AuthorizationGrantSubject;
}

export interface AuthorizationDevice {
  readonly id: DeviceId;
  readonly ownerPersonId: PersonId;
  readonly spaceId: SpaceId;
  readonly status: 'active' | 'pending' | 'revoked';
}

export interface DeviceManager extends TimedAuthorizationRelation {
  readonly deviceId: DeviceId;
  readonly personId: PersonId;
}

export interface AuthorizationSession {
  readonly id: string;
  readonly ownerPersonId: PersonId;
  readonly projectId: ProjectId | null;
  readonly spaceId: SpaceId;
  readonly status: 'active' | 'archived' | 'purged';
}

export interface SessionMetadataGrant extends TimedAuthorizationRelation {
  readonly role: 'manager' | 'viewer';
  readonly sessionId: string;
  readonly subject: AuthorizationGrantSubject;
}

export interface SessionContentGrant extends TimedAuthorizationRelation {
  readonly role: ContentGrantRole;
  readonly sessionId: string;
  readonly subject: AuthorizationGrantSubject;
}

export interface AuthorizationMemoryItem {
  readonly id: string;
  readonly ownerPersonId: PersonId;
  readonly projectId: ProjectId | null;
  readonly requiresTrustedDevice: boolean;
  readonly sensitivity: 'normal' | 'sensitive';
  readonly spaceId: SpaceId;
  readonly status: 'active' | 'superseded';
}

export interface MemoryContentGrant extends TimedAuthorizationRelation {
  readonly memoryId: string;
  readonly role: MemoryGrantRole;
  readonly subject: AuthorizationGrantSubject;
}

export interface AuthorizationWorkThread {
  readonly id: string;
  readonly projectId: ProjectId | null;
  readonly spaceId: SpaceId;
  readonly status: 'active' | 'closed';
}

export interface WorkThreadGrant extends TimedAuthorizationRelation {
  readonly role: WorkGrantRole;
  readonly subject: AuthorizationGrantSubject;
  readonly workThreadId: string;
}

export interface AuthorizationWorkHandoff {
  readonly id: string;
  readonly projectId: ProjectId | null;
  readonly spaceId: SpaceId;
  readonly status: 'accepted' | 'draft' | 'expired';
  readonly workThreadId: string;
}

export interface WorkHandoffGrant extends TimedAuthorizationRelation {
  readonly role: WorkGrantRole;
  readonly subject: AuthorizationGrantSubject;
  readonly workHandoffId: string;
}

export interface ScmInstallationRepositoryGrant extends TimedAuthorizationRelation {
  readonly installationId: ScmInstallationId;
  readonly repositoryId: RepositoryId;
}

export interface OrganizationAuthorizationState {
  readonly deviceManagers: readonly DeviceManager[];
  readonly devices: readonly AuthorizationDevice[];
  readonly memoryContentGrants: readonly MemoryContentGrant[];
  readonly memoryItems: readonly AuthorizationMemoryItem[];
  readonly organizations: readonly AuthorizationOrganization[];
  readonly personalSpaces: readonly PersonalAuthorizationSpace[];
  readonly projectGrants: readonly ProjectGrant[];
  readonly projects: readonly AuthorizationProject[];
  readonly repositories: readonly AuthorizationRepository[];
  readonly repositoryGrants: readonly RepositoryGrant[];
  readonly scmInstallationRepositoryGrants: readonly ScmInstallationRepositoryGrant[];
  readonly sessionContentGrants: readonly SessionContentGrant[];
  readonly sessionMetadataGrants: readonly SessionMetadataGrant[];
  readonly sessions: readonly AuthorizationSession[];
  readonly spaceMemberships: readonly SpaceMembership[];
  readonly teamMemberships: readonly TeamMembership[];
  readonly teamNestings: readonly TeamNesting[];
  readonly teams: readonly AuthorizationTeam[];
  readonly workHandoffGrants: readonly WorkHandoffGrant[];
  readonly workHandoffs: readonly AuthorizationWorkHandoff[];
  readonly workThreadGrants: readonly WorkThreadGrant[];
  readonly workThreads: readonly AuthorizationWorkThread[];
}

export const emptyOrganizationAuthorizationState = (): OrganizationAuthorizationState => ({
  deviceManagers: [],
  devices: [],
  memoryContentGrants: [],
  memoryItems: [],
  organizations: [],
  personalSpaces: [],
  projectGrants: [],
  projects: [],
  repositories: [],
  repositoryGrants: [],
  scmInstallationRepositoryGrants: [],
  sessionContentGrants: [],
  sessionMetadataGrants: [],
  sessions: [],
  spaceMemberships: [],
  teamMemberships: [],
  teamNestings: [],
  teams: [],
  workHandoffGrants: [],
  workHandoffs: [],
  workThreadGrants: [],
  workThreads: [],
});
