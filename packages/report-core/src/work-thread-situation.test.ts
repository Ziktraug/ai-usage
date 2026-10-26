import { describe, expect, test } from 'bun:test';
import { parseCanonicalInstant } from './canonical-instant';
import type { CheckoutStatusObservation, JiraIssueObservation, PullRequestObservation } from './work-attention';
import type { WorkThread } from './work-thread';
import { deriveWorkThreadSituation } from './work-thread-situation';
import type { WorkThreadPullRequestMarker, WorkThreadRow } from './work-thread-view';

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
          marks: [{ at, kind: 'event', harness: null, label: 'Agent review completed' }],
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
  test('no PR or completed session alone ends a change follow-up', () => {
    expect(deriveWorkThreadSituation(row({ sessionCount: 1 }), at).hint).toBe('undecided');
    expect(deriveWorkThreadSituation(withPr(pr({ state: 'CLOSED' })), at).hint).toBe('undecided');
    expect(deriveWorkThreadSituation(withPr(pr({ state: 'MERGED' })), at)).toMatchObject({
      hint: 'ready-to-close',
      reason: 'merged-complete',
    });
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
        local: [{ key: 'checkout', latest: fact, latestSuccessful: fact, via: 'session-checkout' }],
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
        local: [{ key: 'checkout', latest: null, latestSuccessful: null, via: 'session-checkout' }],
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
    expect(deriveWorkThreadSituation(value, at).hint).toBe('undecided');
  });
  test('stale success cannot declare ready; fresh merged facts can', () => {
    expect(deriveWorkThreadSituation(withPr(pr({ state: 'MERGED', observedAt: older })), at).hint).toBe('undecided');
    expect(deriveWorkThreadSituation(withPr(pr({ state: 'MERGED' })), at).hint).toBe('ready-to-close');
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
            local: [{ key: 'checkout', latest: fact, latestSuccessful: fact, via: 'branch-link' }],
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

test('a missing checkout keeps its unavailable evidence without treating historical files as current work', () => {
  const previous = local({ dirty: true, modifiedCount: 2, ahead: 3 });
  const value = row({
    markers: {
      jiraIssues: [],
      pullRequests: [],
      local: [
        { key: 'checkout', via: 'session-checkout', latest: local({ outcome: 'missing' }), latestSuccessful: previous },
      ],
    },
  });
  const result = deriveWorkThreadSituation(value, at);
  expect(result.remainders.map((item) => item.kind)).toEqual(['source-unavailable']);
  expect(result.hint).not.toBe('ready-to-close');
});
