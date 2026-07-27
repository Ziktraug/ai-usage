import { describe, expect, test } from 'bun:test';
import { breakdownBarPresentation, breakdownModelLabel, breakdownPriceStateLabel } from './group-panel-presentation';

describe('Breakdown price presentation', () => {
  test('keeps a small positive value proportional instead of flooring it', () => {
    const presentation = breakdownBarPresentation({
      knownCost: 0.12,
      maxKnownCost: 20.41,
      unpricedCount: 0,
    });

    expect(presentation.state).toBe('measured');
    expect(presentation.widthPercent).toBeCloseTo((0.12 / 20.41) * 100);
    expect(presentation.widthPercent).toBeGreaterThan(0);
    expect(presentation.widthPercent).toBeLessThan(3);
  });

  test('keeps genuine zero and partially measured values as distinct states', () => {
    const zero = breakdownBarPresentation({
      knownCost: 0,
      maxKnownCost: 20.41,
      unpricedCount: 0,
    });
    const partiallyMeasured = breakdownBarPresentation({
      knownCost: 0,
      maxKnownCost: 20.41,
      unpricedCount: 1,
    });

    expect(zero).toEqual({ state: 'zero', widthPercent: 0 });
    expect(partiallyMeasured).toEqual({
      state: 'partially measured',
      widthPercent: 0,
    });
    expect(breakdownPriceStateLabel(zero.state)).toBe('Zero');
    expect(breakdownPriceStateLabel(partiallyMeasured.state)).toBe('Partially measured');
  });
});

describe('Breakdown model labels', () => {
  test('replaces internal model placeholders without changing real model names', () => {
    expect(breakdownModelLabel('<synthetic>')).toBe('Unattributed model');
    expect(breakdownModelLabel('codex')).toBe('Unspecified Codex model');
    expect(breakdownModelLabel('gpt-5.6-sol')).toBe('gpt-5.6-sol');
  });
});
