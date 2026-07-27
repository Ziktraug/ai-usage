import { describe, expect, test } from 'bun:test';
import { originFilterLabel } from './origin-filter';

describe('origin filter', () => {
  test('names only the origin kinds excluded by the selection', () => {
    const defaultLabel = originFilterLabel([]);

    expect(defaultLabel).toBe('Origin: all');
    expect(originFilterLabel(['human', 'subagent'])).toBe('Origin: excluding automated review');
    expect(originFilterLabel(['classifier'])).toBe('Origin: excluding human + delegated');
    expect(originFilterLabel(['human'])).toBe('Origin: excluding delegated + automated review');
  });
});
