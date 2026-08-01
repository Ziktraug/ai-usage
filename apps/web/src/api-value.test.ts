import { describe, expect, test } from 'bun:test';
import {
  aggregateApiPriceProvenance,
  aggregateApiValuePresentation,
  apiValuePresentation,
  PARTIAL_PRICE_HINT,
  UNKNOWN_PRICE_HINT,
} from './shared';

describe('API value presentation', () => {
  test('distinguishes exact values, known lower bounds, and wholly unknown prices', () => {
    expect(apiValuePresentation({ costApprox: 68.09, costKnown: true })).toEqual({
      label: '$68.09',
      status: 'exact',
      title: 'Estimated API-equivalent value at standard prices',
    });
    expect(apiValuePresentation({ costApprox: 0, costKnown: true })).toEqual({
      label: '$0.00',
      status: 'exact',
      title: 'Estimated API-equivalent value at standard prices',
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

  test('presents a partial aggregate as a lower bound with the locked provenance copy', () => {
    const measurement = {
      knownCost: 4.63,
      state: 'partially measured' as const,
      unpricedFreshTokens: 57_500_000,
    };

    expect(aggregateApiValuePresentation(measurement)).toEqual({
      label: '≥ $4.63',
      status: 'lower-bound',
      title:
        'Partially measured — 57.5M tokens in this slice come from models with no published price. Their work is counted, their value is not.',
    });
    expect(aggregateApiPriceProvenance(measurement)).toEqual({
      description:
        'Partially measured — 57.5M tokens in this slice come from models with no published price. Their work is counted, their value is not.',
      label: 'Partially measured',
      severity: 'warning',
    });
  });
});
