import { describe, expect, test } from 'bun:test';
import { originFilterLabel } from './origin-filter';

describe('origin filter', () => {
  test('makes the non-neutral default and every alternate selection explicit', () => {
    const defaultLabel = originFilterLabel(['human', 'subagent', 'unknown']);

    expect(defaultLabel).toBe('Origin: excluding automated reviews');
    expect(defaultLabel).not.toContain('human + delegated');
    expect(originFilterLabel(['human', 'subagent'])).toBe('Origin: human + delegated');
    expect(originFilterLabel([])).toBe('Origin: all');
    expect(originFilterLabel(['classifier'])).toBe('Origin: automated review');
    expect(originFilterLabel(['unknown'])).toBe('Origin: undeclared');
  });
});
