import {
  createDeviceId,
  createPersonId,
  createProjectId,
  createRepositoryId,
  createScmInstallationId,
  createSpaceId,
  createTeamId,
} from '@ai-usage/platform-core/identity';
import type { AuthorizationCheck, AuthorizationDecision } from './index';
import { emptyOrganizationAuthorizationState, type OrganizationAuthorizationState } from './organization-model';

export interface AuthorizationGoldenScenario {
  readonly expected: Readonly<Record<'organization' | 'single-user', AuthorizationDecision['kind']>>;
  readonly input: AuthorizationCheck;
  readonly name: string;
}

export interface AuthorizationConformanceFixture {
  readonly identities: {
    readonly adminPersonId: ReturnType<typeof createPersonId>;
    readonly collaboratorPersonId: ReturnType<typeof createPersonId>;
    readonly localPersonId: ReturnType<typeof createPersonId>;
    readonly localSpaceId: ReturnType<typeof createSpaceId>;
    readonly organizationSpaceId: ReturnType<typeof createSpaceId>;
    readonly organizationProjectIds: readonly ReturnType<typeof createProjectId>[];
    readonly securityAuditorPersonId: ReturnType<typeof createPersonId>;
    readonly usageAuditorPersonId: ReturnType<typeof createPersonId>;
  };
  readonly scenarios: readonly AuthorizationGoldenScenario[];
  readonly state: OrganizationAuthorizationState;
}

const expected = (
  organization: AuthorizationDecision['kind'],
  singleUser: AuthorizationDecision['kind'] = 'deny',
): AuthorizationGoldenScenario['expected'] => ({ organization, 'single-user': singleUser });

export const createAuthorizationConformanceFixture = (): AuthorizationConformanceFixture => {
  const empty = emptyOrganizationAuthorizationState();
  const localSpaceId = createSpaceId();
  const otherPersonalSpaceId = createSpaceId();
  const organizationSpaceId = createSpaceId();
  const localPersonId = createPersonId();
  const otherPersonalPersonId = createPersonId();
  const memberPersonId = createPersonId();
  const collaboratorPersonId = createPersonId();
  const adminPersonId = createPersonId();
  const usageAuditorPersonId = createPersonId();
  const securityAuditorPersonId = createPersonId();
  const teamMemberPersonId = createPersonId();
  const outsiderPersonId = createPersonId();
  const parentTeamId = createTeamId();
  const childTeamId = createTeamId();
  const revokedTeamId = createTeamId();
  const localProjectId = createProjectId();
  const organizationProjectId = createProjectId();
  const nestedTeamProjectId = createProjectId();
  const revokedTeamProjectId = createProjectId();
  const ungrantedProjectId = createProjectId();
  const localRepositoryId = createRepositoryId();
  const organizationRepositoryId = createRepositoryId();
  const installationOnlyRepositoryId = createRepositoryId();
  const localDeviceId = createDeviceId();
  const organizationDeviceId = createDeviceId();
  const revokedDeviceId = createDeviceId();
  const installationId = createScmInstallationId();
  const localSessionId = crypto.randomUUID();
  const organizationSessionId = crypto.randomUUID();
  const organizationSessionWithoutContentId = crypto.randomUUID();
  const organizationCaptureByLocalDeviceId = crypto.randomUUID();
  const localMemoryId = crypto.randomUUID();
  const organizationMemoryId = crypto.randomUUID();
  const sensitiveMemoryId = crypto.randomUUID();
  const localWorkThreadId = crypto.randomUUID();
  const organizationWorkThreadId = crypto.randomUUID();
  const localWorkHandoffId = crypto.randomUUID();
  const organizationWorkHandoffId = crypto.randomUUID();
  const expiresAt: null = null;
  const active = 'active' as const;

  const state: OrganizationAuthorizationState = {
    ...empty,
    deviceManagers: [
      {
        deviceId: organizationDeviceId,
        expiresAt,
        personId: adminPersonId,
        spaceId: organizationSpaceId,
        status: active,
      },
    ],
    devices: [
      {
        id: localDeviceId,
        ownerPersonId: localPersonId,
        spaceId: localSpaceId,
        status: active,
      },
      {
        id: organizationDeviceId,
        ownerPersonId: collaboratorPersonId,
        spaceId: organizationSpaceId,
        status: active,
      },
      {
        id: revokedDeviceId,
        ownerPersonId: collaboratorPersonId,
        spaceId: organizationSpaceId,
        status: 'revoked',
      },
    ],
    memoryContentGrants: [
      {
        expiresAt,
        memoryId: organizationMemoryId,
        role: 'manager',
        spaceId: organizationSpaceId,
        status: active,
        subject: { kind: 'person', personId: collaboratorPersonId },
      },
      {
        expiresAt,
        memoryId: sensitiveMemoryId,
        role: 'viewer',
        spaceId: organizationSpaceId,
        status: active,
        subject: { kind: 'person', personId: collaboratorPersonId },
      },
    ],
    memoryItems: [
      {
        id: localMemoryId,
        ownerPersonId: localPersonId,
        projectId: localProjectId,
        requiresTrustedDevice: false,
        sensitivity: 'normal',
        spaceId: localSpaceId,
        status: active,
      },
      {
        id: organizationMemoryId,
        ownerPersonId: collaboratorPersonId,
        projectId: organizationProjectId,
        requiresTrustedDevice: false,
        sensitivity: 'normal',
        spaceId: organizationSpaceId,
        status: active,
      },
      {
        id: sensitiveMemoryId,
        ownerPersonId: collaboratorPersonId,
        projectId: organizationProjectId,
        requiresTrustedDevice: true,
        sensitivity: 'sensitive',
        spaceId: organizationSpaceId,
        status: active,
      },
    ],
    organizations: [{ spaceId: organizationSpaceId, status: active }],
    personalSpaces: [
      { ownerPersonId: localPersonId, spaceId: localSpaceId },
      { ownerPersonId: otherPersonalPersonId, spaceId: otherPersonalSpaceId },
    ],
    projectGrants: [
      {
        expiresAt,
        projectId: organizationProjectId,
        role: 'collaborator',
        spaceId: organizationSpaceId,
        status: active,
        subject: { kind: 'person', personId: collaboratorPersonId },
      },
      {
        expiresAt,
        projectId: organizationProjectId,
        role: 'maintainer',
        spaceId: organizationSpaceId,
        status: active,
        subject: { kind: 'person', personId: adminPersonId },
      },
      {
        expiresAt,
        projectId: nestedTeamProjectId,
        role: 'viewer',
        spaceId: organizationSpaceId,
        status: active,
        subject: { kind: 'team', teamId: parentTeamId },
      },
      {
        expiresAt,
        projectId: revokedTeamProjectId,
        role: 'viewer',
        spaceId: organizationSpaceId,
        status: 'revoked',
        subject: { kind: 'team', teamId: revokedTeamId },
      },
    ],
    projects: [
      {
        id: localProjectId,
        repositoryId: localRepositoryId,
        spaceId: localSpaceId,
        status: active,
      },
      {
        id: organizationProjectId,
        repositoryId: organizationRepositoryId,
        spaceId: organizationSpaceId,
        status: active,
      },
      { id: nestedTeamProjectId, repositoryId: null, spaceId: organizationSpaceId, status: active },
      { id: revokedTeamProjectId, repositoryId: null, spaceId: organizationSpaceId, status: active },
      { id: ungrantedProjectId, repositoryId: null, spaceId: organizationSpaceId, status: active },
    ],
    repositories: [
      { id: localRepositoryId, spaceId: localSpaceId, status: active },
      { id: organizationRepositoryId, spaceId: organizationSpaceId, status: active },
      { id: installationOnlyRepositoryId, spaceId: organizationSpaceId, status: active },
    ],
    repositoryGrants: [
      {
        expiresAt,
        repositoryId: organizationRepositoryId,
        role: 'viewer',
        spaceId: organizationSpaceId,
        status: active,
        subject: { kind: 'person', personId: collaboratorPersonId },
      },
      {
        expiresAt,
        repositoryId: organizationRepositoryId,
        role: 'maintainer',
        spaceId: organizationSpaceId,
        status: active,
        subject: { kind: 'person', personId: adminPersonId },
      },
    ],
    scmInstallationRepositoryGrants: [
      {
        expiresAt,
        installationId,
        repositoryId: installationOnlyRepositoryId,
        spaceId: organizationSpaceId,
        status: active,
      },
    ],
    sessionContentGrants: [
      {
        expiresAt,
        role: 'manager',
        sessionId: organizationSessionId,
        spaceId: organizationSpaceId,
        status: active,
        subject: { kind: 'person', personId: collaboratorPersonId },
      },
    ],
    sessionMetadataGrants: [],
    sessions: [
      {
        id: localSessionId,
        ownerPersonId: localPersonId,
        projectId: localProjectId,
        spaceId: localSpaceId,
        status: active,
      },
      {
        id: organizationSessionId,
        ownerPersonId: collaboratorPersonId,
        projectId: organizationProjectId,
        spaceId: organizationSpaceId,
        status: active,
      },
      {
        id: organizationSessionWithoutContentId,
        ownerPersonId: collaboratorPersonId,
        projectId: organizationProjectId,
        spaceId: organizationSpaceId,
        status: active,
      },
      {
        id: organizationCaptureByLocalDeviceId,
        ownerPersonId: localPersonId,
        projectId: null,
        spaceId: organizationSpaceId,
        status: active,
      },
    ],
    spaceMemberships: [
      ...[memberPersonId, collaboratorPersonId, teamMemberPersonId, localPersonId].map((personId) => ({
        personId,
        role: 'member' as const,
        spaceId: organizationSpaceId,
        status: active,
      })),
      { personId: adminPersonId, role: 'admin', spaceId: organizationSpaceId, status: active },
      {
        personId: usageAuditorPersonId,
        role: 'usage-auditor',
        spaceId: organizationSpaceId,
        status: active,
      },
      {
        personId: securityAuditorPersonId,
        role: 'security-auditor',
        spaceId: organizationSpaceId,
        status: active,
      },
    ],
    teamMemberships: [
      { personId: teamMemberPersonId, spaceId: organizationSpaceId, status: active, teamId: childTeamId },
      { personId: teamMemberPersonId, spaceId: organizationSpaceId, status: active, teamId: revokedTeamId },
    ],
    teamNestings: [
      {
        childTeamId,
        parentTeamId,
        spaceId: organizationSpaceId,
        status: active,
      },
    ],
    teams: [parentTeamId, childTeamId, revokedTeamId].map((id) => ({
      id,
      spaceId: organizationSpaceId,
      status: active,
    })),
    workHandoffGrants: [
      {
        expiresAt,
        role: 'manager',
        spaceId: organizationSpaceId,
        status: active,
        subject: { kind: 'person', personId: collaboratorPersonId },
        workHandoffId: organizationWorkHandoffId,
      },
    ],
    workHandoffs: [
      {
        id: localWorkHandoffId,
        projectId: localProjectId,
        spaceId: localSpaceId,
        status: 'accepted',
        workThreadId: localWorkThreadId,
      },
      {
        id: organizationWorkHandoffId,
        projectId: organizationProjectId,
        spaceId: organizationSpaceId,
        status: 'accepted',
        workThreadId: organizationWorkThreadId,
      },
    ],
    workThreadGrants: [
      {
        expiresAt,
        role: 'manager',
        spaceId: organizationSpaceId,
        status: active,
        subject: { kind: 'person', personId: collaboratorPersonId },
        workThreadId: organizationWorkThreadId,
      },
    ],
    workThreads: [
      {
        id: localWorkThreadId,
        projectId: localProjectId,
        spaceId: localSpaceId,
        status: active,
      },
      {
        id: organizationWorkThreadId,
        projectId: organizationProjectId,
        spaceId: organizationSpaceId,
        status: active,
      },
    ],
  };

  const person = (personId: ReturnType<typeof createPersonId>) => ({ kind: 'person' as const, personId });
  const context = (activeSpaceId: ReturnType<typeof createSpaceId>, trustedDevice = true) => ({
    activeSpaceId,
    trustedDevice,
  });
  const resource = (
    id: string,
    kind: AuthorizationCheck['resource']['kind'],
    spaceId: ReturnType<typeof createSpaceId>,
  ) => ({ id, kind, spaceId });
  const scenario = (
    name: string,
    input: AuthorizationCheck,
    organization: AuthorizationDecision['kind'],
    singleUser: AuthorizationDecision['kind'] = 'deny',
  ): AuthorizationGoldenScenario => ({ expected: expected(organization, singleUser), input, name });

  const permissionPairCases = [
    ['accept_memory', resource(organizationMemoryId, 'memory', organizationSpaceId), collaboratorPersonId],
    [
      'accept_work_handoff',
      resource(organizationWorkHandoffId, 'work-handoff', organizationSpaceId),
      collaboratorPersonId,
    ],
    ['archive_session_content', resource(organizationSessionId, 'session', organizationSpaceId), collaboratorPersonId],
    ['create_work_handoff', resource(organizationProjectId, 'project', organizationSpaceId), collaboratorPersonId],
    ['create_work_handoff', resource(organizationSpaceId, 'space', organizationSpaceId), memberPersonId],
    [
      'create_work_handoff',
      resource(organizationWorkThreadId, 'work-thread', organizationSpaceId),
      collaboratorPersonId,
    ],
    ['link_repository', resource(organizationProjectId, 'project', organizationSpaceId), adminPersonId],
    ['link_repository', resource(organizationRepositoryId, 'repository', organizationSpaceId), adminPersonId],
    [
      'link_session_to_work_thread',
      resource(organizationSessionWithoutContentId, 'session', organizationSpaceId),
      collaboratorPersonId,
    ],
    [
      'link_session_to_work_thread',
      resource(organizationWorkThreadId, 'work-thread', organizationSpaceId),
      collaboratorPersonId,
    ],
    ['manage_authorization', resource(organizationSpaceId, 'space', organizationSpaceId), adminPersonId],
    ['manage_device', resource(organizationDeviceId, 'device', organizationSpaceId), collaboratorPersonId],
    ['manage_device', resource(organizationSpaceId, 'space', organizationSpaceId), adminPersonId],
    ['manage_members', resource(organizationSpaceId, 'space', organizationSpaceId), adminPersonId],
    ['manage_memory', resource(organizationMemoryId, 'memory', organizationSpaceId), collaboratorPersonId],
    ['manage_organization', resource(organizationSpaceId, 'space', organizationSpaceId), adminPersonId],
    ['manage_project', resource(organizationProjectId, 'project', organizationSpaceId), adminPersonId],
    ['manage_project', resource(localSpaceId, 'space', localSpaceId), localPersonId, true],
    ['manage_repository_binding', resource(organizationProjectId, 'project', organizationSpaceId), adminPersonId],
    ['manage_repository_binding', resource(organizationRepositoryId, 'repository', organizationSpaceId), adminPersonId],
    ['manage_repository_binding', resource(localSpaceId, 'space', localSpaceId), localPersonId, true],
    [
      'manage_session_archive_policy',
      resource(organizationSessionId, 'session', organizationSpaceId),
      collaboratorPersonId,
    ],
    ['manage_session_archive_policy', resource(organizationSpaceId, 'space', organizationSpaceId), adminPersonId],
    ['manage_teams', resource(organizationSpaceId, 'space', organizationSpaceId), adminPersonId],
    [
      'manage_work_handoff',
      resource(organizationWorkHandoffId, 'work-handoff', organizationSpaceId),
      collaboratorPersonId,
    ],
    [
      'manage_work_thread',
      resource(organizationWorkThreadId, 'work-thread', organizationSpaceId),
      collaboratorPersonId,
    ],
    ['propose_memory', resource(organizationMemoryId, 'memory', organizationSpaceId), collaboratorPersonId],
    ['propose_memory', resource(organizationProjectId, 'project', organizationSpaceId), collaboratorPersonId],
    ['propose_memory', resource(organizationSpaceId, 'space', organizationSpaceId), memberPersonId],
    ['purge_session_archive', resource(organizationSessionId, 'session', organizationSpaceId), collaboratorPersonId],
    ['revoke_device', resource(organizationDeviceId, 'device', organizationSpaceId), collaboratorPersonId],
    ['view_device', resource(organizationDeviceId, 'device', organizationSpaceId), collaboratorPersonId],
    ['view_memory', resource(organizationMemoryId, 'memory', organizationSpaceId), collaboratorPersonId],
    ['view_organization', resource(organizationSpaceId, 'space', organizationSpaceId), memberPersonId],
    [
      'view_organization_usage_aggregate',
      resource(organizationSpaceId, 'usage-aggregate', organizationSpaceId),
      usageAuditorPersonId,
    ],
    ['view_project', resource(organizationProjectId, 'project', organizationSpaceId), collaboratorPersonId],
    [
      'view_project_usage_aggregate',
      resource(organizationProjectId, 'usage-aggregate', organizationSpaceId),
      usageAuditorPersonId,
    ],
    [
      'view_project_usage_detail',
      resource(organizationProjectId, 'project', organizationSpaceId),
      collaboratorPersonId,
    ],
    [
      'view_repository_metadata',
      resource(organizationRepositoryId, 'repository', organizationSpaceId),
      collaboratorPersonId,
    ],
    ['view_repository_metadata', resource(localSpaceId, 'space', localSpaceId), localPersonId, true],
    ['view_session_content', resource(organizationSessionId, 'session', organizationSpaceId), collaboratorPersonId],
    [
      'view_session_metadata',
      resource(organizationSessionWithoutContentId, 'session', organizationSpaceId),
      collaboratorPersonId,
    ],
    [
      'view_work_handoff',
      resource(organizationWorkHandoffId, 'work-handoff', organizationSpaceId),
      collaboratorPersonId,
    ],
    ['view_work_thread', resource(organizationWorkThreadId, 'work-thread', organizationSpaceId), collaboratorPersonId],
  ] as const satisfies readonly [
    AuthorizationCheck['permission'],
    AuthorizationCheck['resource'],
    ReturnType<typeof createPersonId>,
    boolean?,
  ][];

  const permissionPairScenarios = permissionPairCases.flatMap(
    ([permission, targetResource, allowedPersonId, allowInSingleUser = false]) => [
      scenario(
        `permission pair allows ${permission}:${targetResource.kind}`,
        {
          context: context(targetResource.spaceId),
          permission,
          principal: person(allowedPersonId),
          resource: targetResource,
        },
        'allow',
        allowInSingleUser ? 'allow' : 'deny',
      ),
      scenario(
        `permission pair denies unrelated principal for ${permission}:${targetResource.kind}`,
        {
          context: context(targetResource.spaceId),
          permission,
          principal: person(allowInSingleUser ? otherPersonalPersonId : outsiderPersonId),
          resource: targetResource,
        },
        'deny',
      ),
    ],
  );

  const scenarios: readonly AuthorizationGoldenScenario[] = [
    scenario(
      'local operator sees the personal Project',
      {
        context: context(localSpaceId),
        permission: 'view_project',
        principal: person(localPersonId),
        resource: resource(localProjectId, 'project', localSpaceId),
      },
      'allow',
      'allow',
    ),
    scenario(
      'local operator sees personal Memory',
      {
        context: context(localSpaceId),
        permission: 'view_memory',
        principal: person(localPersonId),
        resource: resource(localMemoryId, 'memory', localSpaceId),
      },
      'allow',
      'allow',
    ),
    scenario(
      'local operator sees personal Work handoff',
      {
        context: context(localSpaceId),
        permission: 'view_work_handoff',
        principal: person(localPersonId),
        resource: resource(localWorkHandoffId, 'work-handoff', localSpaceId),
      },
      'allow',
      'allow',
    ),
    scenario(
      'organization member cannot see another personal Space',
      {
        context: context(otherPersonalSpaceId),
        permission: 'view_project',
        principal: person(memberPersonId),
        resource: resource(localProjectId, 'project', otherPersonalSpaceId),
      },
      'deny',
    ),
    scenario(
      'Project collaborator sees the Project',
      {
        context: context(organizationSpaceId),
        permission: 'view_project',
        principal: person(collaboratorPersonId),
        resource: resource(organizationProjectId, 'project', organizationSpaceId),
      },
      'allow',
    ),
    scenario(
      'Project collaborator sees linked Session metadata',
      {
        context: context(organizationSpaceId),
        permission: 'view_session_metadata',
        principal: person(collaboratorPersonId),
        resource: resource(organizationSessionWithoutContentId, 'session', organizationSpaceId),
      },
      'allow',
    ),
    scenario(
      'Project collaborator sees only explicitly granted Session content',
      {
        context: context(organizationSpaceId),
        permission: 'view_session_content',
        principal: person(collaboratorPersonId),
        resource: resource(organizationSessionId, 'session', organizationSpaceId),
      },
      'allow',
    ),
    scenario(
      'Project collaborator is denied ungranted Session content',
      {
        context: context(organizationSpaceId),
        permission: 'view_session_content',
        principal: person(collaboratorPersonId),
        resource: resource(organizationSessionWithoutContentId, 'session', organizationSpaceId),
      },
      'deny',
    ),
    scenario(
      'organization admin manages membership',
      {
        context: context(organizationSpaceId),
        permission: 'manage_members',
        principal: person(adminPersonId),
        resource: resource(organizationSpaceId, 'space', organizationSpaceId),
      },
      'allow',
    ),
    scenario(
      'organization admin has no implicit Session content',
      {
        context: context(organizationSpaceId),
        permission: 'view_session_content',
        principal: person(adminPersonId),
        resource: resource(organizationSessionId, 'session', organizationSpaceId),
      },
      'deny',
    ),
    scenario(
      'usage auditor sees organization aggregate',
      {
        context: context(organizationSpaceId),
        permission: 'view_organization_usage_aggregate',
        principal: person(usageAuditorPersonId),
        resource: resource(organizationSpaceId, 'usage-aggregate', organizationSpaceId),
      },
      'allow',
    ),
    ...[
      ['view_session_metadata', organizationSessionId, 'session'],
      ['view_session_content', organizationSessionId, 'session'],
      ['view_memory', organizationMemoryId, 'memory'],
      ['view_work_handoff', organizationWorkHandoffId, 'work-handoff'],
    ].map(([permission, id, kind]) =>
      scenario(
        `usage auditor is denied ${permission}`,
        {
          context: context(organizationSpaceId),
          permission: permission as AuthorizationCheck['permission'],
          principal: person(usageAuditorPersonId),
          resource: resource(id ?? '', kind as AuthorizationCheck['resource']['kind'], organizationSpaceId),
        },
        'deny',
      ),
    ),
    scenario(
      'security auditor sees repository metadata',
      {
        context: context(organizationSpaceId),
        permission: 'view_repository_metadata',
        principal: person(securityAuditorPersonId),
        resource: resource(organizationRepositoryId, 'repository', organizationSpaceId),
      },
      'allow',
    ),
    scenario(
      'security auditor sees Session metadata',
      {
        context: context(organizationSpaceId),
        permission: 'view_session_metadata',
        principal: person(securityAuditorPersonId),
        resource: resource(organizationSessionId, 'session', organizationSpaceId),
      },
      'allow',
    ),
    scenario(
      'security auditor is denied Session content',
      {
        context: context(organizationSpaceId),
        permission: 'view_session_content',
        principal: person(securityAuditorPersonId),
        resource: resource(organizationSessionId, 'session', organizationSpaceId),
      },
      'deny',
    ),
    scenario(
      'one bounded nested Team grant is effective',
      {
        context: context(organizationSpaceId),
        permission: 'view_project',
        principal: person(teamMemberPersonId),
        resource: resource(nestedTeamProjectId, 'project', organizationSpaceId),
      },
      'allow',
    ),
    scenario(
      'revoked Team grant is ineffective',
      {
        context: context(organizationSpaceId),
        permission: 'view_project',
        principal: person(teamMemberPersonId),
        resource: resource(revokedTeamProjectId, 'project', organizationSpaceId),
      },
      'deny',
    ),
    scenario(
      'active Space mismatch fails closed',
      {
        context: context(localSpaceId),
        permission: 'view_project',
        principal: person(collaboratorPersonId),
        resource: resource(organizationProjectId, 'project', organizationSpaceId),
      },
      'deny',
    ),
    scenario(
      'one Device owner does not gain organization capture content',
      {
        context: context(organizationSpaceId),
        permission: 'view_session_content',
        principal: person(localPersonId),
        resource: resource(organizationCaptureByLocalDeviceId, 'session', organizationSpaceId),
      },
      'deny',
    ),
    scenario(
      'revoked Device provenance stays visible to its owner',
      {
        context: context(organizationSpaceId),
        permission: 'view_device',
        principal: person(collaboratorPersonId),
        resource: resource(revokedDeviceId, 'device', organizationSpaceId),
      },
      'allow',
    ),
    scenario(
      'revoked Device cannot be managed by its owner',
      {
        context: context(organizationSpaceId),
        permission: 'manage_device',
        principal: person(collaboratorPersonId),
        resource: resource(revokedDeviceId, 'device', organizationSpaceId),
      },
      'deny',
    ),
    scenario(
      'sensitive Memory requires a trusted Device',
      {
        context: context(organizationSpaceId, false),
        permission: 'view_memory',
        principal: person(collaboratorPersonId),
        resource: resource(sensitiveMemoryId, 'memory', organizationSpaceId),
      },
      'deny',
    ),
    scenario(
      'sensitive Memory is visible after the trusted-Device condition',
      {
        context: context(organizationSpaceId),
        permission: 'view_memory',
        principal: person(collaboratorPersonId),
        resource: resource(sensitiveMemoryId, 'memory', organizationSpaceId),
      },
      'allow',
    ),
    scenario(
      'SCM installation grant is not a Person repository permission',
      {
        context: context(organizationSpaceId),
        permission: 'view_repository_metadata',
        principal: person(outsiderPersonId),
        resource: resource(installationOnlyRepositoryId, 'repository', organizationSpaceId),
      },
      'deny',
    ),
    ...permissionPairScenarios,
  ];

  return {
    identities: {
      adminPersonId,
      collaboratorPersonId,
      localPersonId,
      localSpaceId,
      organizationProjectIds: [organizationProjectId, nestedTeamProjectId, revokedTeamProjectId, ungrantedProjectId],
      organizationSpaceId,
      securityAuditorPersonId,
      usageAuditorPersonId,
    },
    scenarios,
    state,
  };
};
