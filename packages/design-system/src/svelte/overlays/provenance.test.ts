import { describe, expect, test } from 'bun:test';
import { provenanceMarkerGlyph, provenanceTitle } from './provenance';

describe('Svelte overlay provenance helpers', () => {
  test('formats every fact for both the tooltip and accessible fallback', () => {
    expect(
      provenanceTitle([
        { description: 'One', label: 'First', severity: 'info' },
        { description: 'Two', label: 'Second', severity: 'warning' },
      ]),
    ).toBe('First: One\nSecond: Two');
  });

  test('uses the warning glyph when any fact is a warning', () => {
    expect(provenanceMarkerGlyph([{ description: 'One', label: 'First', severity: 'info' }])).toBe('i');
    expect(
      provenanceMarkerGlyph([
        { description: 'One', label: 'First', severity: 'info' },
        { description: 'Two', label: 'Second', severity: 'warning' },
      ]),
    ).toBe('!');
  });
});
