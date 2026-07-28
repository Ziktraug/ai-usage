import { describe, expect, test } from 'bun:test';
import { lineDeltaLabel } from './dashboard-sort';

describe('line delta presentation', () => {
  test('distinguishes an unknown delta from a genuine zero', () => {
    expect(
      lineDeltaLabel({
        lineDelta: null,
        linesAdded: null,
        linesDeleted: null,
      }),
    ).toBe('—');
    expect(
      lineDeltaLabel({
        lineDelta: 0,
        linesAdded: 0,
        linesDeleted: 0,
      }),
    ).toBe('+0/-0');
  });
});
