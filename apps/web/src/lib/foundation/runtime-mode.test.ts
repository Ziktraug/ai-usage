import { describe, expect, test } from 'bun:test';
import { parseRuntimeMode } from './runtime-mode';

const environment = (demo?: string, e2e?: string) => ({
  VITE_AI_USAGE_DEMO: demo,
  VITE_AI_USAGE_E2E: e2e,
});

describe('runtime mode', () => {
  test('defaults to live mode', () => {
    expect(parseRuntimeMode(environment())).toBe('live');
    expect(parseRuntimeMode(environment('0', '0'))).toBe('live');
  });

  test('selects demo and E2E explicitly', () => {
    expect(parseRuntimeMode(environment('1'))).toBe('demo');
    expect(parseRuntimeMode(environment(undefined, '1'))).toBe('e2e');
  });

  test('rejects conflicting synthetic modes', () => {
    expect(() => parseRuntimeMode(environment('1', '1'))).toThrow('cannot both be enabled');
  });
});
