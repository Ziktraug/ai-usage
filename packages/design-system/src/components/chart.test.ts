import { describe, expect, test } from 'bun:test';
import { dimensionSwatch, stableSeriesColor, stableSeriesIndex } from './chart';

describe('categorical chart colors', () => {
  test('derives literal colors from the series key', () => {
    expect(stableSeriesColor('gpt-5')).toBe('hsl(219 42% 60%)');
    expect(stableSeriesColor('claude-sonnet')).toBe('hsl(10 42% 60%)');
    expect(stableSeriesIndex('gpt-5', 6)).toBe(3);
    expect(stableSeriesIndex('claude-sonnet', 6)).toBe(4);
  });

  test('assigns model swatches from stable keys', () => {
    expect(dimensionSwatch('model', 'gpt-5')).not.toEqual(dimensionSwatch('model', 'claude-sonnet'));
  });
});
