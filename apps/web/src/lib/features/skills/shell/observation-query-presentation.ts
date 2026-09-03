import type { SkillObservations } from '@ai-usage/web-contract/skills';
import { skillObservationProducerProofStatus } from '../../../query/skill-observation-proof';

export interface SkillObservationQueryPresentation {
  readonly observations: SkillObservations | undefined;
  readonly observationsError: string | undefined;
  readonly producerProofCurrent: boolean;
}

/**
 * TanStack keeps successful data during background work and after a refetch failure. The cache may
 * retain it, and the Skills projection keeps those positive facts visible during a refresh. The
 * producer-proof qualification separately prevents retained data from carrying an exact absence.
 * Expiry or a failed refetch is reported beside the retained facts; neither erases positive
 * evidence from the last successful answer.
 */
export const skillObservationQueryPresentation = (input: {
  readonly data: SkillObservations | undefined;
  readonly error: unknown;
  readonly isFetching: boolean;
  readonly isStale: boolean;
}): SkillObservationQueryPresentation => {
  const errorMessage = input.error instanceof Error ? input.error.message : undefined;
  if (errorMessage !== undefined) {
    return { observations: input.data, observationsError: errorMessage, producerProofCurrent: false };
  }
  if (input.data === undefined) {
    return { observations: undefined, observationsError: undefined, producerProofCurrent: false };
  }
  const proofStatus = skillObservationProducerProofStatus(input);
  if (proofStatus === 'refreshing') {
    return { observations: input.data, observationsError: undefined, producerProofCurrent: false };
  }
  if (proofStatus === 'expired') {
    return {
      observations: input.data,
      observationsError: 'The producer completeness proof has expired.',
      producerProofCurrent: false,
    };
  }
  return { observations: input.data, observationsError: undefined, producerProofCurrent: true };
};
