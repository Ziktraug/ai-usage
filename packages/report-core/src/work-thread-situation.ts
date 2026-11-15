import type { CanonicalInstant } from './canonical-instant';
import type { CheckoutStatusObservation } from './work-attention';
import type { WorkThreadFact, WorkThreadNativeRequest, WorkThreadRow } from './work-thread-view';

/** Matches the Work attention freshness horizon; freshness is interpreted, never persisted. */
export const WORK_THREAD_STALE_AFTER_MS = 7 * 86_400_000;

type RemainderSource = 'local' | 'github' | 'jira' | 'sessions';
interface RemainderEvidence {
  readonly key: string;
  readonly observedAt: CanonicalInstant | null;
  readonly source: RemainderSource;
}
export type WorkThreadRemainder = RemainderEvidence &
  (
    | { readonly kind: 'native-request'; readonly request: WorkThreadNativeRequest }
    | {
        readonly kind: 'local-files';
        readonly modified: number | null;
        readonly staged: number | null;
        readonly untracked: number | null;
      }
    // unresolved-review-threads: the count of review threads GitHub reports as unresolved, never ordinary comments.
    | { readonly kind: 'unpushed-commits' | 'running-session' | 'unresolved-review-threads'; readonly count: number }
    | { readonly kind: 'merge-conflict' | 'behind-base'; readonly baseRef: string | null }
    | { readonly kind: 'source-unavailable'; readonly outcome: string }
    | {
        // awaiting-review: GitHub requires another review and has not requested the operator's review.
        // draft-pr: the pull request is still a draft and needs the operator's preparation.
        // ready-to-merge: observed review, checks and mergeability leave the merge as the operator's move.
        // open-pr: the pull request is open but no more specific next step can be established.
        readonly kind:
          | 'open-pr'
          | 'awaiting-review'
          | 'changes-requested'
          | 'draft-pr'
          | 'failing-checks'
          | 'pending-checks'
          | 'ready-to-merge'
          | 'review-requested'
          // A review requested from one of the operator's teams: theirs to take or leave, not owed.
          | 'team-review-requested'
          | 'jira-open'
          // Every linked PR merged and the ticket in a status the operator's config names as handed
          // off (a review or QA column): the workflow's next step is someone else's.
          | 'jira-after-merge'
          | 'source-stale'
          | 'source-unknown';
      }
  );
export type Remainder = WorkThreadRemainder;
const UNREAD_KINDS = ['source-unavailable', 'source-stale', 'source-unknown'] as const;
export type WorkThreadUnreadRemainder = WorkThreadRemainder & { readonly kind: (typeof UNREAD_KINDS)[number] };
/** A source that was not read, failed or went stale: what it would say is unknown, not absent. */
export const isUnreadRemainder = (remainder: WorkThreadRemainder): remainder is WorkThreadUnreadRemainder =>
  UNREAD_KINDS.some((kind) => kind === remainder.kind);
export interface WorkThreadSituation {
  readonly action: 'reopen' | 'end-follow-up' | 'resume-session' | 'open-pr' | 'open-jira' | 'copy-context';
  readonly hint: 'to-resume' | 'in-progress' | 'ready-to-close' | 'waiting' | 'undecided' | 'done';
  readonly reason:
    | WorkThreadRemainder['kind']
    | 'follow-up-ended'
    | 'explicit-wait'
    | 'no-remainder'
    | 'merged-complete'
    | 'closed-unmerged'
    | 'next-step';
  readonly remainders: readonly WorkThreadRemainder[];
}
interface DatedObservation {
  readonly observedAt: CanonicalInstant;
  readonly outcome: string;
}

/** The last state a source established: its latest read when it succeeded, else its latest success. */
const lastKnown = <T extends DatedObservation>(fact: WorkThreadFact<T>): T | null =>
  fact.latest?.outcome === 'observed' ? fact.latest : fact.latestSuccessful;

const observation = <T extends DatedObservation>(
  fact: WorkThreadFact<T>,
  source: RemainderSource,
  now: number,
  remainders: WorkThreadRemainder[],
): T | null => {
  const latest = fact.latest;
  const evidence = { key: fact.key, observedAt: latest?.observedAt ?? null, source };
  if (latest === null) {
    remainders.push({ ...evidence, kind: 'source-unknown' });
  } else if (latest.outcome !== 'observed') {
    remainders.push({ ...evidence, kind: 'source-unavailable', outcome: latest.outcome });
  }
  const value = lastKnown(fact);
  if (value !== null && now - Date.parse(value.observedAt) > WORK_THREAD_STALE_AFTER_MS) {
    remainders.push({ ...evidence, observedAt: value.observedAt, kind: 'source-stale' });
  }
  return value?.outcome === 'observed' ? value : null;
};

/** Whether a checkout read showed work that exists nowhere else: uncommitted files or unpushed commits. */
const heldLocalWork = (fact: CheckoutStatusObservation): boolean =>
  fact.dirty === true ||
  (fact.modifiedCount ?? 0) > 0 ||
  (fact.stagedCount ?? 0) > 0 ||
  (fact.untrackedCount ?? 0) > 0 ||
  (fact.ahead ?? 0) > 0;

const localRemainders = (row: WorkThreadRow, now: number, remainders: WorkThreadRemainder[]) => {
  for (const marker of row.markers.local) {
    // A missing checkout is an observed absence: the read succeeded and found the checkout gone, so
    // its last successful observation is history, neither current work nor a stale read. When that
    // last observation held local work, where the work went is unknown, which is not "nothing left":
    // the absence is listed once, as an unread source, to be acknowledged.
    if (marker.latest?.outcome === 'missing') {
      if (marker.latestSuccessful !== null && heldLocalWork(marker.latestSuccessful)) {
        remainders.push({
          key: marker.key,
          observedAt: marker.latest.observedAt,
          source: 'local',
          kind: 'source-unavailable',
          outcome: 'missing',
        });
      }
      continue;
    }
    const fact = observation(marker, 'local', now, remainders);
    if (fact === null) {
      continue;
    }
    const evidence = { key: marker.key, observedAt: fact.observedAt, source: 'local' as const };
    if (fact.dirty || (fact.modifiedCount ?? 0) + (fact.stagedCount ?? 0) + (fact.untrackedCount ?? 0) > 0) {
      remainders.push({
        ...evidence,
        kind: 'local-files',
        modified: fact.modifiedCount,
        staged: fact.stagedCount,
        untracked: fact.untrackedCount,
      });
    }
    if ((fact.ahead ?? 0) > 0) {
      remainders.push({ ...evidence, kind: 'unpushed-commits', count: fact.ahead ?? 0 });
    }
    if (
      fact.dirty === null ||
      fact.ahead === null ||
      fact.modifiedCount === null ||
      fact.stagedCount === null ||
      fact.untrackedCount === null
    ) {
      remainders.push({ ...evidence, kind: 'source-unknown' });
    }
  }
};

const pullRequestRemainders = (row: WorkThreadRow, now: number, remainders: WorkThreadRemainder[]) => {
  for (const marker of row.markers.pullRequests) {
    const fact = observation(marker, 'github', now, remainders);
    if (fact === null) {
      continue;
    }
    const evidence = { key: marker.key, observedAt: fact.observedAt, source: 'github' as const };
    if (fact.state === null) {
      remainders.push({ ...evidence, kind: 'source-unknown' });
    }
    if (fact.state !== 'OPEN') {
      continue;
    }
    // Someone else's pull request: its conflicts, checks and drafts are the author's work, not the operator's.
    if (marker.role === 'review-requested' || marker.role === 'team-review-requested') {
      remainders.push({ ...evidence, kind: marker.role });
      continue;
    }
    const priorCount = remainders.length;
    if (fact.reviewDecision === 'CHANGES_REQUESTED') {
      remainders.push({ ...evidence, kind: 'changes-requested' });
    }
    if (fact.checksRollup === 'failure') {
      remainders.push({ ...evidence, kind: 'failing-checks' });
    }
    if (fact.checksRollup === 'pending') {
      remainders.push({ ...evidence, kind: 'pending-checks' });
    }
    if (marker.mergeable === 'conflicting' || marker.mergeStateStatus === 'DIRTY') {
      remainders.push({ ...evidence, kind: 'merge-conflict', baseRef: fact.baseRef });
    }
    if (marker.mergeStateStatus === 'BEHIND') {
      remainders.push({ ...evidence, kind: 'behind-base', baseRef: fact.baseRef });
    }
    const unresolved = fact.unresolvedReviewThreads;
    if (typeof unresolved === 'number' && Number.isSafeInteger(unresolved) && unresolved > 0) {
      remainders.push({ ...evidence, kind: 'unresolved-review-threads', count: unresolved });
    }
    if (fact.reviewDecision === 'REVIEW_REQUIRED') {
      remainders.push({ ...evidence, kind: 'awaiting-review' });
    }
    if (fact.draft === true) {
      remainders.push({ ...evidence, kind: 'draft-pr' });
    }
    if (
      fact.draft === false &&
      fact.checksRollup === 'success' &&
      marker.mergeable === 'mergeable' &&
      marker.mergeStateStatus === 'CLEAN' &&
      unresolved === 0 &&
      (fact.reviewDecision === 'APPROVED' || fact.reviewDecision === null)
    ) {
      remainders.push({ ...evidence, kind: 'ready-to-merge' });
    }
    if (remainders.length === priorCount) {
      remainders.push({ ...evidence, kind: 'open-pr' });
    }
  }
};

/** Session-wide reports can discuss several PRs. Foreign references disqualify a report
 * as the task's next action; the original report remains available on its session.
 * This does not resolve a request or change the operator's follow state.
 */
export const taskNativeRequests = (row: WorkThreadRow): readonly WorkThreadNativeRequest[] => {
  const numbers = new Set(
    row.markers.pullRequests.flatMap((marker) => {
      const fact = marker.latestSuccessful ?? marker.latest;
      return fact ? [String(fact.number)] : [];
    }),
  );
  const urls = new Set(
    row.markers.pullRequests.flatMap((marker) => {
      const fact = marker.latestSuccessful ?? marker.latest;
      return fact ? [`${fact.host}/${fact.repository}/pull/${fact.number}`.toLowerCase()] : [];
    }),
  );
  return row.nativeRequests.filter((request) => {
    if (request.state !== 'open' && request.state !== 'uncertain') {
      return false;
    }
    if (request.evidence !== 'claude-desktop-declaration' || numbers.size === 0) {
      return true;
    }
    const references = [...request.text.matchAll(/#(\d+)\b/g)].map((match) => match[1]);
    const qualified = [...request.text.matchAll(/https?:\/\/([^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+)\b/g)].map((match) =>
      match[1]?.toLowerCase(),
    );
    return (
      references.every((number) => number !== undefined && numbers.has(number)) &&
      qualified.every((url) => url !== undefined && urls.has(url))
    );
  });
};

/**
 * Whether the task's pull requests all reached an end: `merged` when at least one merged (the
 * others may be closed, superseded attempts), `closed` when all were closed without merge. A merge
 * is terminal, so it counts by its last known state. A closed pull request can reopen, so its
 * closing counts only while the latest read itself observed it. `null` without a pull request,
 * while one is open or of unknown state, or while an active pull request link has no observation
 * at all.
 */
export const settledPullRequests = (row: WorkThreadRow): 'merged' | 'closed' | null => {
  const markers = row.markers.pullRequests;
  const unobservedLink = row.links.some(
    (link) =>
      link.kind === 'pull-request' && link.detachedAt === null && !markers.some((marker) => marker.key === link.key),
  );
  if (markers.length === 0 || unobservedLink) {
    return null;
  }
  const states = markers.map((marker) => {
    const state = lastKnown(marker)?.state ?? null;
    return state === 'CLOSED' && marker.latest?.outcome !== 'observed' ? null : state;
  });
  if (!states.every((state) => state === 'MERGED' || state === 'CLOSED')) {
    return null;
  }
  return states.includes('MERGED') ? 'merged' : 'closed';
};

/**
 * Whether GitHub is read and current for every pull request last known as closed. A closed pull
 * request can reopen, so beside a merged one it still counts as settled only on a current read.
 */
const closedPullRequestsRead = (row: WorkThreadRow, remainders: readonly WorkThreadRemainder[]): boolean => {
  const closed = new Set(
    row.markers.pullRequests.filter((marker) => lastKnown(marker)?.state === 'CLOSED').map((marker) => marker.key),
  );
  return !remainders.some(
    (remainder) => remainder.source === 'github' && isUnreadRemainder(remainder) && closed.has(remainder.key),
  );
};

const deriveRemainders = (row: WorkThreadRow, now: number): readonly WorkThreadRemainder[] => {
  const remainders: WorkThreadRemainder[] = [];
  for (const request of taskNativeRequests(row)) {
    if (request.state === 'open' || request.state === 'uncertain') {
      remainders.push({
        key: request.key,
        observedAt: request.askedAt,
        source: 'sessions',
        kind: 'native-request',
        request,
      });
    }
  }
  if (row.nativeRequestCoverage === 'partial') {
    remainders.push({ key: row.thread.threadId, observedAt: null, source: 'sessions', kind: 'source-unknown' });
  }
  localRemainders(row, now, remainders);
  pullRequestRemainders(row, now, remainders);
  // While a pull request is open, an unfinished ticket is its expected state, not a separate step.
  const pullRequestOpen = row.markers.pullRequests.some((marker) => lastKnown(marker)?.state === 'OPEN');
  // The same rule that suggests an end says the work merged: a superseded, closed attempt beside it changes nothing.
  const merged = settledPullRequests(row) === 'merged';
  for (const marker of row.markers.jiraIssues) {
    const fact = observation(marker, 'jira', now, remainders);
    if (fact === null) {
      continue;
    }
    const evidence = { key: marker.key, observedAt: fact.observedAt, source: 'jira' as const };
    if (fact.statusCategory === null || fact.statusCategory === 'unknown') {
      remainders.push({ ...evidence, kind: 'source-unknown' });
    } else if (fact.statusCategory !== 'done' && fact.handedOff === true && merged) {
      remainders.push({ ...evidence, kind: 'jira-after-merge' });
    } else if (fact.statusCategory !== 'done' && !pullRequestOpen) {
      remainders.push({ ...evidence, kind: 'jira-open' });
    }
  }
  for (const link of row.links) {
    if (link.detachedAt !== null || link.kind === 'session') {
      continue;
    }
    const markers = {
      'pull-request': row.markers.pullRequests,
      'jira-issue': row.markers.jiraIssues,
      branch: row.markers.local,
    }[link.kind];
    if (!markers.some((marker) => marker.key === link.key)) {
      remainders.push({
        key: link.key,
        observedAt: null,
        source: ({ 'pull-request': 'github', 'jira-issue': 'jira', branch: 'local' } as const)[link.kind],
        kind: 'source-unknown',
      });
    }
  }
  // A linked child may already be nested below another linked session. Counts can establish
  // insufficient observed evidence, but cannot identify which particular key is missing.
  if (
    row.links.filter((link) => link.kind === 'session' && link.detachedAt === null).length >
    row.sessionCount + row.delegatedSessionCount
  ) {
    remainders.push({ key: row.thread.threadId, observedAt: null, source: 'sessions', kind: 'source-unknown' });
  }
  if (row.runningSessions > 0) {
    remainders.push({
      key: row.thread.threadId,
      observedAt: row.lastActivityAt,
      source: 'sessions',
      kind: 'running-session',
      count: row.runningSessions,
    });
  }
  return remainders;
};

const PRIORITY: readonly WorkThreadRemainder['kind'][] = [
  'merge-conflict',
  // A counted set of review threads is the concrete work behind a CHANGES_REQUESTED decision.
  'unresolved-review-threads',
  'changes-requested',
  'failing-checks',
  'review-requested',
  'native-request',
  'local-files',
  'unpushed-commits',
  'jira-open',
  'draft-pr',
  'pending-checks',
  'ready-to-merge',
  'awaiting-review',
  'jira-after-merge',
  'team-review-requested',
  // Strict branch protection makes an update necessary only once review is settled; updating earlier
  // is undone by the next merge to the base, so awaiting review outranks it.
  'behind-base',
  'open-pr',
  'source-unavailable',
  'source-stale',
  'source-unknown',
];

/**
 * Facts can suggest an end, but only an operator command ends the follow-up. Known facts rank a
 * task; an unread source never ranks a task that a known fact ranks, and stays listed in
 * `remainders` to be acknowledged.
 */
export const deriveWorkThreadSituation = (
  row: WorkThreadRow,
  now: string | number | Date,
  additionalRemainders: readonly WorkThreadRemainder[] = [],
): WorkThreadSituation => {
  const epoch = typeof now === 'number' ? now : new Date(now).getTime();
  if (!Number.isFinite(epoch)) {
    throw new RangeError('A valid observation time is required.');
  }
  const remainders = [...deriveRemainders(row, epoch), ...additionalRemainders];
  if (row.thread.followState === 'done') {
    return { hint: 'done', reason: 'follow-up-ended', action: 'reopen', remainders };
  }
  if (row.thread.followState === 'waiting' && !remainders.some((item) => item.kind === 'native-request')) {
    return { hint: 'waiting', reason: 'explicit-wait', action: 'copy-context', remainders };
  }
  if (row.runningSessions > 0) {
    return { hint: 'in-progress', reason: 'running-session', action: 'resume-session', remainders };
  }
  if (remainders.every(isUnreadRemainder)) {
    // Absence cannot be asserted through an unread source, so only a fully read task has "nothing left".
    if (remainders.length === 0 && (row.thread.intent === 'analysis' || row.thread.intent === 'review')) {
      return { hint: 'ready-to-close', reason: 'no-remainder', action: 'end-follow-up', remainders };
    }
    // Merged is terminal: its last known state ranks the task whatever stayed unread. Closed is not
    // (a closed pull request can reopen), so a closing suggests an end only while GitHub is read and
    // current, alone or beside a merge; otherwise the task falls through to its unread sources.
    const settled = settledPullRequests(row);
    if (settled === 'merged' && closedPullRequestsRead(row, remainders)) {
      return { hint: 'ready-to-close', reason: 'merged-complete', action: 'end-follow-up', remainders };
    }
    if (settled === 'closed' && !remainders.some((remainder) => remainder.source === 'github')) {
      return { hint: 'ready-to-close', reason: 'closed-unmerged', action: 'end-follow-up', remainders };
    }
    if (remainders.length === 0) {
      return { hint: 'undecided', reason: 'next-step', action: 'copy-context', remainders };
    }
  }
  const reason = PRIORITY.find((kind) => remainders.some((remainder) => remainder.kind === kind)) ?? 'source-unknown';
  const evidence = remainders.find((remainder) => remainder.kind === reason);
  let hint: WorkThreadSituation['hint'] =
    reason.startsWith('source-') || reason === 'team-review-requested' ? 'undecided' : 'to-resume';
  if (reason === 'pending-checks' || reason === 'awaiting-review' || reason === 'jira-after-merge') {
    hint = 'waiting';
  }
  const actions = { github: 'open-pr', jira: 'open-jira', local: 'copy-context', sessions: 'copy-context' } as const;
  const sourceAction = evidence === undefined ? 'copy-context' : actions[evidence.source];
  return {
    hint,
    reason,
    action: reason === 'native-request' ? 'resume-session' : sourceAction,
    remainders,
  };
};
