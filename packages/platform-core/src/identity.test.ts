import { describe, expect, test } from 'bun:test';
import {
  createAuthenticationIdentityId,
  createDeviceCredentialId,
  createDeviceEnrollmentGrantId,
  createDeviceId,
  createMemoryImportId,
  createMemoryItemId,
  createMemoryObservationId,
  createMemoryProposalId,
  createMemoryRelationId,
  createMemoryRevisionId,
  createPersonId,
  createProjectId,
  createReplicationOutboxEventId,
  createSpaceId,
  createTeamId,
  createWebSessionId,
  hasExactlyOneScmCredentialOwner,
  instantNow,
  parseAuthenticationIdentityId,
  parseDeviceCredentialId,
  parseDeviceEnrollmentGrantId,
  parseDeviceId,
  parseInstant,
  parseMemoryImportId,
  parseMemoryItemId,
  parseMemoryObservationId,
  parseMemoryProposalId,
  parseMemoryRelationId,
  parseMemoryRevisionId,
  parsePersonId,
  parseProjectId,
  parseReplicationOutboxEventId,
  parseScmAccountId,
  parseScmInstallationId,
  parseSpaceId,
  parseTeamId,
  parseWebSessionId,
} from './identity';

const identityErrorPattern = /platform identity value/u;

describe('platform identity values', () => {
  test('creates canonical opaque IDs and validates each nominal identity independently', () => {
    const spaceId = createSpaceId();
    const personId = createPersonId();
    const deviceId = createDeviceId();
    const projectId = createProjectId();
    const teamId = createTeamId();
    const authenticationIdentityId = createAuthenticationIdentityId();
    const deviceCredentialId = createDeviceCredentialId();
    const deviceEnrollmentGrantId = createDeviceEnrollmentGrantId();
    const webSessionId = createWebSessionId();
    const memoryImportId = createMemoryImportId();
    const memoryItemId = createMemoryItemId();
    const memoryObservationId = createMemoryObservationId();
    const memoryProposalId = createMemoryProposalId();
    const memoryRelationId = createMemoryRelationId();
    const memoryRevisionId = createMemoryRevisionId();
    const replicationOutboxEventId = createReplicationOutboxEventId();

    expect(parseSpaceId(spaceId)).toBe(spaceId);
    expect(parsePersonId(personId)).toBe(personId);
    expect(parseDeviceId(deviceId)).toBe(deviceId);
    expect(parseProjectId(projectId)).toBe(projectId);
    expect(parseTeamId(teamId)).toBe(teamId);
    expect(parseAuthenticationIdentityId(authenticationIdentityId)).toBe(authenticationIdentityId);
    expect(parseDeviceCredentialId(deviceCredentialId)).toBe(deviceCredentialId);
    expect(parseDeviceEnrollmentGrantId(deviceEnrollmentGrantId)).toBe(deviceEnrollmentGrantId);
    expect(parseWebSessionId(webSessionId)).toBe(webSessionId);
    expect(parseMemoryImportId(memoryImportId)).toBe(memoryImportId);
    expect(parseMemoryItemId(memoryItemId)).toBe(memoryItemId);
    expect(parseMemoryObservationId(memoryObservationId)).toBe(memoryObservationId);
    expect(parseMemoryProposalId(memoryProposalId)).toBe(memoryProposalId);
    expect(parseMemoryRelationId(memoryRelationId)).toBe(memoryRelationId);
    expect(parseMemoryRevisionId(memoryRevisionId)).toBe(memoryRevisionId);
    expect(parseReplicationOutboxEventId(replicationOutboxEventId)).toBe(replicationOutboxEventId);
    expect(() => parseProjectId('/home/operator/project')).toThrow(identityErrorPattern);
    expect(() => parsePersonId('person@example.test')).toThrow(identityErrorPattern);
  });

  test('accepts only canonical UTC instants', () => {
    const instant = instantNow(() => new Date('2026-08-29T10:11:12.345Z'));
    expect(String(instant)).toBe('2026-08-29T10:11:12.345Z');
    expect(parseInstant(instant)).toBe(instant);
    expect(() => parseInstant('2026-08-29T10:11:12Z')).toThrow(identityErrorPattern);
  });

  test('requires exactly one SCM credential owner', () => {
    const accountId = parseScmAccountId('0198f179-4837-7000-8000-000000000001');
    const installationId = parseScmInstallationId('0198f179-4837-7000-8000-000000000002');
    expect(hasExactlyOneScmCredentialOwner({ accountId, installationId: null })).toBe(true);
    expect(hasExactlyOneScmCredentialOwner({ accountId: null, installationId })).toBe(true);
    expect(hasExactlyOneScmCredentialOwner({ accountId: null, installationId: null })).toBe(false);
    expect(hasExactlyOneScmCredentialOwner({ accountId, installationId })).toBe(false);
  });
});
