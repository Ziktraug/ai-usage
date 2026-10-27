import { Effect } from 'effect';
import type { SourceAdapterOptions } from './source-adapters';

/** Tests opt into simulated sources explicitly; a forgotten process fixture fails without a spawn. */
export const isolatedSourceOptions = {
  acliAvailable: () => false,
  claudeLiveAvailable: () => false,
  codexLiveAvailable: () => false,
  executorObservation: { which: () => null },
  ghAvailable: () => false,
  gitAvailable: () => false,
  opencodeLiveAvailable: () => false,
  workFactProcessRunner: (options) => Effect.die(new Error(`Missing process fixture for ${options.command}`)),
} satisfies SourceAdapterOptions;

/** Pinned independently of the collector: review threads plus the bounded status history. */
const REVIEW_THREADS_QUERY =
  'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { totalCount nodes { isResolved } } reviews(last: 50, states: [APPROVED, CHANGES_REQUESTED]) { totalCount nodes { state submittedAt author { login } } } timelineItems(last: 30, itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, CLOSED_EVENT, REOPENED_EVENT]) { totalCount nodes { __typename ... on ReadyForReviewEvent { createdAt actor { login } } ... on ConvertToDraftEvent { createdAt actor { login } } ... on ClosedEvent { createdAt actor { login } } ... on ReopenedEvent { createdAt actor { login } } } } } } }';

export const reviewThreadsFixtureArgs = (repository: string, number: number): readonly string[] => {
  const [owner, name] = repository.split('/');
  return [
    'api',
    'graphql',
    '-f',
    `query=${REVIEW_THREADS_QUERY}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
    '-F',
    `number=${String(number)}`,
  ];
};

/** Accept only the bounded read query and its exact variable flags, never a mutation or extra arguments. */
export const isReviewThreadsFixtureRead = (args: readonly string[]): boolean => {
  const owner = args[5]?.startsWith('owner=') ? args[5].slice(6) : '';
  const name = args[7]?.startsWith('name=') ? args[7].slice(5) : '';
  const number = args[9]?.startsWith('number=') ? Number(args[9].slice(7)) : Number.NaN;
  return (
    owner.length > 0 &&
    name.length > 0 &&
    Number.isSafeInteger(number) &&
    number > 0 &&
    JSON.stringify(args) === JSON.stringify(reviewThreadsFixtureArgs(`${owner}/${name}`, number))
  );
};

export const reviewThreadsFixtureResponse = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          totalCount: 3,
          nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }],
        },
        reviews: {
          totalCount: 1,
          nodes: [{ state: 'APPROVED', submittedAt: '2026-10-20T09:00:00Z', author: { login: 'reviewer' } }],
        },
        timelineItems: { totalCount: 0, nodes: [] },
      },
    },
  },
});
