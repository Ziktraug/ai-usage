import { describe, expect, test } from 'bun:test';
import {
  createDeviceCredentialId,
  createDeviceId,
  createMemoryImportId,
  createMemoryItemId,
  createMemoryObservationId,
  createMemoryProposalId,
  createMemoryRelationId,
  createMemoryRevisionId,
  createPersonId,
  createProjectId,
  createSpaceId,
  instantNow,
  parseDeviceCredentialId,
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
  parseSpaceId,
} from './identity';

const identityErrorPattern = /platform identity value/u;

describe('platform identity values', () => {
  test('creates canonical opaque IDs and validates each nominal identity independently', () => {
    const spaceId = createSpaceId();
    const personId = createPersonId();
    const deviceId = createDeviceId();
    const projectId = createProjectId();
    const deviceCredentialId = createDeviceCredentialId();
    const memoryImportId = createMemoryImportId();
    const memoryItemId = createMemoryItemId();
    const memoryObservationId = createMemoryObservationId();
    const memoryProposalId = createMemoryProposalId();
    const memoryRelationId = createMemoryRelationId();
    const memoryRevisionId = createMemoryRevisionId();

    expect(parseSpaceId(spaceId)).toBe(spaceId);
    expect(parsePersonId(personId)).toBe(personId);
    expect(parseDeviceId(deviceId)).toBe(deviceId);
    expect(parseProjectId(projectId)).toBe(projectId);
    expect(parseDeviceCredentialId(deviceCredentialId)).toBe(deviceCredentialId);
    expect(parseMemoryImportId(memoryImportId)).toBe(memoryImportId);
    expect(parseMemoryItemId(memoryItemId)).toBe(memoryItemId);
    expect(parseMemoryObservationId(memoryObservationId)).toBe(memoryObservationId);
    expect(parseMemoryProposalId(memoryProposalId)).toBe(memoryProposalId);
    expect(parseMemoryRelationId(memoryRelationId)).toBe(memoryRelationId);
    expect(parseMemoryRevisionId(memoryRevisionId)).toBe(memoryRevisionId);
    expect(() => parseProjectId('/home/operator/project')).toThrow(identityErrorPattern);
    expect(() => parsePersonId('person@example.test')).toThrow(identityErrorPattern);
  });

  test('accepts only canonical UTC instants', () => {
    const instant = instantNow(() => new Date('2026-08-29T10:11:12.345Z'));
    expect(String(instant)).toBe('2026-08-29T10:11:12.345Z');
    expect(parseInstant(instant)).toBe(instant);
    expect(() => parseInstant('2026-08-29T10:11:12Z')).toThrow(identityErrorPattern);
  });
});
