import { describe, expect, test } from 'bun:test';
import { recordsGrid, recordsGridTriple, twoColumns } from './overview';

describe('Overview secondary layouts', () => {
  test('stacks Session shape and Punchcard until 2xl, then gives Punchcard its natural width', () => {
    expect(twoColumns).toContain('grid-tc_1fr');
    expect(twoColumns).toContain('2xl:grid-tc_minmax(0,_1fr)_max-content');
    expect(twoColumns).not.toContain('lg:grid-tc_repeat(2');
    expect(twoColumns).toContain('ai_start');
  });

  test('lays three record tiles out 1-up, then 3-up from md', () => {
    expect(recordsGrid).toContain('grid-tc_repeat(2,_minmax(0,_1fr))');
    expect(recordsGridTriple).toContain('grid-tc_1fr');
    expect(recordsGridTriple).toContain('md:grid-tc_repeat(3,_minmax(0,_1fr))');
  });
});
