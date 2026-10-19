import { describe, expect, test } from 'bun:test';
import { conflictingButtonAtoms } from './atomic-class-conflicts';

describe('conflictingButtonAtoms', () => {
  test('reports two atoms for the same property and condition on one button', () => {
    const html =
      '<button class="bg_surfaceMuted c_ink hover:bg_accentSoft bg_accent c_accentContrast" type="button">Accept</button>';

    expect(conflictingButtonAtoms(html)).toEqual(['bg_surfaceMuted / bg_accent', 'c_ink / c_accentContrast']);
  });

  test('accepts one atom per key, distinct conditions, and atoms spread across separate buttons', () => {
    const html =
      '<button class="bg_accent hover:bg_accent c_accentContrast svelte-1x2y3z">Accept</button>' +
      '<button type="button" class="bg_surfaceMuted c_ink">Edit</button>';

    expect(conflictingButtonAtoms(html)).toEqual([]);
  });
});
