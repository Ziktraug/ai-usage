import type { CanonicalInstant } from './canonical-instant';
import type { JiraIssueObservation, PullRequestObservation } from './work-attention';
import { jiraIssueLinkKey, pullRequestLinkKey, WORK_THREAD_BOUNDS, type WorkThreadIntent } from './work-thread';

export interface WorkThreadSeed {
  readonly discoveredAt: CanonicalInstant;
  readonly intent: WorkThreadIntent | null;
  readonly linkKind: 'pull-request' | 'jira-issue';
  readonly origin: 'pull-request' | 'jira-issue';
  readonly originKey: string;
  readonly projectLabel: string;
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
    return [
      {
        discoveredAt: observation.observedAt,
        intent: observation.discoveryRole === 'review-requested' ? 'review' : 'change',
        linkKind: 'pull-request',
        origin: 'pull-request',
        originKey,
        projectLabel: observation.repository,
        title: boundedTitle(observation.title, `${observation.repository}#${observation.number}`),
      },
    ];
  });

/** The Jira CLI owns its configured site; observations currently identify that site as `default`. */
export const workThreadSeedsFromJiraIssues = (observations: readonly JiraIssueObservation[]): WorkThreadSeed[] =>
  latestSuccessful(observations, (observation) => jiraIssueLinkKey({ key: observation.key, site: 'default' })).map(
    (observation): WorkThreadSeed => ({
      discoveredAt: observation.observedAt,
      intent: null,
      linkKind: 'jira-issue',
      origin: 'jira-issue',
      originKey: jiraIssueLinkKey({ key: observation.key, site: 'default' }),
      projectLabel: observation.key.split('-')[0] ?? observation.key,
      title: boundedTitle(observation.summary, observation.key),
    }),
  );
