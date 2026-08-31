import type { SkillObservations } from '@ai-usage/web-contract/skills';
import { skillObservationProducerProofStatus } from '../../../query/skill-observation-proof';

export interface SkillObservationQueryPresentation {
  readonly observations: SkillObservations | undefined;
  readonly observationsError: string | undefined;
}

/**
 * TanStack keeps successful data during background work and after a refetch failure. The cache may
 * retain it, but the Skills projection may only consume it while its producer proof is settled and
 * current. A refresh renders as loading; an expired or failed proof renders as unavailable.
 */
export const skillObservationQueryPresentation = (input: {
  readonly data: SkillObservations | undefined;
  readonly error: unknown;
  readonly isFetching: boolean;
  readonly isStale: boolean;
}): SkillObservationQueryPresentation => {
  const errorMessage = input.error instanceof Error ? input.error.message : undefined;
  if (errorMessage !== undefined) {
    return { observations: input.data, observationsError: errorMessage };
  }
  if (input.data === undefined) {
    return { observations: undefined, observationsError: undefined };
  }
  const proofStatus = skillObservationProducerProofStatus(input);
  if (proofStatus === 'refreshing') {
    return { observations: undefined, observationsError: undefined };
  }
  if (proofStatus === 'expired') {
    return {
      observations: input.data,
      observationsError: 'The producer completeness proof has expired.',
    };
  }
  return { observations: input.data, observationsError: undefined };
};
