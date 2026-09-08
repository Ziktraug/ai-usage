import type { CheckoutId, DeviceId, ProjectId, RepositoryId, SpaceId } from '@ai-usage/platform-core/identity';

export interface CheckoutResolutionCandidateSummary {
  readonly canonicalLabel: string;
  readonly repositoryId: RepositoryId;
}

export interface CheckoutResolutionReview {
  readonly candidateMatches: readonly CheckoutResolutionCandidateSummary[];
  readonly checkoutId: CheckoutId;
  readonly destinationSpaceId: SpaceId;
  readonly deviceId: DeviceId;
  readonly deviceLabel: string;
  readonly localLabel: string;
  readonly normalizedRemote: string | null;
  readonly status: 'ambiguous' | 'candidate' | 'unassigned';
}

export type CheckoutResolutionAction =
  | {
      readonly checkoutId: CheckoutId;
      readonly displayName: string;
      readonly kind: 'create-project';
      readonly spaceId: SpaceId;
    }
  | {
      readonly checkoutId: CheckoutId;
      readonly kind: 'link';
      readonly projectId: ProjectId | null;
      readonly repositoryId: RepositoryId;
      readonly spaceId: SpaceId;
    }
  | {
      readonly checkoutId: CheckoutId;
      readonly kind: 'leave-unassigned';
      readonly spaceId: SpaceId;
    };

export type CheckoutResolutionActionResult =
  | { readonly kind: 'project-created'; readonly projectId: ProjectId }
  | {
      readonly kind: 'linked';
      readonly projectId: ProjectId | null;
      readonly repositoryId: RepositoryId;
    }
  | { readonly kind: 'left-unassigned' };
