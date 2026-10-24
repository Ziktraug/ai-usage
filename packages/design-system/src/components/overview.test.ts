import { describe, expect, test } from 'bun:test';
import {
  heatCell,
  heatLegendCell,
  punchDot,
  punchIntensityKeyCell,
  recordsGrid,
  recordsGridTriple,
  twoColumns,
} from './overview';

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

describe('Rhythm and Punchcard marks under forced colours', () => {
  test('keep their own paint, so forced colours do not flatten the intensity they carry', () => {
    for (const mark of [heatCell, heatLegendCell, punchDot, punchIntensityKeyCell]) {
      expect(mark).toContain('forced-color-adjust_none');
    }
  });

  test('draw a focused day with the forced palette ring instead of the kept accent', () => {
    expect(heatCell).toContain('focusVisible:ring_1px_solid_token(colors.accent)');
    expect(heatCell).toContain('focusVisible:highContrast:ring_2px_solid_Highlight');
  });
});
