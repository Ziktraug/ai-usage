import type { Instant, PersonId, ProjectId, SpaceId, TeamId } from '@ai-usage/platform-core/identity';
import type {
  AuthorizationCheck,
  AuthorizationDecision,
  AuthorizationOperation,
  AuthorizationPermission,
  AuthorizationPrincipal,
  AuthorizationResource,
  AuthorizationResourceKind,
  AuthorizationUnavailable,
  AuthorizedResourceListQuery,
  AuthorizedResourcePage,
  AuthorizedResourceScopeQuery,
  AuthorizedResourceScopeResult,
  Authorizer,
} from './index';
import type {
  AuthorizationGrantSubject,
  AuthorizationRelationStatus,
  ContentGrantRole,
  MemoryGrantRole,
  OrganizationAuthorizationState,
  ProjectGrantRole,
  RepositoryGrantRole,
  SpaceMembershipRole,
  WorkGrantRole,
} from './organization-model';
import { permissionSupportsResource } from './permission-resource';
import { createAuthorizedResourceScope } from './scope-internal';

const maximumPageSize = 100;
const maximumTeamDepth = 3;

const personalOwnerPermissions = new Set<AuthorizationPermission>([
  'accept_memory',
  'accept_work_handoff',
  'archive_session_content',
  'create_work_handoff',
  'link_repository',
  'link_session_to_work_thread',
  'manage_device',
  'manage_memory',
  'manage_project',
  'manage_repository_binding',
  'manage_session_archive_policy',
  'manage_work_handoff',
  'manage_work_thread',
  'propose_memory',
  'purge_session_archive',
  'revoke_device',
  'view_device',
  'view_memory',
  'view_project',
  'view_project_usage_aggregate',
  'view_project_usage_detail',
  'view_repository_metadata',
  'view_session_content',
  'view_session_metadata',
  'view_work_handoff',
  'view_work_thread',
]);

export type AuthorizationReadDomain =
  | 'device-managers'
  | 'devices'
  | 'memory-content-grants'
  | 'memory-items'
  | 'organizations'
  | 'personal-spaces'
  | 'project-grants'
  | 'projects'
  | 'repositories'
  | 'repository-grants'
  | 'session-content-grants'
  | 'session-metadata-grants'
  | 'sessions'
  | 'space-memberships'
  | 'team-memberships'
  | 'team-nestings'
  | 'teams'
  | 'work-handoff-grants'
  | 'work-handoffs'
  | 'work-thread-grants'
  | 'work-threads';

export class AuthorizationModelError extends Error {
  readonly code = 'authorization-model-invalid' as const;
  readonly rule: string;

  constructor(rule: string) {
    super('The organization authorization model is invalid.');
    this.name = 'AuthorizationModelError';
    this.rule = rule;
  }
}

export interface InMemoryOrganizationAuthorizerConfig {
  readonly checkAvailability?: (operation: AuthorizationOperation) => Promise<void>;
  readonly now?: () => Date;
  readonly onRead?: (domain: AuthorizationReadDomain) => void;
  readonly state: OrganizationAuthorizationState;
}

interface CursorPayload {
  readonly activeSpaceId: SpaceId;
  readonly afterId: string | null;
  readonly permission: AuthorizationPermission;
  readonly personId: PersonId;
  readonly resourceKind: AuthorizationResourceKind;
  readonly version: 1;
}

const encodeCursor = (payload: CursorPayload): string => btoa(JSON.stringify(payload));

const decodeCursor = (cursor: string | null | undefined): CursorPayload | null => {
  if (cursor === undefined || cursor === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(atob(cursor));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const value = parsed as Partial<CursorPayload>;
    if (
      value.version !== 1 ||
      typeof value.activeSpaceId !== 'string' ||
      (value.afterId !== null && typeof value.afterId !== 'string') ||
      typeof value.permission !== 'string' ||
      typeof value.personId !== 'string' ||
      typeof value.resourceKind !== 'string'
    ) {
      return null;
    }
    return value as CursorPayload;
  } catch {
    return null;
  }
};

const unavailable = (
  operation: AuthorizationOperation,
  rule: string,
  code: AuthorizationUnavailable['code'] = 'authorization-unavailable',
): AuthorizationUnavailable => ({ code, operation, rule });

const relationIsActive = (
  relation: { readonly expiresAt?: Instant | null; readonly status: AuthorizationRelationStatus },
  now: Date,
): boolean =>
  relation.status === 'active' &&
  (relation.expiresAt === undefined || relation.expiresAt === null || Date.parse(relation.expiresAt) > now.getTime());

const subjectTeamId = (subject: AuthorizationGrantSubject): TeamId | null =>
  subject.kind === 'team' ? subject.teamId : null;

const validateState = (state: OrganizationAuthorizationState): void => {
  const spaceIds = new Set<string>();
  for (const space of state.personalSpaces) {
    if (spaceIds.has(space.spaceId)) {
      throw new AuthorizationModelError('model.space-duplicate');
    }
    spaceIds.add(space.spaceId);
  }
  for (const organization of state.organizations) {
    if (spaceIds.has(organization.spaceId)) {
      throw new AuthorizationModelError('model.space-duplicate');
    }
    spaceIds.add(organization.spaceId);
  }

  const teams = new Map<TeamId, SpaceId>();
  for (const team of state.teams) {
    if (!spaceIds.has(team.spaceId) || teams.has(team.id)) {
      throw new AuthorizationModelError('model.team-invalid');
    }
    teams.set(team.id, team.spaceId);
  }
  for (const membership of state.teamMemberships) {
    if (teams.get(membership.teamId) !== membership.spaceId) {
      throw new AuthorizationModelError('model.team-membership-cross-space');
    }
  }
  for (const nesting of state.teamNestings) {
    if (
      nesting.childTeamId === nesting.parentTeamId ||
      teams.get(nesting.childTeamId) !== nesting.spaceId ||
      teams.get(nesting.parentTeamId) !== nesting.spaceId
    ) {
      throw new AuthorizationModelError('model.team-nesting-cross-space');
    }
  }

  const activeParents = new Map<TeamId, readonly TeamId[]>();
  for (const team of state.teams) {
    activeParents.set(
      team.id,
      state.teamNestings
        .filter((edge) => edge.status === 'active' && edge.childTeamId === team.id)
        .map((edge) => edge.parentTeamId),
    );
  }
  const visit = (teamId: TeamId, path: readonly TeamId[]): void => {
    if (path.includes(teamId)) {
      throw new AuthorizationModelError('model.team-cycle');
    }
    if (path.length >= maximumTeamDepth) {
      if ((activeParents.get(teamId) ?? []).length > 0) {
        throw new AuthorizationModelError('model.team-depth-exceeded');
      }
      return;
    }
    for (const parent of activeParents.get(teamId) ?? []) {
      visit(parent, [...path, teamId]);
    }
  };
  for (const teamId of teams.keys()) {
    visit(teamId, []);
  }

  const ensureSubjectSpace = (subject: AuthorizationGrantSubject, spaceId: SpaceId): void => {
    const teamId = subjectTeamId(subject);
    if (teamId !== null && teams.get(teamId) !== spaceId) {
      throw new AuthorizationModelError('model.grant-subject-cross-space');
    }
  };
  for (const grant of [
    ...state.projectGrants,
    ...state.repositoryGrants,
    ...state.sessionMetadataGrants,
    ...state.sessionContentGrants,
    ...state.memoryContentGrants,
    ...state.workThreadGrants,
    ...state.workHandoffGrants,
  ]) {
    ensureSubjectSpace(grant.subject, grant.spaceId);
  }
};

const principalPersonId = (principal: AuthorizationPrincipal): PersonId | null =>
  principal.kind === 'person' ? principal.personId : null;

export const createInMemoryOrganizationAuthorizer = (config: InMemoryOrganizationAuthorizerConfig): Authorizer => {
  validateState(config.state);
  const now = config.now ?? (() => new Date());
  const read = (domain: AuthorizationReadDomain): void => config.onRead?.(domain);

  const isPersonalOwner = (personId: PersonId, spaceId: SpaceId): boolean => {
    read('personal-spaces');
    return config.state.personalSpaces.some((space) => space.spaceId === spaceId && space.ownerPersonId === personId);
  };

  const organizationIsActive = (spaceId: SpaceId): boolean => {
    read('organizations');
    return config.state.organizations.some(
      (organization) => organization.spaceId === spaceId && organization.status === 'active',
    );
  };

  const membershipRoles = (personId: PersonId, spaceId: SpaceId): ReadonlySet<SpaceMembershipRole> => {
    read('space-memberships');
    return new Set(
      config.state.spaceMemberships
        .filter(
          (membership) =>
            membership.personId === personId && membership.spaceId === spaceId && relationIsActive(membership, now()),
        )
        .map((membership) => membership.role),
    );
  };

  const effectiveTeamIds = (personId: PersonId, spaceId: SpaceId): ReadonlySet<TeamId> => {
    read('teams');
    read('team-memberships');
    read('team-nestings');
    const activeTeams = new Set(
      config.state.teams.filter((team) => team.spaceId === spaceId && team.status === 'active').map((team) => team.id),
    );
    const result = new Set(
      config.state.teamMemberships
        .filter(
          (membership) =>
            membership.personId === personId &&
            membership.spaceId === spaceId &&
            membership.status === 'active' &&
            activeTeams.has(membership.teamId),
        )
        .map((membership) => membership.teamId),
    );
    let frontier = [...result];
    for (let depth = 0; depth < maximumTeamDepth && frontier.length > 0; depth += 1) {
      const next: TeamId[] = [];
      for (const childTeamId of frontier) {
        for (const edge of config.state.teamNestings) {
          if (
            edge.status === 'active' &&
            edge.spaceId === spaceId &&
            edge.childTeamId === childTeamId &&
            activeTeams.has(edge.parentTeamId) &&
            !result.has(edge.parentTeamId)
          ) {
            result.add(edge.parentTeamId);
            next.push(edge.parentTeamId);
          }
        }
      }
      frontier = next;
    }
    return result;
  };

  const subjectMatches = (
    subject: AuthorizationGrantSubject,
    personId: PersonId,
    teamIds: ReadonlySet<TeamId>,
  ): boolean => (subject.kind === 'person' ? subject.personId === personId : teamIds.has(subject.teamId));

  const projectRole = (personId: PersonId, spaceId: SpaceId, projectId: ProjectId): ProjectGrantRole | null => {
    read('project-grants');
    const teamIds = effectiveTeamIds(personId, spaceId);
    const roles = config.state.projectGrants
      .filter(
        (grant) =>
          grant.projectId === projectId &&
          grant.spaceId === spaceId &&
          relationIsActive(grant, now()) &&
          subjectMatches(grant.subject, personId, teamIds),
      )
      .map((grant) => grant.role);
    if (roles.includes('maintainer')) {
      return 'maintainer';
    }
    if (roles.includes('collaborator')) {
      return 'collaborator';
    }
    return roles.includes('viewer') ? 'viewer' : null;
  };

  const repositoryRole = (personId: PersonId, spaceId: SpaceId, repositoryId: string): RepositoryGrantRole | null => {
    read('repository-grants');
    const teamIds = effectiveTeamIds(personId, spaceId);
    const roles = config.state.repositoryGrants
      .filter(
        (grant) =>
          grant.repositoryId === repositoryId &&
          grant.spaceId === spaceId &&
          relationIsActive(grant, now()) &&
          subjectMatches(grant.subject, personId, teamIds),
      )
      .map((grant) => grant.role);
    if (roles.includes('maintainer')) {
      return 'maintainer';
    }
    return roles.includes('viewer') ? 'viewer' : null;
  };

  const contentRole = <Role extends string>(
    grants: readonly {
      readonly expiresAt: Instant | null;
      readonly role: Role;
      readonly spaceId: SpaceId;
      readonly status: AuthorizationRelationStatus;
      readonly subject: AuthorizationGrantSubject;
    }[],
    personId: PersonId,
    spaceId: SpaceId,
    rank: Readonly<Record<Role, number>>,
  ): Role | null => {
    const teamIds = effectiveTeamIds(personId, spaceId);
    const roles = grants
      .filter(
        (grant) =>
          grant.spaceId === spaceId &&
          relationIsActive(grant, now()) &&
          subjectMatches(grant.subject, personId, teamIds),
      )
      .map((grant) => grant.role)
      .sort((left, right) => rank[right] - rank[left]);
    return roles[0] ?? null;
  };

  const resourceExists = (input: AuthorizationCheck): boolean => {
    const { resource } = input;
    switch (resource.kind) {
      case 'space': {
        read('personal-spaces');
        read('organizations');
        return (
          resource.id === resource.spaceId &&
          (config.state.personalSpaces.some((space) => space.spaceId === resource.spaceId) ||
            config.state.organizations.some((space) => space.spaceId === resource.spaceId))
        );
      }
      case 'project':
        read('projects');
        return config.state.projects.some(
          (project) => project.id === resource.id && project.spaceId === resource.spaceId,
        );
      case 'repository':
        read('repositories');
        return config.state.repositories.some(
          (repository) => repository.id === resource.id && repository.spaceId === resource.spaceId,
        );
      case 'device':
        read('devices');
        return config.state.devices.some((device) => device.id === resource.id && device.spaceId === resource.spaceId);
      case 'session':
        read('sessions');
        return config.state.sessions.some(
          (session) => session.id === resource.id && session.spaceId === resource.spaceId,
        );
      case 'memory':
        read('memory-items');
        return config.state.memoryItems.some(
          (memory) => memory.id === resource.id && memory.spaceId === resource.spaceId,
        );
      case 'work-thread':
        read('work-threads');
        return config.state.workThreads.some(
          (thread) => thread.id === resource.id && thread.spaceId === resource.spaceId,
        );
      case 'work-handoff':
        read('work-handoffs');
        return config.state.workHandoffs.some(
          (handoff) => handoff.id === resource.id && handoff.spaceId === resource.spaceId,
        );
      case 'usage-aggregate':
        if (input.permission === 'view_organization_usage_aggregate') {
          return resource.id === resource.spaceId && organizationIsActive(resource.spaceId);
        }
        if (input.permission === 'view_project_usage_aggregate') {
          read('projects');
          return config.state.projects.some(
            (project) => project.id === resource.id && project.spaceId === resource.spaceId,
          );
        }
        return false;
      default:
        return false;
    }
  };

  const evaluate = (input: AuthorizationCheck): AuthorizationDecision => {
    if (!permissionSupportsResource(input.permission, input.resource.kind)) {
      return { kind: 'deny', reason: 'organization.permission-resource-mismatch' };
    }
    if (input.context.activeSpaceId !== input.resource.spaceId) {
      return { kind: 'deny', reason: 'organization.active-space-mismatch' };
    }
    const personId = principalPersonId(input.principal);
    if (personId === null) {
      return { kind: 'deny', reason: 'organization.unsupported-principal' };
    }
    if (!resourceExists(input)) {
      return { kind: 'deny', reason: 'organization.resource-not-found' };
    }

    if (input.resource.kind === 'memory') {
      read('memory-items');
      const memory = config.state.memoryItems.find((item) => item.id === input.resource.id);
      if (memory?.requiresTrustedDevice && !input.context.trustedDevice) {
        return { kind: 'deny', reason: 'organization.memory-trusted-device-required' };
      }
    }
    if (input.resource.kind === 'device' && input.permission !== 'view_device') {
      read('devices');
      const device = config.state.devices.find((item) => item.id === input.resource.id);
      if (device?.status === 'revoked') {
        return { kind: 'deny', reason: 'organization.device-revoked' };
      }
    }

    if (isPersonalOwner(personId, input.resource.spaceId)) {
      return personalOwnerPermissions.has(input.permission)
        ? { kind: 'allow', reason: 'personal-space.owner' }
        : { kind: 'deny', reason: 'personal-space.permission-not-applicable' };
    }
    if (!organizationIsActive(input.resource.spaceId)) {
      return { kind: 'deny', reason: 'organization.space-unavailable' };
    }

    const roles = membershipRoles(personId, input.resource.spaceId);
    const isMember = roles.size > 0;
    const isAdmin = roles.has('admin');
    const isUsageAuditor = roles.has('usage-auditor');
    const isSecurityAuditor = roles.has('security-auditor');
    const allow = (rule: string): AuthorizationDecision => ({ kind: 'allow', reason: rule });
    const deny = (rule: string): AuthorizationDecision => ({ kind: 'deny', reason: rule });

    if (
      (input.permission === 'link_repository' || input.permission === 'manage_repository_binding') &&
      input.resource.kind === 'project'
    ) {
      const role = projectRole(personId, input.resource.spaceId, input.resource.id as ProjectId);
      return role === 'maintainer' ? allow('project.maintainer') : deny('project.maintainer-required');
    }
    if (input.permission === 'propose_memory' && input.resource.kind !== 'memory') {
      if (input.resource.kind === 'space') {
        return isMember ? allow('organization.active-membership') : deny('organization.membership-required');
      }
      const role = projectRole(personId, input.resource.spaceId, input.resource.id as ProjectId);
      return role === 'collaborator' || role === 'maintainer'
        ? allow('project.collaborator')
        : deny('project.collaborator-required');
    }
    if (input.permission === 'create_work_handoff' && input.resource.kind !== 'work-thread') {
      if (input.resource.kind === 'space') {
        return isMember ? allow('organization.active-membership') : deny('organization.membership-required');
      }
      const role = projectRole(personId, input.resource.spaceId, input.resource.id as ProjectId);
      return role === 'collaborator' || role === 'maintainer'
        ? allow('project.collaborator')
        : deny('project.collaborator-required');
    }
    if (input.permission === 'link_session_to_work_thread' && input.resource.kind === 'work-thread') {
      read('work-thread-grants');
      const role = contentRole<WorkGrantRole>(
        config.state.workThreadGrants.filter((grant) => grant.workThreadId === input.resource.id),
        personId,
        input.resource.spaceId,
        { contributor: 2, manager: 3, viewer: 1 },
      );
      return role === 'manager' ? allow('work-thread.manager') : deny('work-thread.manager-required');
    }
    if (input.permission === 'manage_session_archive_policy' && input.resource.kind === 'space') {
      return isAdmin ? allow('organization.admin-archive-policy') : deny('organization.admin-required');
    }
    if (input.permission === 'manage_device' && input.resource.kind === 'space') {
      return isAdmin ? allow('organization.admin-device-enrollment') : deny('organization.admin-required');
    }

    switch (input.permission) {
      case 'view_organization':
        return isMember ? allow('organization.active-membership') : deny('organization.membership-required');
      case 'manage_organization':
      case 'manage_members':
      case 'manage_teams':
      case 'manage_authorization':
        return isAdmin ? allow('organization.admin-management') : deny('organization.admin-required');
      case 'view_organization_usage_aggregate':
        return isUsageAuditor
          ? allow('organization.usage-auditor-aggregate')
          : deny('organization.usage-auditor-required');
      case 'view_project':
      case 'view_project_usage_detail':
      case 'manage_project': {
        const role = projectRole(personId, input.resource.spaceId, input.resource.id as ProjectId);
        if (input.permission === 'view_project') {
          return role ? allow('project.grant-view') : deny('project.grant-required');
        }
        if (input.permission === 'view_project_usage_detail') {
          return role === 'collaborator' || role === 'maintainer'
            ? allow('project.collaborator')
            : deny('project.collaborator-required');
        }
        return role === 'maintainer' ? allow('project.maintainer') : deny('project.maintainer-required');
      }
      case 'view_project_usage_aggregate': {
        const role = projectRole(personId, input.resource.spaceId, input.resource.id as ProjectId);
        return isUsageAuditor || role !== null
          ? allow(isUsageAuditor ? 'organization.usage-auditor-project-aggregate' : 'project.grant-aggregate')
          : deny('project.aggregate-grant-required');
      }
      case 'view_repository_metadata':
      case 'manage_repository_binding':
      case 'link_repository': {
        const role = repositoryRole(personId, input.resource.spaceId, input.resource.id);
        if (input.permission === 'view_repository_metadata') {
          if (isSecurityAuditor) {
            return allow('organization.security-auditor-repository-metadata');
          }
          if (role !== null) {
            return allow('repository.grant-view');
          }
          read('projects');
          const linkedProjects = config.state.projects.filter(
            (project) => project.spaceId === input.resource.spaceId && project.repositoryId === input.resource.id,
          );
          return linkedProjects.some((project) => projectRole(personId, input.resource.spaceId, project.id) !== null)
            ? allow('repository.linked-project-grant')
            : deny('repository.grant-required');
        }
        return role === 'maintainer' ? allow('repository.maintainer') : deny('repository.maintainer-required');
      }
      case 'view_device':
      case 'manage_device':
      case 'revoke_device': {
        read('devices');
        const device = config.state.devices.find((item) => item.id === input.resource.id);
        read('device-managers');
        const isManager = config.state.deviceManagers.some(
          (manager) =>
            manager.deviceId === input.resource.id &&
            manager.personId === personId &&
            manager.spaceId === input.resource.spaceId &&
            relationIsActive(manager, now()),
        );
        if (input.permission === 'view_device' && isSecurityAuditor) {
          return allow('organization.security-auditor-device-metadata');
        }
        if (device?.ownerPersonId === personId) {
          return allow('device.owner');
        }
        return isManager ? allow('device.manager') : deny('device.owner-or-manager-required');
      }
      case 'view_session_metadata':
      case 'view_session_content':
      case 'archive_session_content':
      case 'manage_session_archive_policy':
      case 'purge_session_archive':
      case 'link_session_to_work_thread': {
        read('sessions');
        const session = config.state.sessions.find((item) => item.id === input.resource.id);
        const teamIds = effectiveTeamIds(personId, input.resource.spaceId);
        read('session-metadata-grants');
        const metadataRole = config.state.sessionMetadataGrants.some(
          (grant) =>
            grant.sessionId === input.resource.id &&
            relationIsActive(grant, now()) &&
            subjectMatches(grant.subject, personId, teamIds),
        );
        read('session-content-grants');
        const content = contentRole<ContentGrantRole>(
          config.state.sessionContentGrants.filter((grant) => grant.sessionId === input.resource.id),
          personId,
          input.resource.spaceId,
          { editor: 2, manager: 3, viewer: 1 },
        );
        if (input.permission === 'view_session_metadata' || input.permission === 'link_session_to_work_thread') {
          const projectAccess =
            session?.projectId === null || session?.projectId === undefined
              ? null
              : projectRole(personId, input.resource.spaceId, session.projectId);
          return isSecurityAuditor || metadataRole || projectAccess === 'collaborator' || projectAccess === 'maintainer'
            ? allow(isSecurityAuditor ? 'organization.security-auditor-session-metadata' : 'session.metadata-grant')
            : deny('session.metadata-grant-required');
        }
        if (input.permission === 'view_session_content') {
          return content ? allow('session.explicit-content-grant') : deny('session.content-grant-required');
        }
        if (input.permission === 'archive_session_content') {
          return content === 'editor' || content === 'manager'
            ? allow('session.content-editor')
            : deny('session.content-editor-required');
        }
        return content === 'manager' ? allow('session.content-manager') : deny('session.content-manager-required');
      }
      case 'view_memory':
      case 'propose_memory':
      case 'accept_memory':
      case 'manage_memory': {
        read('memory-content-grants');
        const role = contentRole<MemoryGrantRole>(
          config.state.memoryContentGrants.filter((grant) => grant.memoryId === input.resource.id),
          personId,
          input.resource.spaceId,
          { manager: 3, proposer: 2, viewer: 1 },
        );
        if (input.permission === 'view_memory') {
          return role ? allow('memory.explicit-content-grant') : deny('memory.content-grant-required');
        }
        if (input.permission === 'propose_memory') {
          return role === 'proposer' || role === 'manager'
            ? allow('memory.proposer')
            : deny('memory.proposer-required');
        }
        return role === 'manager' ? allow('memory.manager') : deny('memory.manager-required');
      }
      case 'view_work_thread':
      case 'manage_work_thread':
      case 'create_work_handoff': {
        read('work-thread-grants');
        const role = contentRole<WorkGrantRole>(
          config.state.workThreadGrants.filter((grant) => grant.workThreadId === input.resource.id),
          personId,
          input.resource.spaceId,
          { contributor: 2, manager: 3, viewer: 1 },
        );
        if (input.permission === 'view_work_thread') {
          return role ? allow('work-thread.explicit-grant') : deny('work-thread.grant-required');
        }
        if (input.permission === 'create_work_handoff') {
          return role === 'contributor' || role === 'manager'
            ? allow('work-thread.contributor')
            : deny('work-thread.contributor-required');
        }
        return role === 'manager' ? allow('work-thread.manager') : deny('work-thread.manager-required');
      }
      case 'view_work_handoff':
      case 'accept_work_handoff':
      case 'manage_work_handoff': {
        read('work-handoff-grants');
        const role = contentRole<WorkGrantRole>(
          config.state.workHandoffGrants.filter((grant) => grant.workHandoffId === input.resource.id),
          personId,
          input.resource.spaceId,
          { contributor: 2, manager: 3, viewer: 1 },
        );
        if (input.permission === 'view_work_handoff') {
          return role ? allow('work-handoff.explicit-grant') : deny('work-handoff.grant-required');
        }
        if (input.permission === 'accept_work_handoff') {
          return role === 'contributor' || role === 'manager'
            ? allow('work-handoff.contributor')
            : deny('work-handoff.contributor-required');
        }
        return role === 'manager' ? allow('work-handoff.manager') : deny('work-handoff.manager-required');
      }
      default:
        return deny('organization.permission-unsupported');
    }
  };

  const resourcesFor = (query: AuthorizedResourceScopeQuery): readonly AuthorizationResource[] => {
    const spaceId = query.context.activeSpaceId;
    switch (query.resourceKind) {
      case 'space':
        read('personal-spaces');
        read('organizations');
        return [
          ...config.state.personalSpaces.map((space) => space.spaceId),
          ...config.state.organizations.map((space) => space.spaceId),
        ]
          .filter((id) => id === spaceId)
          .map((id) => ({ id, kind: 'space', spaceId }));
      case 'project':
        read('projects');
        return config.state.projects
          .filter((project) => project.spaceId === spaceId)
          .map((project) => ({ id: project.id, kind: 'project', spaceId }));
      case 'repository':
        read('repositories');
        return config.state.repositories
          .filter((repository) => repository.spaceId === spaceId)
          .map((repository) => ({ id: repository.id, kind: 'repository', spaceId }));
      case 'device':
        read('devices');
        return config.state.devices
          .filter((device) => device.spaceId === spaceId)
          .map((device) => ({ id: device.id, kind: 'device', spaceId }));
      case 'session':
        read('sessions');
        return config.state.sessions
          .filter((session) => session.spaceId === spaceId)
          .map((session) => ({ id: session.id, kind: 'session', spaceId }));
      case 'memory':
        read('memory-items');
        return config.state.memoryItems
          .filter((memory) => memory.spaceId === spaceId)
          .map((memory) => ({ id: memory.id, kind: 'memory', spaceId }));
      case 'work-thread':
        read('work-threads');
        return config.state.workThreads
          .filter((thread) => thread.spaceId === spaceId)
          .map((thread) => ({ id: thread.id, kind: 'work-thread', spaceId }));
      case 'work-handoff':
        read('work-handoffs');
        return config.state.workHandoffs
          .filter((handoff) => handoff.spaceId === spaceId)
          .map((handoff) => ({ id: handoff.id, kind: 'work-handoff', spaceId }));
      case 'usage-aggregate':
        if (query.permission === 'view_organization_usage_aggregate') {
          read('organizations');
          return config.state.organizations.some(
            (organization) => organization.spaceId === spaceId && organization.status === 'active',
          )
            ? [{ id: spaceId, kind: 'usage-aggregate', spaceId }]
            : [];
        }
        if (query.permission === 'view_project_usage_aggregate') {
          read('projects');
          return config.state.projects
            .filter((project) => project.spaceId === spaceId)
            .map((project) => ({ id: project.id, kind: 'usage-aggregate', spaceId }));
        }
        return [];
      default:
        return [];
    }
  };

  const loadAuthorizedResources = async (
    query: AuthorizedResourceScopeQuery,
    operation: AuthorizationOperation,
  ): Promise<AuthorizationUnavailable | readonly AuthorizationResource[]> => {
    if (!permissionSupportsResource(query.permission, query.resourceKind)) {
      return unavailable(operation, 'organization.permission-resource-mismatch', 'authorization-unsupported');
    }
    try {
      await config.checkAvailability?.(operation);
      return resourcesFor(query)
        .filter(
          (resource) =>
            evaluate({
              context: query.context,
              permission: query.permission,
              principal: query.principal,
              resource,
            }).kind === 'allow',
        )
        .sort((left, right) => left.id.localeCompare(right.id));
    } catch {
      return unavailable(operation, 'organization.adapter-unavailable');
    }
  };

  const check = async (input: AuthorizationCheck): Promise<AuthorizationDecision> => {
    try {
      await config.checkAvailability?.('check');
      return evaluate(input);
    } catch {
      return {
        error: unavailable('check', 'organization.adapter-unavailable'),
        kind: 'error',
      };
    }
  };

  const listResources = async (input: AuthorizedResourceListQuery): Promise<AuthorizedResourcePage> => {
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize <= 0 || input.pageSize > maximumPageSize) {
      return {
        error: unavailable('list-resources', 'organization.page-size-invalid', 'authorization-invalid-query'),
        kind: 'error',
      };
    }
    const personId = principalPersonId(input.principal);
    const cursor = decodeCursor(input.cursor);
    if (
      personId === null ||
      (input.cursor !== undefined &&
        input.cursor !== null &&
        (!cursor ||
          cursor.personId !== personId ||
          cursor.activeSpaceId !== input.context.activeSpaceId ||
          cursor.permission !== input.permission ||
          cursor.resourceKind !== input.resourceKind))
    ) {
      return {
        error: unavailable('list-resources', 'organization.cursor-invalid', 'authorization-invalid-query'),
        kind: 'error',
      };
    }
    const resources = await loadAuthorizedResources(input, 'list-resources');
    if ('code' in resources) {
      return { error: resources, kind: 'error' };
    }
    const afterId = cursor?.afterId ?? null;
    const eligible = afterId === null ? resources : resources.filter((resource) => resource.id > afterId);
    const items = eligible.slice(0, input.pageSize);
    const last = items.at(-1);
    return {
      items,
      kind: 'page',
      nextCursor:
        items.length < eligible.length && last
          ? encodeCursor({
              activeSpaceId: input.context.activeSpaceId,
              afterId: last.id,
              permission: input.permission,
              personId,
              resourceKind: input.resourceKind,
              version: 1,
            })
          : null,
    };
  };

  const materializeResourceScope = async (
    input: AuthorizedResourceScopeQuery,
  ): Promise<AuthorizedResourceScopeResult> => {
    const resources = await loadAuthorizedResources(input, 'materialize-resource-scope');
    if ('code' in resources) {
      return { error: resources, kind: 'error' };
    }
    return createAuthorizedResourceScope({
      activeSpaceId: input.context.activeSpaceId,
      permission: input.permission,
      resourceIds: resources.map((resource) => resource.id),
      resourceKind: input.resourceKind,
    });
  };

  return Object.freeze({ check, listResources, materializeResourceScope });
};
