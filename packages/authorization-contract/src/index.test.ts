import { describe, expect, test } from 'bun:test';
import { AUTHORIZATION_MODEL_VERSION, authorizationPermissions } from './index';

describe('portable authorization contract', () => {
  test('publishes one stable model version and a duplicate-free permission catalogue', () => {
    expect(AUTHORIZATION_MODEL_VERSION).toBe('authorization-v1');
    expect(new Set(authorizationPermissions).size).toBe(authorizationPermissions.length);
    expect(authorizationPermissions).toContain('view_memory');
    expect(authorizationPermissions).toContain('manage_memory');
  });
});
