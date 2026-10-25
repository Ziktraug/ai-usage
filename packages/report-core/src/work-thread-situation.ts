import type { CanonicalInstant } from './canonical-instant';
import type { WorkThreadFact, WorkThreadRow } from './work-thread-view';

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
    | {
        readonly kind: 'local-files';
        readonly modified: number | null;
        readonly staged: number | null;
        readonly untracked: number | null;
      }
    // TODO(W1): one line per new kind: `unresolved-review-threads` (GitHub's unresolved review threads).
    | { readonly kind: 'unpushed-commits' | 'running-session' | 'unresolved-review-threads'; readonly count: number }
    | { readonly kind: 'merge-conflict' | 'behind-base'; readonly baseRef: string | null }
    | { readonly kind: 'source-unavailable'; readonly outcome: string }
    | {
        // TODO(W1): document `awaiting-review` (others' turn), `draft-pr`, `ready-to-merge` (the
        // operator's move); `open-pr` stays the fallback when none of them can be established.
        readonly kind:
          | 'open-pr'
          | 'awaiting-review'
          | 'changes-requested'
          | 'draft-pr'
          | 'failing-checks'
          | 'pending-checks'
          | 'ready-to-merge'
          | 'review-requested'
          | 'jira-open'
          | 'source-stale'
          | 'source-unknown';
      }
  );
export type Remainder = WorkThreadRemainder;
export interface WorkThreadSituation {
  readonly action: 'reopen' | 'end-follow-up' | 'resume-session' | 'open-pr' | 'open-jira' | 'copy-context';
  readonly hint: 'to-resume' | 'in-progress' | 'ready-to-close' | 'waiting' | 'undecided' | 'done';
  readonly reason:
    | WorkThreadRemainder['kind']
    | 'follow-up-ended'
    | 'explicit-wait'
    | 'no-remainder'
    | 'merged-complete'
    | 'next-step';
  readonly remainders: readonly WorkThreadRemainder[];
}
interface DatedObservation {
  readonly observedAt: CanonicalInstant;
  readonly outcome: string;
}

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
  const value = latest?.outcome === 'observed' ? latest : fact.latestSuccessful;
  if (value !== null && now - Date.parse(value.observedAt) > WORK_THREAD_STALE_AFTER_MS) {
    remainders.push({ ...evidence, observedAt: value.observedAt, kind: 'source-stale' });
  }
  return value?.outcome === 'observed' ? value : null;
};

const localRemainders = (row: WorkThreadRow, now: number, remainders: WorkThreadRemainder[]) => {
  for (const marker of row.markers.local) {
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
    remainders.push({ ...evidence, kind: 'open-pr' });
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
    if (marker.role === 'review-requested') {
      remainders.push({ ...evidence, kind: 'review-requested' });
    }
  }
};

const deriveRemainders = (row: WorkThreadRow, now: number): readonly WorkThreadRemainder[] => {
  const remainders: WorkThreadRemainder[] = [];
  localRemainders(row, now, remainders);
  pullRequestRemainders(row, now, remainders);
  for (const marker of row.markers.jiraIssues) {
    const fact = observation(marker, 'jira', now, remainders);
    if (fact === null) {
      continue;
    }
    const evidence = { key: marker.key, observedAt: fact.observedAt, source: 'jira' as const };
    if (fact.statusCategory === null || fact.statusCategory === 'unknown') {
      remainders.push({ ...evidence, kind: 'source-unknown' });
    } else if (fact.statusCategory !== 'done') {
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
  'changes-requested',
  'failing-checks',
  'behind-base',
  'review-requested',
  'local-files',
  'unpushed-commits',
  'jira-open',
  'pending-checks',
  'open-pr',
  'source-unavailable',
  'source-stale',
  'source-unknown',
];

/** Facts can suggest an end, but only an operator command ends the follow-up. */
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
  if (row.thread.followState === 'waiting') {
    return { hint: 'waiting', reason: 'explicit-wait', action: 'copy-context', remainders };
  }
  if (row.runningSessions > 0) {
    return { hint: 'in-progress', reason: 'running-session', action: 'resume-session', remainders };
  }
  if (remainders.length === 0) {
    if (row.thread.intent === 'analysis' || row.thread.intent === 'review') {
      return { hint: 'ready-to-close', reason: 'no-remainder', action: 'end-follow-up', remainders };
    }
    if (
      row.thread.intent === 'change' &&
      row.markers.pullRequests.length > 0 &&
      row.markers.pullRequests.every(
        (marker) => marker.latest?.outcome === 'observed' && marker.latest.state === 'MERGED',
      )
    ) {
      return { hint: 'ready-to-close', reason: 'merged-complete', action: 'end-follow-up', remainders };
    }
    return { hint: 'undecided', reason: 'next-step', action: 'copy-context', remainders };
  }
  const reason = PRIORITY.find((kind) => remainders.some((remainder) => remainder.kind === kind)) ?? 'source-unknown';
  const evidence = remainders.find((remainder) => remainder.kind === reason);
  let hint: WorkThreadSituation['hint'] = reason.startsWith('source-') ? 'undecided' : 'to-resume';
  if (reason === 'pending-checks') {
    hint = 'waiting';
  }
  const actions = { github: 'open-pr', jira: 'open-jira', local: 'copy-context', sessions: 'copy-context' } as const;
  return {
    hint,
    reason,
    action: evidence === undefined ? 'copy-context' : actions[evidence.source],
    remainders,
  };
};
