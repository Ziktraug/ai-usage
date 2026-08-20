import { describe, expect, test } from 'bun:test';
import {
  containedInteractive,
  editorialSection,
  executiveCaption,
  executiveEssentialLabel,
  executiveGrid,
  metricStrip,
  numericDisplay,
  sectionDivider,
} from '../report';

const PASSIVE_CARD_CLASS_PATTERN = /(?:^|\s)(?:bd|bg|bx-sh)_/;

describe('Report executive editorial primitives', () => {
  test('moves from one reading column to a two-column executive grid', () => {
    expect(executiveGrid).toContain('d_grid');
    expect(executiveGrid).toContain('grid-tc_1fr');
    expect(executiveGrid).toContain('lg:grid-tc_minmax(18rem,_0.85fr)_minmax(0,_1.35fr)');
  });

  test('keeps passive sections editorial and contains only interactive regions', () => {
    expect(editorialSection).toContain('d_grid');
    expect(editorialSection).not.toMatch(PASSIVE_CARD_CLASS_PATTERN);
    expect(sectionDivider).toContain('bd-t_1px_solid_token(colors.line)');

    expect(containedInteractive).toContain('bd_1px_solid_token(colors.line)');
    expect(containedInteractive).toContain('bg_surface');
    expect(containedInteractive).not.toContain('bx-sh_');
  });

  test('lays out four metrics without compressing the 390px presentation', () => {
    expect(metricStrip).toContain('grid-tc_1fr');
    expect(metricStrip).toContain('md:grid-tc_repeat(2,_minmax(0,_1fr))');
    expect(metricStrip).toContain('lg:grid-tc_repeat(4,_minmax(0,_1fr))');
  });

  test('keeps executive numbers and essential copy legible at every breakpoint', () => {
    expect(numericDisplay).toContain('fs_40px');
    expect(numericDisplay).toContain('md:fs_52px');
    expect(executiveCaption).toContain('fs_12px');
    expect(executiveEssentialLabel).toContain('fs_11px');
  });
});
