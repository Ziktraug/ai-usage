import { describe, expect, test } from 'bun:test';
import { conflictingAtoms } from './atomic-class-conflicts';

describe('conflictingAtoms', () => {
  test('reports two atoms for the same property and condition on one element', () => {
    const html =
      '<button class="bg_surfaceMuted c_ink hover:bg_accentSoft bg_accent c_accentContrast" type="button">Accept</button>' +
      '<textarea disabled class="min-h_38px px_10px min-h_92px"></textarea>';

    expect(conflictingAtoms(html)).toEqual([
      'bg_surfaceMuted / bg_accent',
      'c_ink / c_accentContrast',
      'min-h_38px / min-h_92px',
    ]);
  });

  test('accepts one atom per key, distinct conditions, and atoms spread across separate elements', () => {
    const html =
      '<button class="bg_accent hover:bg_accent c_accentContrast svelte-1x2y3z">Accept</button>' +
      '<button type="button" class="bg_surfaceMuted c_ink">Edit</button>';

    expect(conflictingAtoms(html)).toEqual([]);
  });
});
