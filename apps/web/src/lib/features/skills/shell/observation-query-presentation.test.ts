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
    ).toEqual({ observations: syntheticObservations, observationsError: undefined, producerProofCurrent: true });
  });

  test('keeps retained data visible while marking its refreshing proof non-current', () => {
    for (const isStale of [false, true]) {
      expect(
        skillObservationQueryPresentation({
          data: syntheticObservations,
          error: null,
          isFetching: true,
          isStale,
        }),
      ).toEqual({
        observations: syntheticObservations,
        observationsError: undefined,
        producerProofCurrent: false,
      });
    }
  });

  test('retains positive facts while failing absence proof closed after expiry', () => {
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
      producerProofCurrent: false,
    });
  });

  test('reports a background refetch error without discarding retained data', () => {
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
      producerProofCurrent: false,
    });
  });
});
