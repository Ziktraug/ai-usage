import { describe, expect, test } from 'bun:test';
import { provenanceMarkerGlyph } from '@ai-usage/design-system/report';

describe('provenance marker glyph', () => {
  test('uses an information glyph when every fact is informational', () => {
    expect(
      provenanceMarkerGlyph([
        {
          description: 'Derived from the first prompt.',
          label: 'Derived title',
          severity: 'info',
        },
      ]),
    ).toBe('i');
  });

  test('reserves the warning glyph for facts that contain a warning', () => {
    expect(
      provenanceMarkerGlyph([
        {
          description: 'Derived from the first prompt.',
          label: 'Derived title',
          severity: 'info',
        },
        {
          description: 'No public API price is available.',
          label: 'Unknown API price',
          severity: 'warning',
        },
      ]),
    ).toBe('!');
  });
});
