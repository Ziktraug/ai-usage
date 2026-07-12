import { describe, expect, test } from 'bun:test';
import { dimensionSwatch, stableSeriesColor, stableSeriesIndex } from './chart';

describe('categorical chart colors', () => {
  test('derives literal colors from the series key', () => {
    expect(stableSeriesColor('gpt-5')).toBe('hsl(219 42% 60%)');
    expect(stableSeriesColor('claude-sonnet')).toBe('hsl(10 42% 60%)');
    expect(stableSeriesIndex('gpt-5', 6)).toBe(3);
    expect(stableSeriesIndex('claude-sonnet', 6)).toBe(4);
  });

  test('keeps a model swatch stable when its value rank changes', () => {
    expect(dimensionSwatch('model', 'gpt-5', 0)).toEqual(dimensionSwatch('model', 'gpt-5', 5));
    expect(dimensionSwatch('model', 'gpt-5', 0)).not.toEqual(dimensionSwatch('model', 'claude-sonnet', 0));
  });
});
