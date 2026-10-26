import type { CanonicalInstant } from './canonical-instant';
import type { PullRequestObservation } from './work-attention';
import { jiraKeysInBranch } from './work-attention-facts';
import { jiraIssueLinkKey, pullRequestLinkKey, WORK_THREAD_BOUNDS, type WorkThreadIntent } from './work-thread';

export interface WorkThreadSeed {
  readonly discoveredAt: CanonicalInstant;
  readonly intent: WorkThreadIntent | null;
  readonly linkKind: 'pull-request';
  readonly origin: 'pull-request';
  readonly originKey: string;
  readonly projectLabel: string;
  /**
   * The one Jira link key (`jira:default/XLB-1`) an authored pull request's head branch names as a
   * whole segment. It lets the PR join the task that already follows that ticket. Reviews never
   * carry one: a teammate's ticket is context, not the operator's delivery.
   */
  readonly routingJiraKey: string | null;
  readonly title: string;
}

const boundedTitle = (title: string | null, fallback: string): string =>
  (title?.trim() || fallback).slice(0, WORK_THREAD_BOUNDS.maxTitle);

/** GitHub repository identities are case-insensitive; display labels retain the observed casing. */
const pullRequestSeedKey = (observation: PullRequestObservation): string =>
  pullRequestLinkKey({ ...observation, repository: observation.repository.toLowerCase() });

/** Stable ordering and latest success per qualified key, independent of collection order. */
const latestSuccessful = <Observation extends { readonly outcome: string; readonly observedAt: CanonicalInstant }>(
  observations: readonly Observation[],
  keyFor: (observation: Observation) => string,
): Observation[] => {
  const byKey = new Map<string, Observation>();
  for (const observation of observations) {
    if (observation.outcome !== 'observed') {
      continue;
    }
    const key = keyFor(observation);
    const previous = byKey.get(key);
    if (
      !previous ||
      observation.observedAt > previous.observedAt ||
      (observation.observedAt === previous.observedAt && JSON.stringify(observation) < JSON.stringify(previous))
    ) {
      byKey.set(key, observation);
    }
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : Number(left > right)))
    .map(([, observation]) => observation);
};

/** Pure inputs for the engine's idempotent thread creation; no follow state is inferred here. */
export const workThreadSeedsFromPullRequests = (observations: readonly PullRequestObservation[]): WorkThreadSeed[] =>
  latestSuccessful(observations, pullRequestSeedKey).flatMap((observation): WorkThreadSeed[] => {
    if (!observation.discoveryRole) {
      return [];
    }
    const originKey = pullRequestSeedKey(observation);
    const branchKeys = jiraKeysInBranch(observation.headRef ?? '');
    const [branchKey] = branchKeys;
    return [
      {
        discoveredAt: observation.observedAt,
        intent: observation.discoveryRole === 'review-requested' ? 'review' : 'change',
        linkKind: 'pull-request',
        origin: 'pull-request',
        originKey,
        projectLabel: observation.repository,
        routingJiraKey:
          observation.discoveryRole === 'author' && branchKeys.length === 1 && branchKey !== undefined
            ? jiraIssueLinkKey({ key: branchKey, site: 'default' })
            : null,
        title: boundedTitle(observation.title, `${observation.repository}#${observation.number}`),
      },
    ];
  });
