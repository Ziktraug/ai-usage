import { describe, expect, test } from 'bun:test';
import { permissionResourceKinds } from '@ai-usage/authorization/permission-resource';
import { AUTHORIZATION_TEAM_MAXIMUM_DEPTH, authorizationScopeSql } from './authorization-query';

const limitPattern = /\bLIMIT\b/iu;
const contentRelationPattern = /session_|memory_|work_handoff_|work_thread_/u;

describe('explicit PostgreSQL authorization queries', () => {
  test('implements every frozen permission/resource pair without a generic relation interpreter', () => {
    for (const [permission, resourceKinds] of Object.entries(permissionResourceKinds)) {
      for (const resourceKind of resourceKinds) {
        const query = authorizationScopeSql(permission as keyof typeof permissionResourceKinds, resourceKind);
        expect(query, `${permission}:${resourceKind}`).not.toBeNull();
        expect(query).not.toContain('authorization_relations');
        expect(query).not.toMatch(limitPattern);
      }
    }
  });

  test('keeps aggregate authorization independent from every content relation', () => {
    for (const [permission, kind] of [
      ['view_organization_usage_aggregate', 'usage-aggregate'],
      ['view_project_usage_aggregate', 'usage-aggregate'],
    ] as const) {
      const query = authorizationScopeSql(permission, kind);
      expect(query).not.toBeNull();
      expect(query).not.toMatch(contentRelationPattern);
    }
  });

  test('bounds the one domain-specific recursive Team relation and rejects cycles in-query', () => {
    const query = authorizationScopeSql('view_project', 'project');
    expect(AUTHORIZATION_TEAM_MAXIMUM_DEPTH).toBe(3);
    expect(query).toContain('et.depth < 3');
    expect(query).toContain('NOT tn.parent_team_id = ANY(et.path)');
  });
});
