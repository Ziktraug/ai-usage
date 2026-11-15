import { describe, expect, test } from 'bun:test';
import { parseCanonicalInstant } from './canonical-instant';
import type { CheckoutStatusObservation, JiraIssueObservation, PullRequestObservation } from './work-attention';
import type { WorkThread, WorkThreadLink } from './work-thread';
import {
  deriveWorkThreadSituation,
  isUnreadRemainder,
  settledPullRequests,
  type WorkThreadRemainder,
} from './work-thread-situation';
import type { WorkThreadLocalMarker, WorkThreadPullRequestMarker, WorkThreadRow } from './work-thread-view';

const at = parseCanonicalInstant('2026-10-24T10:00:00.000Z');
const older = parseCanonicalInstant('2026-10-01T10:00:00.000Z');
const id = '10000000-0000-4000-8000-000000000001';
const thread: WorkThread = {
  createdAt: at,
  updatedAt: at,
  doneAt: null,
  doneReason: null,
  followRevision: 1,
  followState: 'following',
  intent: 'change',
  machineId: 'test',
  note: null,
  objective: null,
  origin: 'user',
  originKey: null,
  projectLabel: 'Test',
  threadId: id,
  title: 'Task',
  waitingFor: null,
  waitingOn: null,
};
const row = (patch: Partial<WorkThreadRow> = {}): WorkThreadRow => ({
  nativeRequests: [],
  nativeRequestCoverage: 'complete',
  afterDone: null,
  combinedThreads: [],
  firstActivityAt: at,
  lastActivityAt: at,
  links: [],
  markers: { jiraIssues: [], local: [], pullRequests: [] },
  marks: [],
  runningSessions: 0,
  delegatedSessionCount: 0,
  sessionCount: 0,
  thread,
  ...patch,
});
const pr = (patch: Partial<PullRequestObservation> = {}): PullRequestObservation => ({
  accountLabel: null,
  baseRef: 'release/next',
  checksRollup: 'success',
  draft: false,
  headRef: 'topic',
  host: 'github.com',
  machineId: 'test',
  mergedAt: null,
  number: 42,
  observedAt: at,
  outcome: 'observed',
  outcomeMessage: null,
  repository: 'test/repo',
  reviewDecision: null,
  state: 'OPEN',
  title: 'Task',
  updatedAt: at,
  url: 'https://github.com/test/repo/pull/42',
  ...patch,
});
/** Local-marker fields the situation never reads. */
const localRead = { checkoutPath: '/synthetic', lastSessionActivityAt: null } as const;
const local = (patch: Partial<CheckoutStatusObservation> = {}): CheckoutStatusObservation => ({
  ahead: 0,
  behind: 0,
  branch: 'topic',
  checkoutPath: '/synthetic',
  dirty: false,
  headSha: null,
  lastCommitAt: at,
  machineId: 'test',
  modifiedCount: 0,
  observedAt: at,
  outcome: 'observed',
  stagedCount: 0,
  untrackedCount: 0,
  upstream: 'origin/topic',
  ...patch,
});
const jira = (patch: Partial<JiraIssueObservation> = {}): JiraIssueObservation => ({
  assigneeLabel: null,
  commentCount: 0,
  comments: [],
  key: 'TEST-1',
  machineId: 'test',
  observedAt: at,
  outcome: 'observed',
  outcomeMessage: null,
  parentKey: null,
  sprint: null,
  status: 'Done',
  statusCategory: 'done',
  summary: 'Task',
  updatedAt: at,
  ...patch,
});
const withPr = (
  fact: PullRequestObservation,
  markerPatch: Partial<Pick<WorkThreadPullRequestMarker, 'mergeable' | 'mergeStateStatus' | 'role'>> = {},
): WorkThreadRow =>
  row({
    markers: {
      local: [],
      jiraIssues: [],
      pullRequests: [
        {
          key: `${fact.host}/${fact.repository}#${fact.number}`,
          latest: fact,
          latestSuccessful: fact.outcome === 'observed' ? fact : null,
          mergeable: 'mergeable',
          mergeStateStatus: 'CLEAN',
          role: null,
          ...markerPatch,
        },
      ],
    },
  });
const kinds = (value: WorkThreadRow) =>
  deriveWorkThreadSituation(value, at).remainders.map((remainder) => remainder.kind);

describe('Work thread situation', () => {
  test('counts only observed unresolved review threads and keeps their source evidence', () => {
    const result = deriveWorkThreadSituation(withPr(pr({ unresolvedReviewThreads: 2 })), at);
    expect(result).toMatchObject({ hint: 'to-resume', reason: 'unresolved-review-threads', action: 'open-pr' });
    expect(result.remainders).toContainEqual({
      key: 'github.com/test/repo#42',
      source: 'github',
      observedAt: at,
      kind: 'unresolved-review-threads',
      count: 2,
    });
    expect(result.remainders.map((remainder) => remainder.kind)).not.toContain('open-pr');
    for (const count of [undefined, null, 0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(kinds(withPr(pr(count === undefined ? {} : { unresolvedReviewThreads: count })))).not.toContain(
        'unresolved-review-threads',
      );
    }
  });
  test('distinguishes waiting for another reviewer from an operator review request', () => {
    const awaiting = withPr(pr({ reviewDecision: 'REVIEW_REQUIRED' }), { role: 'author' });
    expect(deriveWorkThreadSituation(awaiting, at)).toMatchObject({
      hint: 'waiting',
      reason: 'awaiting-review',
      action: 'open-pr',
    });
    expect(kinds(awaiting)).toEqual(['awaiting-review']);
    const requested = withPr(pr({ reviewDecision: 'REVIEW_REQUIRED' }), { role: 'review-requested' });
    expect(deriveWorkThreadSituation(requested, at)).toMatchObject({
      hint: 'to-resume',
      reason: 'review-requested',
      action: 'open-pr',
    });
    expect(kinds(requested)).toEqual(['review-requested']);
    // A request addressed to a team is a candidate to take, not a move the operator owes.
    const team = withPr(pr({ reviewDecision: 'REVIEW_REQUIRED' }), { role: 'team-review-requested' });
    expect(deriveWorkThreadSituation(team, at)).toMatchObject({
      hint: 'undecided',
      reason: 'team-review-requested',
      action: 'open-pr',
    });
    expect(kinds(team)).toEqual(['team-review-requested']);
  });
  test('a draft remains an operator remainder instead of being ready to merge', () => {
    const draft = withPr(pr({ draft: true, reviewDecision: 'APPROVED', unresolvedReviewThreads: 0 }));
    expect(deriveWorkThreadSituation(draft, at)).toMatchObject({
      hint: 'to-resume',
      reason: 'draft-pr',
      action: 'open-pr',
    });
    expect(kinds(draft)).toEqual(['draft-pr']);
  });
  test.each(['APPROVED', null] as const)('green mergeable non-draft with review decision %s is ready', (decision) => {
    const ready = withPr(pr({ reviewDecision: decision, unresolvedReviewThreads: 0 }));
    expect(deriveWorkThreadSituation(ready, at)).toMatchObject({
      hint: 'to-resume',
      reason: 'ready-to-merge',
      action: 'open-pr',
    });
    expect(kinds(ready)).toEqual(['ready-to-merge']);
  });
  test.each([
    ['BLOCKED', 'open-pr'],
    ['UNKNOWN', 'open-pr'],
    ['BEHIND', 'behind-base'],
    ['DIRTY', 'merge-conflict'],
    ['HAS_HOOKS', 'open-pr'],
    ['UNSTABLE', 'open-pr'],
    [null, 'open-pr'],
  ] as const)(
    'merge state %s prevents readiness despite successful checks and approval',
    (mergeStateStatus, expected) => {
      const observed = withPr(pr({ reviewDecision: 'APPROVED', unresolvedReviewThreads: 0 }), { mergeStateStatus });
      expect(kinds(observed)).toEqual([expected]);
      expect(deriveWorkThreadSituation(observed, at).reason).toBe(expected);
    },
  );
  test.each([
    [undefined, 'open-pr'],
    [null, 'open-pr'],
    [2, 'unresolved-review-threads'],
  ] as const)('review thread count %s prevents readiness despite a clean merge state', (count, expected) => {
    const observed = withPr(
      pr({ reviewDecision: 'APPROVED', ...(count === undefined ? {} : { unresolvedReviewThreads: count }) }),
    );
    expect(kinds(observed)).toEqual([expected]);
    expect(deriveWorkThreadSituation(observed, at).reason).toBe(expected);
  });
  test('unknown merge readiness keeps the generic open remainder', () => {
    for (const unknown of [
      withPr(pr({ checksRollup: null, unresolvedReviewThreads: 0 })),
      withPr(pr({ draft: null, unresolvedReviewThreads: 0 })),
      withPr(pr({ reviewDecision: 'COMMENTED', unresolvedReviewThreads: 0 })),
      withPr(pr({ unresolvedReviewThreads: 0 }), { mergeable: 'unknown' }),
      withPr(pr({ unresolvedReviewThreads: 0 }), { mergeable: null }),
    ]) {
      expect(kinds(unknown)).toEqual(['open-pr']);
      expect(deriveWorkThreadSituation(unknown, at).reason).toBe('open-pr');
    }
  });
  test('comments and a finished agent session do not become unresolved threads or approval', () => {
    const commented = withPr(
      pr({
        checksRollup: null,
        title: '2 comments to address',
        updatedAt: at,
      }),
    );
    expect(kinds(commented)).toEqual(['open-pr']);
    const reviewed = withPr(pr({ reviewDecision: 'REVIEW_REQUIRED' }));
    expect(
      deriveWorkThreadSituation(
        {
          ...reviewed,
          sessionCount: 1,
          delegatedSessionCount: 1,
          marks: [{ at, fact: null, kind: 'event', harness: null, label: 'Agent review completed', source: null }],
        },
        at,
      ),
    ).toMatchObject({ hint: 'waiting', reason: 'awaiting-review' });
    expect(kinds(reviewed)).not.toContain('ready-to-merge');
  });
  test.each(['MERGED', 'CLOSED'] as const)('%s PR does not keep open-state remainders', (state) => {
    expect(
      kinds(
        withPr(
          pr({
            state,
            draft: true,
            checksRollup: 'failure',
            reviewDecision: 'REVIEW_REQUIRED',
            unresolvedReviewThreads: 4,
          }),
          { role: 'review-requested', mergeable: 'conflicting' },
        ),
      ),
    ).toEqual([]);
  });
  test('conflicts, requested changes, unresolved threads and failed checks outrank lesser work', () => {
    const blocked = pr({ reviewDecision: 'CHANGES_REQUESTED', unresolvedReviewThreads: 3, checksRollup: 'failure' });
    expect(deriveWorkThreadSituation(withPr(blocked, { mergeable: 'conflicting' }), at).reason).toBe('merge-conflict');
    expect(deriveWorkThreadSituation(withPr(blocked), at).reason).toBe('unresolved-review-threads');
    expect(deriveWorkThreadSituation(withPr(pr({ ...blocked, unresolvedReviewThreads: null })), at).reason).toBe(
      'changes-requested',
    );
    expect(deriveWorkThreadSituation(withPr(pr({ ...blocked, reviewDecision: 'REVIEW_REQUIRED' })), at).reason).toBe(
      'unresolved-review-threads',
    );
    expect(
      deriveWorkThreadSituation(
        withPr(
          pr({
            ...blocked,
            reviewDecision: 'REVIEW_REQUIRED',
            unresolvedReviewThreads: 0,
            draft: true,
          }),
        ),
        at,
      ).reason,
    ).toBe('failing-checks');
  });
  test('specific review and merge actions outrank another open PR without hiding independent blockers', () => {
    const generic = withPr(pr({ number: 43, checksRollup: null })).markers.pullRequests;
    for (const [decision, expected] of [
      [null, 'ready-to-merge'],
      ['REVIEW_REQUIRED', 'awaiting-review'],
    ] as const) {
      const specific = withPr(pr({ reviewDecision: decision, unresolvedReviewThreads: 0 }));
      const combined = {
        ...specific,
        markers: { ...specific.markers, pullRequests: [...generic, ...specific.markers.pullRequests] },
      };
      expect(deriveWorkThreadSituation(combined, at).reason).toBe(expected);
      expect(kinds(combined)).toContain('open-pr');
    }
    const requested = withPr(pr({ unresolvedReviewThreads: 0 }), { role: 'review-requested' });
    expect(kinds(requested)).toEqual(['review-requested']);
    expect(deriveWorkThreadSituation(requested, at).reason).toBe('review-requested');
  });
  test("a ticket's own task, with no declared intent, is ready to close once its PRs merged", () => {
    const value = withPr(pr({ state: 'MERGED' }));
    expect(deriveWorkThreadSituation({ ...value, thread: { ...value.thread, intent: null } }, at)).toMatchObject({
      hint: 'ready-to-close',
      reason: 'merged-complete',
    });
  });
  test('a completed session alone never ends a change follow-up; a merged or closed PR suggests the end', () => {
    expect(deriveWorkThreadSituation(row({ sessionCount: 1 }), at)).toMatchObject({
      hint: 'undecided',
      reason: 'next-step',
      action: 'copy-context',
    });
    expect(deriveWorkThreadSituation(withPr(pr({ state: 'CLOSED' })), at)).toMatchObject({
      hint: 'ready-to-close',
      reason: 'closed-unmerged',
      action: 'end-follow-up',
    });
    expect(deriveWorkThreadSituation(withPr(pr({ state: 'MERGED' })), at)).toMatchObject({
      hint: 'ready-to-close',
      reason: 'merged-complete',
      action: 'end-follow-up',
    });
    // The facts only suggest: the operator's follow state is untouched.
    expect(thread.followState).toBe('following');
  });
  test.each(['analysis', 'review'] as const)('%s can finish with no technical artifacts', (intent) => {
    expect(deriveWorkThreadSituation(row({ thread: { ...thread, intent } }), at).hint).toBe('ready-to-close');
  });
  test('includes all local counts, unpushed commits and dated running-session evidence', () => {
    const fact = local({ dirty: true, modifiedCount: 2, stagedCount: 3, untrackedCount: 4, ahead: 5 });
    const value = row({
      runningSessions: 2,
      markers: {
        local: [{ ...localRead, key: 'checkout', latest: fact, latestSuccessful: fact, via: 'session-checkout' }],
        jiraIssues: [],
        pullRequests: [],
      },
    });
    expect(deriveWorkThreadSituation(value, at)).toMatchObject({ hint: 'in-progress', reason: 'running-session' });
    expect(deriveWorkThreadSituation(value, at).remainders).toEqual([
      { key: 'checkout', source: 'local', observedAt: at, kind: 'local-files', modified: 2, staged: 3, untracked: 4 },
      { key: 'checkout', source: 'local', observedAt: at, kind: 'unpushed-commits', count: 5 },
      { key: id, source: 'sessions', observedAt: at, kind: 'running-session', count: 2 },
    ]);
  });
  test("a requested review leaves the author's blockers to the author", () => {
    const value = withPr(pr({ reviewDecision: 'CHANGES_REQUESTED', checksRollup: 'failure' }));
    const marker = value.markers.pullRequests[0];
    if (!marker) {
      throw new Error('Missing fixture marker');
    }
    const observed = {
      ...value,
      markers: {
        ...value.markers,
        pullRequests: [
          {
            ...marker,
            mergeable: 'conflicting' as const,
            mergeStateStatus: 'DIRTY',
            role: 'review-requested' as const,
          },
        ],
      },
    };
    expect(kinds(observed)).toEqual(['review-requested']);
    expect(deriveWorkThreadSituation(observed, at)).toMatchObject({
      hint: 'to-resume',
      reason: 'review-requested',
      action: 'open-pr',
    });
    const authored = {
      ...observed,
      markers: {
        ...observed.markers,
        pullRequests: [
          { ...marker, role: 'author' as const, mergeable: 'conflicting' as const, mergeStateStatus: 'DIRTY' },
        ],
      },
    };
    expect(kinds(authored)).toEqual(['changes-requested', 'failing-checks', 'merge-conflict']);
    expect(deriveWorkThreadSituation(authored, at)).toMatchObject({ reason: 'merge-conflict', action: 'open-pr' });
    expect(deriveWorkThreadSituation(authored, at).remainders.find((r) => r.kind === 'merge-conflict')).toMatchObject({
      baseRef: 'release/next',
    });
  });
  test('behind uses the PR base and is distinct from conflict', () => {
    const value = withPr(pr({ unresolvedReviewThreads: 0 }));
    const marker = value.markers.pullRequests[0];
    if (!marker) {
      throw new Error('Missing fixture marker');
    }
    const observed = {
      ...value,
      markers: { ...value.markers, pullRequests: [{ ...marker, mergeStateStatus: 'BEHIND' }] },
    };
    expect(kinds(observed)).toEqual(['behind-base']);
    expect(deriveWorkThreadSituation(observed, at).reason).toBe('behind-base');
    expect(deriveWorkThreadSituation(observed, at).remainders[0]).toMatchObject({
      baseRef: 'release/next',
      observedAt: at,
    });
  });
  test('behind the base waits while review is still required', () => {
    const value = withPr(pr({ reviewDecision: 'REVIEW_REQUIRED', unresolvedReviewThreads: 0 }));
    const marker = value.markers.pullRequests[0];
    if (!marker) {
      throw new Error('Missing fixture marker');
    }
    const behind = {
      ...value,
      markers: { ...value.markers, pullRequests: [{ ...marker, mergeStateStatus: 'BEHIND' }] },
    };
    expect(kinds(behind)).toEqual(['behind-base', 'awaiting-review']);
    expect(deriveWorkThreadSituation(behind, at)).toMatchObject({ hint: 'waiting', reason: 'awaiting-review' });
  });
  test('an open PR makes its unfinished ticket expected, not a separate step', () => {
    const value = withPr(pr({ reviewDecision: 'REVIEW_REQUIRED', unresolvedReviewThreads: 0 }));
    const fact = jira({ statusCategory: 'in-progress' });
    const linked = {
      ...value,
      markers: { ...value.markers, jiraIssues: [{ key: 'jira:default/TEST-1', latest: fact, latestSuccessful: fact }] },
    };
    expect(kinds(linked)).toEqual(['awaiting-review']);
    expect(deriveWorkThreadSituation(linked, at)).toMatchObject({ hint: 'waiting', reason: 'awaiting-review' });
  });
  test('pending CI waits and an approved open PR still has a remainder', () => {
    expect(
      deriveWorkThreadSituation(withPr(pr({ checksRollup: 'pending', unresolvedReviewThreads: 0 })), at),
    ).toMatchObject({
      hint: 'waiting',
      reason: 'pending-checks',
    });
    expect(kinds(withPr(pr({ reviewDecision: 'APPROVED', unresolvedReviewThreads: 0 })))).toEqual(['ready-to-merge']);
  });
  test('merged PR does not hide Jira work', () => {
    const value = withPr(pr({ state: 'MERGED' }));
    const fact = jira({ statusCategory: 'in-progress' });
    expect(
      deriveWorkThreadSituation(
        {
          ...value,
          markers: {
            ...value.markers,
            jiraIssues: [{ key: 'jira:default/TEST-1', latest: fact, latestSuccessful: fact }],
          },
        },
        at,
      ),
    ).toMatchObject({ hint: 'to-resume', reason: 'jira-open', action: 'open-jira' });
  });
  test('a status the operator names as handed off waits once every PR merged, and only then', () => {
    const withTicket = (state: 'MERGED' | 'OPEN') => {
      const value = withPr(pr({ state, reviewDecision: 'APPROVED', unresolvedReviewThreads: 0 }));
      const fact = { ...jira({ statusCategory: 'in-progress', status: 'To Review (IT)' }), handedOff: true as const };
      return {
        ...value,
        markers: {
          ...value.markers,
          jiraIssues: [{ key: 'jira:default/TEST-1', latest: fact, latestSuccessful: fact }],
        },
      };
    };
    expect(deriveWorkThreadSituation(withTicket('MERGED'), at)).toMatchObject({
      hint: 'waiting',
      reason: 'jira-after-merge',
      action: 'open-jira',
    });
    expect(kinds(withTicket('OPEN'))).not.toContain('jira-after-merge');
  });
  test('a handed-off ticket waits once a PR merged, even beside a superseded attempt closed without merge', () => {
    const superseded = withPr(pr({ number: 41, state: 'CLOSED' })).markers.pullRequests;
    const value = withPr(pr({ state: 'MERGED' }));
    const fact = { ...jira({ statusCategory: 'in-progress', status: 'To Review (IT)' }), handedOff: true as const };
    const handedOff = {
      ...value,
      markers: {
        ...value.markers,
        pullRequests: [...superseded, ...value.markers.pullRequests],
        jiraIssues: [{ key: 'jira:default/TEST-1', latest: fact, latestSuccessful: fact }],
      },
    };
    expect(settledPullRequests(handedOff)).toBe('merged');
    expect(kinds(handedOff)).toEqual(['jira-after-merge']);
    expect(deriveWorkThreadSituation(handedOff, at)).toMatchObject({
      hint: 'waiting',
      reason: 'jira-after-merge',
      action: 'open-jira',
    });
    // A closed attempt that may have reopened settles nothing, so the ticket is not handed off yet.
    const [attempt] = superseded;
    if (!attempt) {
      throw new Error('Missing fixture marker');
    }
    const unreadAttempt = {
      ...attempt,
      latest: pr({ number: 41, state: null, outcome: 'network' }),
      latestSuccessful: attempt.latest,
    };
    expect(
      kinds({
        ...handedOff,
        markers: { ...handedOff.markers, pullRequests: [unreadAttempt, ...value.markers.pullRequests] },
      }),
    ).toEqual(['source-unavailable', 'jira-open']);
  });
  test('known failing checks stay actionable while a truncated session read remains visible', () => {
    const unavailable = {
      key: 'session:test/codex/one',
      source: 'sessions' as const,
      observedAt: at,
      kind: 'source-unavailable' as const,
      outcome: 'truncated',
    };
    const result = deriveWorkThreadSituation(withPr(pr({ checksRollup: 'failure' })), at, [unavailable]);
    expect(result).toMatchObject({ hint: 'to-resume', reason: 'failing-checks', action: 'open-pr' });
    expect(result.remainders).toContainEqual(unavailable);
    expect(result.remainders.map((item) => item.kind)).toEqual(['failing-checks', 'source-unavailable']);
  });
  test('Jira work, pending checks and an open PR rank ahead of missing or stale reads', () => {
    const issue = jira({ statusCategory: 'in-progress', observedAt: older });
    const value = row({
      markers: {
        local: [{ ...localRead, key: 'checkout', latest: null, latestSuccessful: null, via: 'session-checkout' }],
        jiraIssues: [{ key: 'jira:default/TEST-1', latest: issue, latestSuccessful: issue }],
        pullRequests: [],
      },
    });
    const result = deriveWorkThreadSituation(value, at);
    expect(result).toMatchObject({ hint: 'to-resume', reason: 'jira-open', action: 'open-jira' });
    expect(result.remainders.map((item) => item.kind)).toEqual(['source-unknown', 'source-stale', 'jira-open']);
    const unknown = { key: id, source: 'sessions' as const, observedAt: null, kind: 'source-unknown' as const };
    expect(deriveWorkThreadSituation(withPr(pr({ checksRollup: 'pending' })), at, [unknown])).toMatchObject({
      hint: 'waiting',
      reason: 'pending-checks',
      action: 'open-pr',
    });
    expect(deriveWorkThreadSituation(withPr(pr({ checksRollup: null })), at, [unknown])).toMatchObject({
      reason: 'open-pr',
      action: 'open-pr',
    });
    expect(deriveWorkThreadSituation(row({ thread: { ...thread, intent: 'analysis' } }), at, [unknown])).toMatchObject({
      hint: 'undecided',
      reason: 'source-unknown',
      remainders: [unknown],
    });
  });
  test('explicitly linked children count as observed sessions without becoming root work', () => {
    const links = ['root', 'child'].map((key) => ({
      createdAt: at,
      detachedAt: null,
      key: `session:test/codex/${key}`,
      kind: 'session' as const,
      linkId: id,
      provenance: 'user' as const,
      threadId: id,
    }));
    const observed = row({ links, sessionCount: 1, delegatedSessionCount: 1 });
    expect(kinds(observed)).toEqual([]);
    expect(kinds({ ...observed, delegatedSessionCount: 0 })).toEqual(['source-unknown']);
  });
  test('failed latest read preserves previous fact with both observation dates', () => {
    const previous = pr({ state: 'MERGED', observedAt: older });
    const failed = pr({ state: null, outcome: 'unauthenticated' });
    const value = row({
      markers: {
        local: [],
        jiraIssues: [],
        pullRequests: [
          {
            key: 'github.com/test/repo#42',
            latest: failed,
            latestSuccessful: previous,
            mergeable: null,
            mergeStateStatus: null,
            role: null,
          },
        ],
      },
    });
    expect(deriveWorkThreadSituation(value, at).remainders).toEqual([
      {
        key: 'github.com/test/repo#42',
        source: 'github',
        observedAt: at,
        kind: 'source-unavailable',
        outcome: 'unauthenticated',
      },
      { key: 'github.com/test/repo#42', source: 'github', observedAt: older, kind: 'source-stale' },
    ]);
    // Merged is terminal: the last known state still ranks the task while the failed read stays listed.
    expect(deriveWorkThreadSituation(value, at)).toMatchObject({
      hint: 'ready-to-close',
      reason: 'merged-complete',
      action: 'end-follow-up',
    });
  });
  test('a merged PR stays ready to close when its read is stale, and the stale read is still listed', () => {
    const stale = deriveWorkThreadSituation(withPr(pr({ state: 'MERGED', observedAt: older })), at);
    expect(stale).toMatchObject({ hint: 'ready-to-close', reason: 'merged-complete', action: 'end-follow-up' });
    expect(stale.remainders).toEqual([
      { key: 'github.com/test/repo#42', source: 'github', observedAt: older, kind: 'source-stale' },
    ]);
    const fresh = deriveWorkThreadSituation(withPr(pr({ state: 'MERGED' })), at);
    expect(fresh).toMatchObject({ hint: 'ready-to-close', reason: 'merged-complete' });
    expect(fresh.remainders).toEqual([]);
  });
  test.each(['pull-request', 'jira-issue', 'branch', 'session'] as const)(
    'missing linked %s evidence is unknown',
    (kind) => {
      const value = row({
        thread: { ...thread, intent: 'analysis' },
        links: [
          { createdAt: at, detachedAt: null, key: 'missing', kind, linkId: id, provenance: 'user', threadId: id },
        ],
      });
      expect(kinds(value)).toContain('source-unknown');
      expect(deriveWorkThreadSituation(value, at).hint).toBe('undecided');
    },
  );
  test('unknown local counts and Jira category remain explicit', () => {
    const fact = local({ modifiedCount: null });
    const issue = jira({ statusCategory: 'unknown' });
    expect(
      kinds(
        row({
          markers: {
            local: [{ ...localRead, key: 'checkout', latest: fact, latestSuccessful: fact, via: 'branch-link' }],
            jiraIssues: [{ key: 'jira', latest: issue, latestSuccessful: issue }],
            pullRequests: [],
          },
        }),
      ),
    ).toEqual(['source-unknown', 'source-unknown']);
  });
  test('explicit waiting and Done survive changing facts and retain remainders', () => {
    const value = withPr(pr());
    expect(
      deriveWorkThreadSituation({ ...value, thread: { ...thread, followState: 'waiting', waitingFor: 'Review' } }, at),
    ).toMatchObject({ hint: 'waiting', reason: 'explicit-wait' });
    const done = deriveWorkThreadSituation({ ...value, thread: { ...thread, followState: 'done', doneAt: at } }, at);
    expect(done).toMatchObject({ hint: 'done', action: 'reopen' });
    expect(done.remainders).toHaveLength(1);
  });
  test('invalid now cannot make observations silently fresh', () => {
    expect(() => deriveWorkThreadSituation(row(), 'invalid')).toThrow(RangeError);
  });
});

test('native requests keep personal state independent, preserve other remainder priority, and block ready-to-close', () => {
  const request = {
    key: 'request',
    sessionKey: 'session:test/codex/one',
    machineId: 'test',
    harness: 'codex',
    sourceSessionId: 'one',
    callId: 'call',
    questionId: 'q',
    askedAt: at,
    answeredAt: null,
    observedAt: at,
    text: 'Choose?',
    state: 'open' as const,
    evidence: 'codex-request-user-input' as const,
    detail: 'No attributable answer.',
  };
  for (const followState of ['following', 'waiting', 'done'] as const) {
    const task = row({ thread: { ...thread, intent: 'analysis', followState }, nativeRequests: [request] });
    const situation = deriveWorkThreadSituation(task, at);
    expect(situation.remainders.map((item) => item.kind)).toContain('native-request');
    expect(situation.hint).not.toBe('ready-to-close');
    expect(task.thread.followState).toBe(followState);
    expect(situation.reason).toBe(followState === 'done' ? 'follow-up-ended' : 'native-request');
  }
  expect(
    deriveWorkThreadSituation({ ...withPr(pr({ checksRollup: 'failure' })), nativeRequests: [request] }, at).reason,
  ).toBe('failing-checks');
  const unrelated = {
    ...request,
    evidence: 'claude-desktop-declaration' as const,
    text: '#42 merged; waiting on #99 CI',
  };
  const multiTaskSession = { ...withPr(pr({ state: 'MERGED', mergedAt: at })), nativeRequests: [unrelated] };
  expect(kinds(multiTaskSession)).not.toContain('native-request');
  expect(multiTaskSession.nativeRequests).toEqual([unrelated]);
  expect(
    deriveWorkThreadSituation(row({ thread: { ...thread, intent: 'analysis' }, nativeRequestCoverage: 'partial' }), at)
      .hint,
  ).not.toBe('ready-to-close');
});

const localMarker = (
  latest: CheckoutStatusObservation | null,
  latestSuccessful: CheckoutStatusObservation | null = latest?.outcome === 'observed' ? latest : null,
): WorkThreadLocalMarker => ({ ...localRead, key: 'checkout', via: 'session-checkout', latest, latestSuccessful });
const withLocal = (value: WorkThreadRow, ...markers: readonly WorkThreadLocalMarker[]): WorkThreadRow => ({
  ...value,
  markers: { ...value.markers, local: markers },
});
const link = (kind: WorkThreadLink['kind'], key: string, detachedAt: WorkThreadLink['detachedAt'] = null) => ({
  createdAt: at,
  detachedAt,
  key,
  kind,
  linkId: id,
  provenance: 'user' as const,
  threadId: id,
});
const merged = () => withPr(pr({ state: 'MERGED', mergedAt: at }));

describe('a missing checkout is an observed absence', () => {
  const gone: WorkThreadRemainder = {
    key: 'checkout',
    source: 'local',
    observedAt: at,
    kind: 'source-unavailable',
    outcome: 'missing',
  };
  test('it leaves no remainder when its last read was clean, and its history does not go stale', () => {
    const previous = local({ observedAt: older });
    const value = withLocal(row(), localMarker(local({ outcome: 'missing' }), previous));
    const result = deriveWorkThreadSituation(value, at);
    expect(result.remainders).toEqual([]);
    // A change with no pull request and no checkout left still has no known end.
    expect(result).toMatchObject({ hint: 'undecided', reason: 'next-step', action: 'copy-context' });
    const analysis = { ...value, thread: { ...thread, intent: 'analysis' as const } };
    expect(deriveWorkThreadSituation(analysis, at)).toMatchObject({ hint: 'ready-to-close', reason: 'no-remainder' });
  });
  test.each([
    ['a dirty flag', { dirty: true }],
    ['modified files', { modifiedCount: 2 }],
    ['staged files', { stagedCount: 1 }],
    ['untracked files', { untrackedCount: 1 }],
    ['unpushed commits', { ahead: 3 }],
  ] as const)('a checkout gone after its last read showed %s is unread, not empty', (_label, patch) => {
    const previous = local({ ...patch, observedAt: older });
    const value = withLocal(row(), localMarker(local({ outcome: 'missing' }), previous));
    const result = deriveWorkThreadSituation(value, at);
    // One remainder only: the historical files are not current work and the old read is not "stale".
    expect(result.remainders).toEqual([gone]);
    expect(result).toMatchObject({ hint: 'undecided', reason: 'source-unavailable', action: 'copy-context' });
  });
  test('an analysis whose checkout went missing with local work cannot assert that nothing is left', () => {
    const previous = local({ dirty: true, modifiedCount: 2, ahead: 3, observedAt: older });
    const value = withLocal(
      row({ thread: { ...thread, intent: 'analysis' } }),
      localMarker(local({ outcome: 'missing' }), previous),
    );
    const result = deriveWorkThreadSituation(value, at);
    expect(result).toMatchObject({ hint: 'undecided', reason: 'source-unavailable', action: 'copy-context' });
    expect(result.remainders).toEqual([gone]);
  });
  test('a merged PR whose checkout went missing with local work does not suggest the end, the loss listed', () => {
    const previous = local({ dirty: true, untrackedCount: 1, observedAt: older });
    const result = deriveWorkThreadSituation(
      withLocal(merged(), localMarker(local({ outcome: 'missing' }), previous)),
      at,
    );
    expect(result).toMatchObject({ hint: 'undecided', reason: 'unread-checkout', action: 'copy-context' });
    expect(result.remainders).toEqual([gone]);
  });
  test('a merged PR whose checkout is gone is ready to close with nothing to acknowledge', () => {
    const result = deriveWorkThreadSituation(withLocal(merged(), localMarker(local({ outcome: 'missing' }))), at);
    expect(result).toMatchObject({ hint: 'ready-to-close', reason: 'merged-complete', action: 'end-follow-up' });
    expect(result.remainders).toEqual([]);
  });
  test.each(['not-a-repository', 'timeout', 'denied', 'invalid'] as const)(
    'a %s read is still an unread source, with the staleness of its last success',
    (outcome) => {
      const previous = local({ observedAt: older });
      const value = withLocal(row(), localMarker(local({ outcome }), previous));
      expect(deriveWorkThreadSituation(value, at).remainders).toEqual([
        { key: 'checkout', source: 'local', observedAt: at, kind: 'source-unavailable', outcome },
        { key: 'checkout', source: 'local', observedAt: older, kind: 'source-stale' },
      ]);
    },
  );
  test('a checkout never read stays unknown', () => {
    expect(kinds(withLocal(row(), localMarker(null)))).toEqual(['source-unknown']);
  });
});

describe('unread sources never rank a task that a known fact ranks', () => {
  const unreadSessions: WorkThreadRemainder = {
    key: 'session:test/codex/one',
    source: 'sessions',
    observedAt: at,
    kind: 'source-unavailable',
    outcome: 'truncated',
  };
  test('names the three unread kinds and no known fact', () => {
    const evidence = { key: 'k', source: 'github' as const, observedAt: null };
    expect(isUnreadRemainder({ ...evidence, kind: 'source-unknown' })).toBe(true);
    expect(isUnreadRemainder({ ...evidence, kind: 'source-stale' })).toBe(true);
    expect(isUnreadRemainder({ ...evidence, kind: 'source-unavailable', outcome: 'timeout' })).toBe(true);
    for (const kind of ['open-pr', 'failing-checks', 'jira-open', 'team-review-requested'] as const) {
      expect(isUnreadRemainder({ ...evidence, kind })).toBe(false);
    }
    expect(isUnreadRemainder({ ...evidence, kind: 'unpushed-commits', count: 1 })).toBe(false);
  });
  test('a merged PR with a branch never read on this machine does not suggest the end', () => {
    const value = { ...merged(), links: [link('branch', 'branch:github.com/test/repo@topic')] };
    const result = deriveWorkThreadSituation(value, at);
    expect(result).toMatchObject({ hint: 'undecided', reason: 'unread-checkout', action: 'copy-context' });
    expect(result.remainders).toEqual([
      { key: 'branch:github.com/test/repo@topic', source: 'local', observedAt: null, kind: 'source-unknown' },
    ]);
  });
  test.each(['change', 'analysis', 'review', null] as const)(
    'a merged PR with an unread sessions source is ready to close whatever the intent (%s)',
    (intent) => {
      const value = merged();
      const result = deriveWorkThreadSituation({ ...value, thread: { ...thread, intent } }, at, [unreadSessions]);
      expect(result).toMatchObject({ hint: 'ready-to-close', reason: 'merged-complete', action: 'end-follow-up' });
      expect(result.remainders).toEqual([unreadSessions]);
    },
  );
  test('a merged PR does not hide a dirty checkout still on disk', () => {
    const dirty = local({ dirty: true, untrackedCount: 1 });
    const result = deriveWorkThreadSituation(withLocal(merged(), localMarker(dirty)), at, [unreadSessions]);
    expect(result).toMatchObject({ hint: 'to-resume', reason: 'local-files', action: 'copy-context' });
    expect(result.remainders.map((item) => item.kind)).toEqual(['local-files', 'source-unavailable']);
  });
  test('a merged PR does not hide an open native request', () => {
    const request = {
      key: 'request',
      sessionKey: 'session:test/codex/one',
      machineId: 'test',
      harness: 'codex',
      sourceSessionId: 'one',
      callId: 'call',
      questionId: 'q',
      askedAt: at,
      answeredAt: null,
      observedAt: at,
      text: 'Choose?',
      state: 'open' as const,
      evidence: 'codex-request-user-input' as const,
      detail: 'No attributable answer.',
    };
    expect(deriveWorkThreadSituation({ ...merged(), nativeRequests: [request] }, at)).toMatchObject({
      hint: 'to-resume',
      reason: 'native-request',
      action: 'resume-session',
    });
  });
  test('an analysis with only an unread source cannot assert that nothing is left', () => {
    const analysis = row({ thread: { ...thread, intent: 'analysis' } });
    expect(deriveWorkThreadSituation(analysis, at, [unreadSessions])).toMatchObject({
      hint: 'undecided',
      reason: 'source-unavailable',
      action: 'copy-context',
      remainders: [unreadSessions],
    });
    const stale = { key: 'checkout', source: 'local' as const, observedAt: older, kind: 'source-stale' as const };
    const unknown = { key: id, source: 'sessions' as const, observedAt: null, kind: 'source-unknown' as const };
    // The reason follows the ranking order, not the order the remainders were found in.
    expect(deriveWorkThreadSituation(analysis, at, [unknown, stale]).reason).toBe('source-stale');
    expect(deriveWorkThreadSituation(analysis, at, [unknown, stale, unreadSessions]).reason).toBe('source-unavailable');
    expect(deriveWorkThreadSituation(withLocal(row(), localMarker(null)), at)).toMatchObject({
      hint: 'undecided',
      reason: 'source-unknown',
      action: 'copy-context',
    });
  });
  test('an unread GitHub source alone still opens the pull request', () => {
    const failed = pr({ state: null, outcome: 'network' });
    expect(deriveWorkThreadSituation(withPr(failed), at)).toMatchObject({
      hint: 'undecided',
      reason: 'source-unavailable',
      action: 'open-pr',
    });
  });
  test('an open PR with failing checks keeps its reason beside unread sources', () => {
    const value = {
      ...withPr(pr({ checksRollup: 'failure', observedAt: older })),
      links: [link('branch', 'branch:github.com/test/repo@topic')],
    };
    const result = deriveWorkThreadSituation(value, at, [unreadSessions]);
    expect(result).toMatchObject({ hint: 'to-resume', reason: 'failing-checks', action: 'open-pr' });
    expect(result.remainders.map((item) => item.kind)).toEqual([
      'source-stale',
      'failing-checks',
      'source-unknown',
      'source-unavailable',
    ]);
  });
  test('a closed PR is ready to close beside an unread sessions source, not an unread checkout or GitHub source', () => {
    const result = deriveWorkThreadSituation(withPr(pr({ state: 'CLOSED' })), at, [unreadSessions]);
    expect(result).toMatchObject({ hint: 'ready-to-close', reason: 'closed-unmerged', action: 'end-follow-up' });
    expect(result.remainders.map((item) => [item.source, item.kind])).toEqual([['sessions', 'source-unavailable']]);
    const closed = { ...withPr(pr({ state: 'CLOSED' })), links: [link('branch', 'branch:github.com/test/repo@topic')] };
    const blocked = deriveWorkThreadSituation(closed, at, [unreadSessions]);
    expect(blocked).toMatchObject({ hint: 'undecided', reason: 'unread-checkout', action: 'copy-context' });
    expect(blocked.remainders.map((item) => [item.source, item.kind])).toEqual([
      ['local', 'source-unknown'],
      ['sessions', 'source-unavailable'],
    ]);
    // A closed pull request can reopen: a read that is no longer current does not suggest an end.
    const stale = deriveWorkThreadSituation(withPr(pr({ state: 'CLOSED', observedAt: older })), at, [unreadSessions]);
    expect(stale).toMatchObject({ hint: 'undecided', reason: 'source-unavailable', action: 'copy-context' });
    expect(stale.remainders.map((item) => [item.source, item.kind])).toEqual([
      ['github', 'source-stale'],
      ['sessions', 'source-unavailable'],
    ]);
    const unreadGithub: WorkThreadRemainder = {
      key: 'github.com/test/repo#42',
      source: 'github',
      observedAt: null,
      kind: 'source-unknown',
    };
    expect(deriveWorkThreadSituation(withPr(pr({ state: 'CLOSED' })), at, [unreadGithub])).toMatchObject({
      hint: 'undecided',
      reason: 'source-unknown',
      action: 'open-pr',
    });
    // Merged is terminal, whatever GitHub would say now.
    expect(deriveWorkThreadSituation(merged(), at, [unreadGithub])).toMatchObject({
      hint: 'ready-to-close',
      reason: 'merged-complete',
    });
  });
  test('beside a merged PR, a closed one settles only on a current read', () => {
    const mixed = (closed: PullRequestObservation): WorkThreadRow => {
      const value = merged();
      return {
        ...value,
        markers: {
          ...value.markers,
          pullRequests: [...withPr(closed).markers.pullRequests, ...value.markers.pullRequests],
        },
      };
    };
    // Read now: the closed attempt is superseded and the merge ends the task.
    const fresh = deriveWorkThreadSituation(mixed(pr({ number: 41, state: 'CLOSED' })), at);
    expect(fresh).toMatchObject({ hint: 'ready-to-close', reason: 'merged-complete', action: 'end-follow-up' });
    expect(fresh.remainders).toEqual([]);
    // Read weeks ago: it may have reopened since, so the merge beside it does not suggest an end.
    const stale = deriveWorkThreadSituation(mixed(pr({ number: 41, state: 'CLOSED', observedAt: older })), at);
    expect(stale).toMatchObject({ hint: 'undecided', reason: 'source-stale', action: 'open-pr' });
    expect(stale.remainders).toEqual([
      { key: 'github.com/test/repo#41', source: 'github', observedAt: older, kind: 'source-stale' },
    ]);
    // An unread GitHub source naming the closed pull request counts the same, wherever it comes from.
    const unreadClosed: WorkThreadRemainder = {
      key: 'github.com/test/repo#41',
      source: 'github',
      observedAt: null,
      kind: 'source-unknown',
    };
    expect(deriveWorkThreadSituation(mixed(pr({ number: 41, state: 'CLOSED' })), at, [unreadClosed])).toMatchObject({
      hint: 'undecided',
      reason: 'source-unknown',
    });
    // The merged one is terminal: its own stale read, or an unread local source, changes nothing.
    const staleMerge = (() => {
      const value = withPr(pr({ state: 'MERGED', mergedAt: older, observedAt: older }));
      return {
        ...value,
        markers: {
          ...value.markers,
          pullRequests: [
            ...withPr(pr({ number: 41, state: 'CLOSED' })).markers.pullRequests,
            ...value.markers.pullRequests,
          ],
        },
      };
    })();
    expect(deriveWorkThreadSituation(staleMerge, at, [unreadSessions])).toMatchObject({
      hint: 'ready-to-close',
      reason: 'merged-complete',
    });
  });
  test('a closed PR whose latest read failed is not settled and asks for a decision', () => {
    const previous = pr({ state: 'CLOSED', observedAt: older });
    const value = withPr(pr({ state: null, outcome: 'network' }));
    const [marker] = value.markers.pullRequests;
    if (!marker) {
      throw new Error('Missing fixture marker');
    }
    const unread = {
      ...value,
      markers: { ...value.markers, pullRequests: [{ ...marker, latestSuccessful: previous }] },
    };
    expect(settledPullRequests(unread)).toBeNull();
    const result = deriveWorkThreadSituation(unread, at);
    expect(result).toMatchObject({ hint: 'undecided', reason: 'source-unavailable', action: 'open-pr' });
    expect(result.remainders.map((item) => item.kind)).toEqual(['source-unavailable', 'source-stale']);
  });
  test('a closed PR read more than seven days ago asks for a decision; a fresh read suggests the end', () => {
    const stale = deriveWorkThreadSituation(withPr(pr({ state: 'CLOSED', observedAt: older })), at);
    expect(stale).toMatchObject({ hint: 'undecided', reason: 'source-stale', action: 'open-pr' });
    expect(stale.remainders).toEqual([
      { key: 'github.com/test/repo#42', source: 'github', observedAt: older, kind: 'source-stale' },
    ]);
    const fresh = deriveWorkThreadSituation(withPr(pr({ state: 'CLOSED' })), at);
    expect(fresh).toMatchObject({ hint: 'ready-to-close', reason: 'closed-unmerged', action: 'end-follow-up' });
    expect(fresh.remainders).toEqual([]);
  });
  test('explicit waiting, Done and a running session keep their rank over a merged PR', () => {
    const value = merged();
    expect(
      deriveWorkThreadSituation({ ...value, thread: { ...thread, followState: 'waiting', waitingFor: 'Deploy' } }, at),
    ).toMatchObject({ hint: 'waiting', reason: 'explicit-wait' });
    expect(
      deriveWorkThreadSituation({ ...value, thread: { ...thread, followState: 'done', doneAt: at } }, at),
    ).toMatchObject({ hint: 'done', reason: 'follow-up-ended' });
    expect(deriveWorkThreadSituation({ ...value, runningSessions: 1 }, at)).toMatchObject({
      hint: 'in-progress',
      reason: 'running-session',
    });
  });
});

describe('an unread checkout keeps a settled task from suggesting its end', () => {
  const blocked = { hint: 'undecided', reason: 'unread-checkout', action: 'copy-context' } as const;
  const ready = { hint: 'ready-to-close', reason: 'merged-complete', action: 'end-follow-up' } as const;
  const unreadSessions: WorkThreadRemainder = {
    key: 'session:test/codex/one',
    source: 'sessions',
    observedAt: at,
    kind: 'source-unavailable',
    outcome: 'truncated',
  };
  test('a linked checkout never read blocks, whatever merged', () => {
    const result = deriveWorkThreadSituation(withLocal(merged(), localMarker(null)), at);
    expect(result).toMatchObject(blocked);
    expect(result.remainders).toEqual([{ key: 'checkout', source: 'local', observedAt: null, kind: 'source-unknown' }]);
  });
  test.each(['not-a-repository', 'timeout', 'denied', 'invalid'] as const)(
    'a checkout whose read failed (%s) blocks',
    (outcome) => {
      const value = withLocal(merged(), localMarker(local({ outcome }), local()));
      expect(deriveWorkThreadSituation(value, at)).toMatchObject(blocked);
    },
  );
  test('a checkout read too long ago blocks; a current clean read does not', () => {
    expect(deriveWorkThreadSituation(withLocal(merged(), localMarker(local({ observedAt: older }))), at)).toMatchObject(
      blocked,
    );
    const current = deriveWorkThreadSituation(withLocal(merged(), localMarker(local())), at);
    expect(current).toMatchObject(ready);
    expect(current.remainders).toEqual([]);
  });
  test('a checkout whose git state was only partly reported blocks', () => {
    expect(deriveWorkThreadSituation(withLocal(merged(), localMarker(local({ ahead: null }))), at)).toMatchObject(
      blocked,
    );
  });
  test('a checkout gone from disk blocks only when its last read held work', () => {
    const held = local({ ahead: 2, observedAt: older });
    expect(
      deriveWorkThreadSituation(withLocal(merged(), localMarker(local({ outcome: 'missing' }), held)), at),
    ).toMatchObject(blocked);
    const clean = local({ observedAt: older });
    expect(
      deriveWorkThreadSituation(withLocal(merged(), localMarker(local({ outcome: 'missing' }), clean)), at),
    ).toMatchObject(ready);
  });
  test('a second linked branch with no pull request and no read blocks', () => {
    const value = {
      ...withLocal(merged(), localMarker(local())),
      links: [link('branch', 'branch:github.com/test/repo@second')],
    };
    const result = deriveWorkThreadSituation(value, at);
    expect(result).toMatchObject(blocked);
    expect(result.remainders).toEqual([
      { key: 'branch:github.com/test/repo@second', source: 'local', observedAt: null, kind: 'source-unknown' },
    ]);
    // Detached, the branch is no longer the task's: nothing is left to read.
    const detached = { ...value, links: [link('branch', 'branch:github.com/test/repo@second', at)] };
    expect(deriveWorkThreadSituation(detached, at)).toMatchObject(ready);
  });
  test('sessions that were not fully read do not block: they stay listed beside the suggested end', () => {
    const partial = deriveWorkThreadSituation({ ...merged(), nativeRequestCoverage: 'partial' }, at, [unreadSessions]);
    expect(partial).toMatchObject(ready);
    expect(partial.remainders.map((item) => [item.source, item.kind])).toEqual([
      ['sessions', 'source-unknown'],
      ['sessions', 'source-unavailable'],
    ]);
  });
  test('a ticket that was not read does not block', () => {
    const unreadTicket: WorkThreadRemainder = { key: 'jira', source: 'jira', observedAt: null, kind: 'source-unknown' };
    expect(deriveWorkThreadSituation(merged(), at, [unreadTicket])).toMatchObject(ready);
  });
  test('the checkout names the reason even beside other unread sources, and a known fact still outranks it', () => {
    const value = withLocal({ ...merged(), nativeRequestCoverage: 'partial' }, localMarker(null));
    expect(deriveWorkThreadSituation(value, at, [unreadSessions])).toMatchObject(blocked);
    const dirty = withLocal(merged(), localMarker(local({ dirty: true, modifiedCount: 1 })), {
      ...localMarker(null),
      key: 'other',
    });
    expect(deriveWorkThreadSituation(dirty, at)).toMatchObject({ hint: 'to-resume', reason: 'local-files' });
  });
  test('explicit waiting and Done keep their rank over an unread checkout', () => {
    const value = withLocal(merged(), localMarker(null));
    expect(
      deriveWorkThreadSituation({ ...value, thread: { ...thread, followState: 'waiting', waitingFor: 'Deploy' } }, at),
    ).toMatchObject({ hint: 'waiting', reason: 'explicit-wait' });
    expect(
      deriveWorkThreadSituation({ ...value, thread: { ...thread, followState: 'done', doneAt: at } }, at),
    ).toMatchObject({ hint: 'done', reason: 'follow-up-ended' });
  });
});

describe('settled pull requests', () => {
  const marker = (
    number: number,
    latest: PullRequestObservation | null,
    latestSuccessful: PullRequestObservation | null = latest?.outcome === 'observed' ? latest : null,
  ): WorkThreadPullRequestMarker => ({
    key: `github.com/test/repo#${number}`,
    latest,
    latestSuccessful,
    mergeable: null,
    mergeStateStatus: null,
    role: null,
  });
  const withMarkers = (...pullRequests: readonly WorkThreadPullRequestMarker[]): WorkThreadRow =>
    row({ markers: { local: [], jiraIssues: [], pullRequests } });
  test('no pull request settles nothing', () => {
    expect(settledPullRequests(row())).toBeNull();
  });
  test('an open pull request is not settled, even beside a merged one', () => {
    expect(settledPullRequests(withMarkers(marker(1, pr({ number: 1 }))))).toBeNull();
    expect(
      settledPullRequests(withMarkers(marker(1, pr({ number: 1, state: 'MERGED' })), marker(2, pr({ number: 2 })))),
    ).toBeNull();
  });
  test('merged when every pull request merged, or the others closed as superseded attempts', () => {
    expect(settledPullRequests(withMarkers(marker(1, pr({ number: 1, state: 'MERGED' }))))).toBe('merged');
    expect(
      settledPullRequests(
        withMarkers(marker(1, pr({ number: 1, state: 'CLOSED' })), marker(2, pr({ number: 2, state: 'MERGED' }))),
      ),
    ).toBe('merged');
  });
  test('closed only when every pull request closed without merge', () => {
    expect(
      settledPullRequests(
        withMarkers(marker(1, pr({ number: 1, state: 'CLOSED' })), marker(2, pr({ number: 2, state: 'CLOSED' }))),
      ),
    ).toBe('closed');
  });
  test('an unknown state settles nothing', () => {
    expect(settledPullRequests(withMarkers(marker(1, null)))).toBeNull();
    expect(settledPullRequests(withMarkers(marker(1, pr({ number: 1, state: null }))))).toBeNull();
    expect(settledPullRequests(withMarkers(marker(1, pr({ number: 1, state: null, outcome: 'network' }))))).toBeNull();
    expect(settledPullRequests(withMarkers(marker(1, pr({ number: 1, state: 'MERGED' })), marker(2, null)))).toBeNull();
  });
  test('a failed latest read falls back to the last successful state', () => {
    const failed = pr({ number: 1, state: null, outcome: 'unauthenticated' });
    const previous = pr({ number: 1, state: 'MERGED', observedAt: older });
    expect(settledPullRequests(withMarkers(marker(1, failed, previous)))).toBe('merged');
    // A successful latest read wins over an older success.
    expect(settledPullRequests(withMarkers(marker(1, pr({ number: 1 }), previous)))).toBeNull();
  });
  test('a closed state counts only while the latest read observed it, because a closed PR can reopen', () => {
    const failed = pr({ number: 1, state: null, outcome: 'unauthenticated' });
    const previous = pr({ number: 1, state: 'CLOSED', observedAt: older });
    expect(settledPullRequests(withMarkers(marker(1, failed, previous)))).toBeNull();
    expect(
      settledPullRequests(withMarkers(marker(1, failed, previous), marker(2, pr({ number: 2, state: 'MERGED' })))),
    ).toBeNull();
    // An observed read counts whatever its age; its staleness is a remainder, not a state.
    expect(settledPullRequests(withMarkers(marker(1, previous)))).toBe('closed');
  });
  test('an active pull request link without a marker settles nothing; a detached one is ignored', () => {
    const value = withMarkers(marker(1, pr({ number: 1, state: 'MERGED' })));
    expect(settledPullRequests({ ...value, links: [link('pull-request', 'github.com/test/repo#1')] })).toBe('merged');
    expect(settledPullRequests({ ...value, links: [link('pull-request', 'github.com/test/repo#2')] })).toBeNull();
    expect(settledPullRequests({ ...value, links: [link('pull-request', 'github.com/test/repo#2', at)] })).toBe(
      'merged',
    );
    expect(settledPullRequests({ ...value, links: [link('branch', 'branch:github.com/test/repo@topic')] })).toBe(
      'merged',
    );
  });
});
