import type {
  ProjectResolutionAction,
  ProjectResolutionActionResult,
  ProjectResolutionReviewSnapshot,
} from '@ai-usage/web-contract/projects';

const spaceId = '0198f179-4837-7000-8000-000000000001';
const checkoutId = '0198f179-4837-7000-8000-000000000002';

let reviewed = false;

export const readE2EProjectResolutionReviews = (): ProjectResolutionReviewSnapshot => ({
  reviews: reviewed
    ? []
    : [
        {
          candidateMatches: [
            {
              canonicalLabel: 'github.com/openai/ai-usage',
              repositoryId: '0198f179-4837-7000-8000-000000000004',
            },
          ],
          checkoutId,
          destinationSpaceId: spaceId,
          deviceId: '0198f179-4837-7000-8000-000000000003',
          deviceLabel: 'Development device',
          localLabel: 'checkout:0198f179',
          normalizedRemote: 'github.com/openai/ai-usage',
          status: 'candidate',
        },
      ],
  spaceId,
});

export const applyE2EProjectResolutionAction = (action: ProjectResolutionAction): ProjectResolutionActionResult => {
  if (action.checkoutId !== checkoutId || action.spaceId !== spaceId) {
    throw new Error('Unknown E2E project resolution action.');
  }
  reviewed = true;
  if (action.kind === 'create-project') {
    return { kind: 'project-created', projectId: '0198f179-4837-7000-8000-000000000005' };
  }
  if (action.kind === 'link') {
    return { kind: 'linked', projectId: action.projectId, repositoryId: action.repositoryId };
  }
  return { kind: 'left-unassigned' };
};

export const resetE2EProjectResolutionReviews = (): void => {
  reviewed = false;
};
