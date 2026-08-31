import { describe, expect, test } from 'bun:test';
import { skillObservationQueryPresentation } from './observation-query-presentation';
import { syntheticObservations } from './synthetic-fixture.test-helper';

describe('Skills observation Query presentation edge', () => {
  test('keeps only a settled current proof visible', () => {
    expect(
      skillObservationQueryPresentation({
        data: syntheticObservations,
        error: null,
        isFetching: false,
        isStale: false,
      }),
    ).toEqual({ observations: syntheticObservations, observationsError: undefined });
  });

  test('masks retained data while its proof is being refreshed', () => {
    for (const isStale of [false, true]) {
      expect(
        skillObservationQueryPresentation({
          data: syntheticObservations,
          error: null,
          isFetching: true,
          isStale,
        }),
      ).toEqual({ observations: undefined, observationsError: undefined });
    }
  });

  test('fails closed when the retained proof is expired', () => {
    expect(
      skillObservationQueryPresentation({
        data: syntheticObservations,
        error: null,
        isFetching: false,
        isStale: true,
      }),
    ).toEqual({
      observations: syntheticObservations,
      observationsError: 'The producer completeness proof has expired.',
    });
  });

  test('keeps a background refetch error authoritative over retained data', () => {
    expect(
      skillObservationQueryPresentation({
        data: syntheticObservations,
        error: new Error('Synthetic background refetch failure.'),
        isFetching: false,
        isStale: true,
      }),
    ).toEqual({
      observations: syntheticObservations,
      observationsError: 'Synthetic background refetch failure.',
    });
  });
});
