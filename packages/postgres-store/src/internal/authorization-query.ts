import type { AuthorizationPermission, AuthorizationResourceKind } from '@ai-usage/authorization';

export const AUTHORIZATION_TEAM_MAXIMUM_DEPTH = 3;

const effectiveTeamsCte = `
  WITH RECURSIVE effective_teams(team_id, depth, path) AS (
    SELECT tm.team_id, 1, ARRAY[tm.team_id]
    FROM team_memberships tm
    JOIN teams t ON t.id = tm.team_id AND t.space_id = tm.space_id
    WHERE tm.space_id = $1
      AND tm.person_id = $2
      AND tm.status = 'active'
      AND t.status = 'active'
    UNION ALL
    SELECT tn.parent_team_id, et.depth + 1, et.path || tn.parent_team_id
    FROM effective_teams et
    JOIN team_nestings tn
      ON tn.child_team_id = et.team_id
     AND tn.space_id = $1
     AND tn.status = 'active'
    JOIN teams parent
      ON parent.id = tn.parent_team_id
     AND parent.space_id = tn.space_id
     AND parent.status = 'active'
    WHERE et.depth < ${AUTHORIZATION_TEAM_MAXIMUM_DEPTH}
      AND NOT tn.parent_team_id = ANY(et.path)
  )
`;

const personalOwner = `
  EXISTS (
    SELECT 1
    FROM people personal_owner
    WHERE personal_owner.id = $2
      AND personal_owner.personal_space_id = $1
      AND personal_owner.status = 'active'
  )
`;

const activeOrganization = `
  EXISTS (
    SELECT 1
    FROM organizations active_organization
    WHERE active_organization.space_id = $1
      AND active_organization.status = 'active'
  )
`;

const membership = (roles?: readonly string[]): string => `
  EXISTS (
    SELECT 1
    FROM space_memberships membership
    WHERE membership.space_id = $1
      AND membership.person_id = $2
      AND membership.status = 'active'
      ${roles ? `AND membership.role IN (${roles.map((role) => `'${role}'`).join(', ')})` : ''}
  )
`;

const grantSubject = (alias: string): string => `
  (${alias}.person_id = $2 OR ${alias}.team_id IN (SELECT team_id FROM effective_teams))
`;

const activeGrant = (alias: string): string => `
  ${alias}.status = 'active'
  AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > now())
`;

const projectGrant = (alias: string, roles: readonly string[]): string => `
  EXISTS (
    SELECT 1
    FROM project_grants ${alias}
    WHERE ${alias}.space_id = p.space_id
      AND ${alias}.project_id = p.id
      AND ${activeGrant(alias)}
      AND ${grantSubject(alias)}
      AND ${alias}.role IN (${roles.map((role) => `'${role}'`).join(', ')})
  )
`;

const repositoryGrant = (roles: readonly string[]): string => `
  EXISTS (
    SELECT 1
    FROM repository_grants repository_grant
    WHERE repository_grant.space_id = repository.space_id
      AND repository_grant.repository_id = repository.id
      AND ${activeGrant('repository_grant')}
      AND ${grantSubject('repository_grant')}
      AND repository_grant.role IN (${roles.map((role) => `'${role}'`).join(', ')})
  )
`;

const contentGrant = (
  table: 'memory_content_grants' | 'session_content_grants' | 'work_handoff_grants' | 'work_thread_grants',
  resourceColumn: 'memory_id' | 'session_id' | 'work_handoff_id' | 'work_thread_id',
  resourceAlias: string,
  roles: readonly string[],
): string => `
  EXISTS (
    SELECT 1
    FROM ${table} content_grant
    WHERE content_grant.space_id = ${resourceAlias}.space_id
      AND content_grant.${resourceColumn} = ${resourceAlias}.id
      AND ${activeGrant('content_grant')}
      AND ${grantSubject('content_grant')}
      AND content_grant.role IN (${roles.map((role) => `'${role}'`).join(', ')})
  )
`;

const projectScopeSql = (permission: AuthorizationPermission): string | null => {
  let organizationRule: string;
  switch (permission) {
    case 'view_project':
      organizationRule = projectGrant('project_grant', ['viewer', 'collaborator', 'maintainer']);
      break;
    case 'view_project_usage_detail':
    case 'propose_memory':
    case 'create_work_handoff':
      organizationRule = projectGrant('project_grant', ['collaborator', 'maintainer']);
      break;
    case 'manage_project':
    case 'link_repository':
    case 'manage_repository_binding':
      organizationRule = projectGrant('project_grant', ['maintainer']);
      break;
    default:
      return null;
  }
  return `
    SELECT p.id
    FROM projects p
    WHERE p.space_id = $1
      AND (${personalOwner} OR (${activeOrganization} AND ${organizationRule}))
  `;
};

const projectAggregateScopeSql = (permission: AuthorizationPermission): string | null => {
  if (permission !== 'view_project_usage_aggregate') {
    return null;
  }
  return `
    SELECT p.id
    FROM projects p
    WHERE p.space_id = $1
      AND (
        ${personalOwner}
        OR (
          ${activeOrganization}
          AND (
            ${membership(['usage-auditor'])}
            OR ${projectGrant('project_aggregate_grant', ['viewer', 'collaborator', 'maintainer'])}
          )
        )
      )
  `;
};

const organizationAggregateScopeSql = (permission: AuthorizationPermission): string | null => {
  if (permission !== 'view_organization_usage_aggregate') {
    return null;
  }
  return `
    SELECT organization.space_id AS id
    FROM organizations organization
    WHERE organization.space_id = $1
      AND organization.status = 'active'
      AND ${membership(['usage-auditor'])}
  `;
};

const spaceScopeSql = (permission: AuthorizationPermission): string | null => {
  let rule: string;
  switch (permission) {
    case 'view_organization':
      rule = `${activeOrganization} AND ${membership()}`;
      break;
    case 'manage_organization':
    case 'manage_members':
    case 'manage_teams':
    case 'manage_authorization':
      rule = `${activeOrganization} AND ${membership(['admin'])}`;
      break;
    case 'manage_device':
      rule = `${personalOwner} OR (${activeOrganization} AND ${membership(['admin'])})`;
      break;
    case 'manage_session_archive_policy':
      rule = `${personalOwner} OR (${activeOrganization} AND ${membership(['admin'])})`;
      break;
    case 'propose_memory':
    case 'create_work_handoff':
      rule = `${personalOwner} OR (${activeOrganization} AND ${membership()})`;
      break;
    case 'manage_project':
    case 'manage_repository_binding':
    case 'view_repository_metadata':
      rule = personalOwner;
      break;
    default:
      return null;
  }
  return `SELECT space.id FROM spaces space WHERE space.id = $1 AND (${rule})`;
};

const repositoryScopeSql = (permission: AuthorizationPermission): string | null => {
  let organizationRule: string;
  switch (permission) {
    case 'view_repository_metadata':
      organizationRule = `
        ${membership(['security-auditor'])}
        OR ${repositoryGrant(['viewer', 'maintainer'])}
        OR EXISTS (
          SELECT 1
          FROM projects p
          WHERE p.space_id = repository.space_id
            AND p.repository_id = repository.id
            AND ${projectGrant('linked_project_grant', ['viewer', 'collaborator', 'maintainer'])}
        )
      `;
      break;
    case 'link_repository':
    case 'manage_repository_binding':
      organizationRule = repositoryGrant(['maintainer']);
      break;
    default:
      return null;
  }
  return `
    SELECT repository.id
    FROM repositories repository
    WHERE repository.space_id = $1
      AND (${personalOwner} OR (${activeOrganization} AND (${organizationRule})))
  `;
};

const deviceScopeSql = (permission: AuthorizationPermission): string | null => {
  if (permission !== 'view_device' && permission !== 'manage_device' && permission !== 'revoke_device') {
    return null;
  }
  const securityRule = permission === 'view_device' ? `OR ${membership(['security-auditor'])}` : '';
  const activeDevice = permission === 'view_device' ? '' : "AND device.status <> 'revoked'";
  return `
    SELECT device.id
    FROM devices device
    WHERE device.space_id = $1
      ${activeDevice}
      AND (
        ${personalOwner}
        OR (
          ${activeOrganization}
          AND (
            device.owner_person_id = $2
            OR EXISTS (
              SELECT 1
              FROM device_managers manager
              WHERE manager.space_id = device.space_id
                AND manager.device_id = device.id
                AND manager.person_id = $2
                AND ${activeGrant('manager')}
            )
            ${securityRule}
          )
        )
      )
  `;
};

const sessionMetadataRule = `
  ${membership(['security-auditor'])}
  OR EXISTS (
    SELECT 1
    FROM session_metadata_grants metadata_grant
    WHERE metadata_grant.space_id = session_scope.space_id
      AND metadata_grant.session_id = session_scope.id
      AND ${activeGrant('metadata_grant')}
      AND ${grantSubject('metadata_grant')}
  )
  OR EXISTS (
    SELECT 1
    FROM projects p
    WHERE p.id = session_scope.project_id
      AND p.space_id = session_scope.space_id
      AND ${projectGrant('session_project_grant', ['collaborator', 'maintainer'])}
  )
`;

const sessionScopeSql = (permission: AuthorizationPermission): string | null => {
  let organizationRule: string;
  switch (permission) {
    case 'view_session_metadata':
    case 'link_session_to_work_thread':
      organizationRule = sessionMetadataRule;
      break;
    case 'view_session_content':
      organizationRule = contentGrant('session_content_grants', 'session_id', 'session_scope', [
        'viewer',
        'editor',
        'manager',
      ]);
      break;
    case 'archive_session_content':
      organizationRule = contentGrant('session_content_grants', 'session_id', 'session_scope', ['editor', 'manager']);
      break;
    case 'manage_session_archive_policy':
    case 'purge_session_archive':
      organizationRule = contentGrant('session_content_grants', 'session_id', 'session_scope', ['manager']);
      break;
    default:
      return null;
  }
  const contentStatus = permission === 'view_session_metadata' ? '' : "AND session_scope.status <> 'purged'";
  return `
    SELECT session_scope.id
    FROM session_authorization_scopes session_scope
    WHERE session_scope.space_id = $1
      ${contentStatus}
      AND (${personalOwner} OR (${activeOrganization} AND (${organizationRule})))
  `;
};

const memoryScopeSql = (permission: AuthorizationPermission): string | null => {
  let roles: readonly string[];
  switch (permission) {
    case 'view_memory':
      roles = ['viewer', 'proposer', 'manager'];
      break;
    case 'propose_memory':
      roles = ['proposer', 'manager'];
      break;
    case 'accept_memory':
    case 'manage_memory':
      roles = ['manager'];
      break;
    default:
      return null;
  }
  return `
    SELECT memory_scope.id
    FROM memory_authorization_scopes memory_scope
    WHERE memory_scope.space_id = $1
      AND memory_scope.status = 'active'
      AND ($3::BOOLEAN OR NOT memory_scope.requires_trusted_device)
      AND (
        ${personalOwner}
        OR (
          ${activeOrganization}
          AND ${contentGrant('memory_content_grants', 'memory_id', 'memory_scope', roles)}
        )
      )
  `;
};

const workThreadScopeSql = (permission: AuthorizationPermission): string | null => {
  let roles: readonly string[];
  switch (permission) {
    case 'view_work_thread':
      roles = ['viewer', 'contributor', 'manager'];
      break;
    case 'create_work_handoff':
      roles = ['contributor', 'manager'];
      break;
    case 'manage_work_thread':
    case 'link_session_to_work_thread':
      roles = ['manager'];
      break;
    default:
      return null;
  }
  return `
    SELECT work_thread_scope.id
    FROM work_thread_authorization_scopes work_thread_scope
    WHERE work_thread_scope.space_id = $1
      AND (
        ${personalOwner}
        OR (
          ${activeOrganization}
          AND ${contentGrant('work_thread_grants', 'work_thread_id', 'work_thread_scope', roles)}
        )
      )
  `;
};

const workHandoffScopeSql = (permission: AuthorizationPermission): string | null => {
  let roles: readonly string[];
  switch (permission) {
    case 'view_work_handoff':
      roles = ['viewer', 'contributor', 'manager'];
      break;
    case 'accept_work_handoff':
      roles = ['contributor', 'manager'];
      break;
    case 'manage_work_handoff':
      roles = ['manager'];
      break;
    default:
      return null;
  }
  return `
    SELECT work_handoff_scope.id
    FROM work_handoff_authorization_scopes work_handoff_scope
    WHERE work_handoff_scope.space_id = $1
      AND (
        ${personalOwner}
        OR (
          ${activeOrganization}
          AND ${contentGrant('work_handoff_grants', 'work_handoff_id', 'work_handoff_scope', roles)}
        )
      )
  `;
};

export const authorizationScopeSql = (
  permission: AuthorizationPermission,
  resourceKind: AuthorizationResourceKind,
): string | null => {
  let body: string | null;
  switch (resourceKind) {
    case 'space':
      body = spaceScopeSql(permission);
      break;
    case 'project':
      body = projectScopeSql(permission);
      break;
    case 'usage-aggregate':
      body =
        permission === 'view_organization_usage_aggregate'
          ? organizationAggregateScopeSql(permission)
          : projectAggregateScopeSql(permission);
      break;
    case 'repository':
      body = repositoryScopeSql(permission);
      break;
    case 'device':
      body = deviceScopeSql(permission);
      break;
    case 'session':
      body = sessionScopeSql(permission);
      break;
    case 'memory':
      body = memoryScopeSql(permission);
      break;
    case 'work-thread':
      body = workThreadScopeSql(permission);
      break;
    case 'work-handoff':
      body = workHandoffScopeSql(permission);
      break;
    default:
      body = null;
  }
  return body === null
    ? null
    : `${effectiveTeamsCte}, authorization_context AS (SELECT $3::BOOLEAN AS trusted_device), authorized_resources AS (${body}) SELECT DISTINCT id FROM authorized_resources`;
};
