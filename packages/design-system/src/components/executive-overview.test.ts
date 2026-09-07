import { describe, expect, test } from 'bun:test';
import { editorialSection, executiveCaption, executiveEssentialLabel, numericDisplay, sectionDivider } from '../report';

const PASSIVE_CARD_CLASS_PATTERN = /(?:^|\s)(?:bd|bg|bx-sh)_/;

describe('Report executive editorial primitives', () => {
  test('keeps passive sections open with section dividers', () => {
    expect(editorialSection).toContain('d_grid');
    expect(editorialSection).not.toMatch(PASSIVE_CARD_CLASS_PATTERN);
    expect(sectionDivider).toContain('bd-t_1px_solid_token(colors.line)');
  });

  test('keeps executive numbers and essential copy legible at every breakpoint', () => {
    expect(numericDisplay).toContain('fs_clamp(28px,_calc(150cqi_/_var(--hero-chars,_8)),_40px)');
    expect(numericDisplay).toContain('md:fs_clamp(28px,_calc(150cqi_/_var(--hero-chars,_8)),_52px)');
    expect(numericDisplay).toContain('white-space_nowrap');
    expect(executiveCaption).toContain('fs_12px');
    expect(executiveEssentialLabel).toContain('fs_11px');
  });
});
