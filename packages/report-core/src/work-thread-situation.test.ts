import { describe, expect, test } from 'bun:test';
import { parseCanonicalInstant } from './canonical-instant';
import type { CheckoutStatusObservation, JiraIssueObservation, PullRequestObservation } from './work-attention';
import type { WorkThread } from './work-thread';
import { deriveWorkThreadSituation } from './work-thread-situation';
import type { WorkThreadRow } from './work-thread-view';

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
  afterDone: null,
  lastActivityAt: at,
  links: [],
  markers: { jiraIssues: [], local: [], pullRequests: [] },
  marks: [],
  runningSessions: 0,
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
const withPr = (fact: PullRequestObservation): WorkThreadRow =>
  row({
    markers: {
      local: [],
      jiraIssues: [],
      pullRequests: [
        {
          key: 'github.com/test/repo#42',
          latest: fact,
          latestSuccessful: fact.outcome === 'observed' ? fact : null,
          mergeable: 'mergeable',
          mergeStateStatus: 'CLEAN',
          role: null,
        },
      ],
    },
  });
const kinds = (value: WorkThreadRow) =>
  deriveWorkThreadSituation(value, at).remainders.map((remainder) => remainder.kind);

describe('Work thread situation', () => {
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
  test('open PR review, failing checks, merge conflict and review request all remain visible', () => {
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
    expect(kinds(observed)).toEqual([
      'open-pr',
      'changes-requested',
      'failing-checks',
      'merge-conflict',
      'review-requested',
    ]);
    expect(deriveWorkThreadSituation(observed, at)).toMatchObject({ reason: 'merge-conflict', action: 'open-pr' });
    expect(deriveWorkThreadSituation(observed, at).remainders.find((r) => r.kind === 'merge-conflict')).toMatchObject({
      baseRef: 'release/next',
    });
  });
  test('behind uses the PR base and is distinct from conflict', () => {
    const value = withPr(pr());
    const marker = value.markers.pullRequests[0];
    if (!marker) {
      throw new Error('Missing fixture marker');
    }
    const observed = {
      ...value,
      markers: { ...value.markers, pullRequests: [{ ...marker, mergeStateStatus: 'BEHIND' }] },
    };
    expect(kinds(observed)).toEqual(['open-pr', 'behind-base']);
    expect(deriveWorkThreadSituation(observed, at).remainders[1]).toMatchObject({
      baseRef: 'release/next',
      observedAt: at,
    });
  });
  test('pending CI waits and an approved open PR still has a remainder', () => {
    expect(deriveWorkThreadSituation(withPr(pr({ checksRollup: 'pending' })), at)).toMatchObject({
      hint: 'waiting',
      reason: 'pending-checks',
    });
    expect(kinds(withPr(pr({ reviewDecision: 'APPROVED' })))).toEqual(['open-pr']);
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
  test.each([
    'pull-request',
    'jira-issue',
    'branch',
    'session',
  ] as const)('missing linked %s evidence is unknown', (kind) => {
    const value = row({
      thread: { ...thread, intent: 'analysis' },
      links: [{ createdAt: at, detachedAt: null, key: 'missing', kind, linkId: id, provenance: 'user', threadId: id }],
    });
    expect(kinds(value)).toContain('source-unknown');
    expect(deriveWorkThreadSituation(value, at).hint).toBe('undecided');
  });
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
