import { describe, expect, test } from 'bun:test';
import { apiValuePresentation, PARTIAL_PRICE_HINT, UNKNOWN_PRICE_HINT } from './shared';

describe('API value presentation', () => {
  test('distinguishes exact values, known lower bounds, and wholly unknown prices', () => {
    expect(apiValuePresentation({ costApprox: 68.09, costKnown: true })).toEqual({
      label: '$68.09',
      status: 'exact',
      title: 'Estimated API value at standard prices',
    });
    expect(apiValuePresentation({ costApprox: 0, costKnown: true })).toEqual({
      label: '$0.00',
      status: 'exact',
      title: 'Estimated API value at standard prices',
    });
    expect(apiValuePresentation({ costApprox: 69.3, costKnown: false })).toEqual({
      label: '≥ $69.30',
      status: 'lower-bound',
      title: PARTIAL_PRICE_HINT,
    });
    expect(apiValuePresentation({ costApprox: 0, costKnown: false })).toEqual({
      label: '—',
      status: 'unknown',
      title: UNKNOWN_PRICE_HINT,
    });
  });
});
