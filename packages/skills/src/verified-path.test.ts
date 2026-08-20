import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { isPathWithin, portableContainedPath, relativePathWithin, resolveAbsolutePath } from './verified-path';

describe('verified paths', () => {
  test('distinguishes siblings prefixed with dots from parent traversal', () => {
    const parent = resolveAbsolutePath('/workspace/skills/example');
    expect(isPathWithin(parent, path.join(parent, '..hidden'))).toBe(true);
    expect(isPathWithin(parent, path.join(parent, '..', 'outside'))).toBe(false);
  });

  test('can reject the directory itself and normalize a contained path', () => {
    const parent = resolveAbsolutePath('/workspace/skills/example');
    expect(relativePathWithin(parent, parent, false)).toBeUndefined();
    const contained = relativePathWithin(parent, path.join(parent, 'references', 'guide.md'), false);
    if (contained === undefined) {
      throw new Error('expected a contained path');
    }
    expect(portableContainedPath(contained)).toBe('references/guide.md');
  });
});
