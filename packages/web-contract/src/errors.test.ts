import { describe, expect, test } from 'bun:test';
import { safeParse } from 'valibot';
import { isPublicErrorFamily, publicErrorFamilies, publicErrorMap, publicErrorSchema } from './errors';

describe('closed public errors', () => {
  test('freezes every public family required by the operation inventory', () => {
    expect(publicErrorFamilies).toEqual([
      'Conflict',
      'EngineUnavailable',
      'Forbidden',
      'ForbiddenDemo',
      'IncompatibleStore',
      'InvalidInput',
      'RevisionExpired',
      'SkillsConflict',
      'Unavailable',
    ]);
    expect(Object.keys(publicErrorMap)).toEqual([...publicErrorFamilies]);
  });

  test('provides closed oRPC-compatible error data schemas without private fields', () => {
    for (const definition of Object.values(publicErrorMap)) {
      expect(safeParse(definition.data, {}).success).toBe(true);
      expect(safeParse(definition.data, { reason: 'engine-unavailable' }).success).toBe(true);
      expect(safeParse(definition.data, { privatePath: '/private/store.sqlite' }).success).toBe(false);
    }
  });

  test('accepts a bounded sanitized public error and rejects undeclared fields', () => {
    expect(
      safeParse(publicErrorSchema, {
        message: 'The served report revision expired.',
        reason: 'revision-expired',
        tag: 'RevisionExpired',
      }).success,
    ).toBe(true);
    expect(
      safeParse(publicErrorSchema, {
        message: 'The served report revision expired.',
        privatePath: '/private/report.sqlite',
        tag: 'RevisionExpired',
      }).success,
    ).toBe(false);
  });

  test('rejects open-ended error tags and unsafe reasons', () => {
    expect(
      safeParse(publicErrorSchema, {
        message: 'Raw exception.',
        tag: 'InternalServerError',
      }).success,
    ).toBe(false);
    expect(
      safeParse(publicErrorSchema, {
        message: 'Unavailable.',
        reason: '/home/user/.config/secret',
        tag: 'Unavailable',
      }).success,
    ).toBe(false);
    expect(isPublicErrorFamily('SkillsConflict')).toBe(true);
    expect(isPublicErrorFamily('RawException')).toBe(false);
  });
});
