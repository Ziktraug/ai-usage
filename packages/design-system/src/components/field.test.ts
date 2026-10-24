import { expect, test } from 'bun:test';
import { field, searchInput } from './field';

test('a focused field keeps its halo and draws a forced-colours ring where the halo would be', () => {
  for (const input of [field, searchInput]) {
    expect(input).toContain('ring_none');
    expect(input).toContain('focusVisible:bx-sh_0_0_0_3px_token(colors.focusRing)');
    expect(input).toContain('focusVisible:highContrast:ring_2px_solid_Highlight');
    expect(input).toContain('focusVisible:highContrast:ring-o_1px');
  }
});
