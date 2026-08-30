import type { AuthorizationPermission, AuthorizationResourceKind } from './index';

export const permissionResourceKinds: Readonly<Record<AuthorizationPermission, readonly AuthorizationResourceKind[]>> =
  Object.freeze({
    accept_memory: ['memory'],
    accept_work_handoff: ['work-handoff'],
    archive_session_content: ['session'],
    create_work_handoff: ['project', 'space', 'work-thread'],
    link_repository: ['project', 'repository'],
    link_session_to_work_thread: ['session', 'work-thread'],
    manage_authorization: ['space'],
    manage_device: ['device', 'space'],
    manage_members: ['space'],
    manage_memory: ['memory'],
    manage_organization: ['space'],
    manage_project: ['project', 'space'],
    manage_repository_binding: ['project', 'repository', 'space'],
    manage_session_archive_policy: ['session', 'space'],
    manage_teams: ['space'],
    manage_work_handoff: ['work-handoff'],
    manage_work_thread: ['work-thread'],
    propose_memory: ['memory', 'project', 'space'],
    purge_session_archive: ['session'],
    revoke_device: ['device'],
    view_device: ['device'],
    view_memory: ['memory'],
    view_organization: ['space'],
    view_organization_usage_aggregate: ['usage-aggregate'],
    view_project: ['project'],
    view_project_usage_aggregate: ['usage-aggregate'],
    view_project_usage_detail: ['project'],
    view_repository_metadata: ['repository', 'space'],
    view_session_content: ['session'],
    view_session_metadata: ['session'],
    view_work_handoff: ['work-handoff'],
    view_work_thread: ['work-thread'],
  });

export const permissionSupportsResource = (
  permission: AuthorizationPermission,
  resourceKind: AuthorizationResourceKind,
): boolean => permissionResourceKinds[permission].includes(resourceKind);
