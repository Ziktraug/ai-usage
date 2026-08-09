import { describe, expect, test } from 'bun:test';
import { applyStateUpdate } from './state';

describe('framework-neutral table updates', () => {
  test('accepts a replacement value', () => {
    expect(applyStateUpdate({ visible: false }, { visible: true })).toEqual({ visible: false });
  });

  test('applies a functional update without mutating the current value', () => {
    const current = { visible: true };
    const next = applyStateUpdate((value) => ({ ...value, visible: false }), current);

    expect(next).toEqual({ visible: false });
    expect(current).toEqual({ visible: true });
  });
});
