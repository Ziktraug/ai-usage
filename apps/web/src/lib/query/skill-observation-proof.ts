import { COLLECTION_SWR_STALE_TIME_MS } from './policies';

/**
 * Converts an absolute producer-proof deadline into TanStack's duration-from-`dataUpdatedAt`
 * stale-time model. Missing, malformed, or already-expired proof is stale immediately.
 */
export const skillObservationProducerProofStaleTime = (
  producerProofValidUntil: string | null,
  dataUpdatedAt: number,
): number => {
  if (producerProofValidUntil === null) {
    return 0;
  }
  const validUntil = Date.parse(producerProofValidUntil);
  if (!(Number.isFinite(validUntil) && Number.isFinite(dataUpdatedAt))) {
    return 0;
  }
  return Math.max(0, Math.min(COLLECTION_SWR_STALE_TIME_MS, validUntil - dataUpdatedAt));
};

export type SkillObservationProducerProofStatus = 'current' | 'expired' | 'refreshing';

/**
 * Qualification the presentation edge applies to retained Query data. A background refetch keeps
 * the old value in TanStack, so in-flight data is never presented as settled exact evidence.
 */
export const skillObservationProducerProofStatus = (input: {
  readonly isFetching: boolean;
  readonly isStale: boolean;
}): SkillObservationProducerProofStatus => {
  if (input.isFetching) {
    return 'refreshing';
  }
  return input.isStale ? 'expired' : 'current';
};
