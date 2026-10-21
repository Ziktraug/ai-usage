import { describe, expect, test } from 'bun:test';
import { parseCanonicalInstant } from './canonical-instant';
import type {
  CheckoutStatusObservation,
  ClaudeDesktopSessionObservation,
  JiraIssueObservation,
  PullRequestObservation,
  WorkFact,
} from './work-attention';
import {
  checkoutStatusFact,
  explicitJiraKeys,
  interpretExternalFacts,
  interpretJiraFacts,
  jiraIssueFact,
  jiraKeysInBranch,
  pullRequestFact,
} from './work-attention-facts';

const NOW = new Date('2026-10-21T22:00:00.000Z');
const FRESH = parseCanonicalInstant('2026-10-21T21:00:00.000Z');
const STALE = parseCanonicalInstant('2026-10-19T21:00:00.000Z');

const pullRequest = (overrides: Partial<PullRequestObservation> = {}): PullRequestObservation => ({
  accountLabel: null,
  baseRef: 'main',
  checksRollup: 'success',
  draft: false,
  headRef: 'feat/work-view',
  host: 'github.com',
  machineId: 'machine-a',
  mergedAt: null,
  number: 66,
  observedAt: FRESH,
  outcome: 'observed',
  outcomeMessage: null,
  repository: 'fixture/project',
  reviewDecision: 'REVIEW_REQUIRED',
  state: 'OPEN',
  title: 'Add the Work view',
  updatedAt: parseCanonicalInstant('2026-10-21T18:30:00.000Z'),
  url: 'https://github.com/fixture/project/pull/66',
  ...overrides,
});

const failedPullRequest = (overrides: Partial<PullRequestObservation> = {}): PullRequestObservation =>
  pullRequest({
    baseRef: null,
    checksRollup: null,
    draft: null,
    headRef: null,
    outcome: 'network',
    outcomeMessage: 'gh exited 1 without output (network failure or not found)',
    reviewDecision: null,
    state: null,
    title: null,
    updatedAt: null,
    url: null,
    ...overrides,
  });

const checkout = (overrides: Partial<CheckoutStatusObservation> = {}): CheckoutStatusObservation => ({
  ahead: 1,
  behind: 0,
  branch: 'feat/work-view',
  checkoutPath: '/home/alex/projects/example',
  dirty: true,
  headSha: 'a'.repeat(40),
  lastCommitAt: parseCanonicalInstant('2026-10-20T10:00:00.000Z'),
  machineId: 'machine-a',
  modifiedCount: 2,
  observedAt: FRESH,
  outcome: 'observed',
  stagedCount: 0,
  untrackedCount: 3,
  upstream: null,
  ...overrides,
});

const interpret = (facts: Parameters<typeof interpretExternalFacts>[0]['facts']) =>
  interpretExternalFacts({ facts, now: NOW });

describe('fact builders', () => {
  test('carry provenance with coverage derived from the outcome', () => {
    expect(pullRequestFact(pullRequest(), 'pr-1')).toEqual({
      accountLabel: null,
      checksRollup: 'success',
      draft: false,
      host: 'github.com',
      id: 'pr-1',
      kind: 'pull-request',
      number: 66,
      outcome: 'observed',
      provenance: { coverage: 'complete', machineId: 'machine-a', observedAt: FRESH, source: 'github' },
      repository: 'fixture/project',
      reviewDecision: 'REVIEW_REQUIRED',
      state: 'OPEN',
      updatedAt: parseCanonicalInstant('2026-10-21T18:30:00.000Z'),
      url: 'https://github.com/fixture/project/pull/66',
    });
    expect(pullRequestFact(failedPullRequest(), 'pr-2').provenance.coverage).toBe('partial');
    expect(checkoutStatusFact(checkout(), 'co-1')).toEqual({
      ahead: 1,
      behind: 0,
      branch: 'feat/work-view',
      checkoutPath: '/home/alex/projects/example',
      dirty: true,
      id: 'co-1',
      kind: 'checkout-status',
      lastCommitAt: parseCanonicalInstant('2026-10-20T10:00:00.000Z'),
      modifiedCount: 2,
      outcome: 'observed',
      provenance: { coverage: 'complete', machineId: 'machine-a', observedAt: FRESH, source: 'local-checkout' },
      untrackedCount: 3,
    });
    expect(checkoutStatusFact(checkout({ outcome: 'timeout' }), 'co-2').provenance.coverage).toBe('partial');
  });
});

describe('interpretExternalFacts', () => {
  test('names an open, unapproved, fresh pull request as an external wait', () => {
    expect(interpret([pullRequestFact(pullRequest(), 'pr-1')])).toEqual([
      {
        evidence: ['pr-1'],
        kind: 'external-review-pending',
        text: `fixture/project#66 is open and awaiting review (REVIEW_REQUIRED; checks success) as of ${FRESH}.`,
        uncertainty: `Observed ${FRESH} via GitHub; a review or merge since then is not visible until the next observation.`,
      },
    ]);
    expect(interpret([pullRequestFact(pullRequest({ reviewDecision: 'APPROVED' }), 'pr-1')])).toEqual([]);
    expect(interpret([pullRequestFact(pullRequest({ draft: true }), 'pr-1')])).toEqual([]);
    expect(interpret([pullRequestFact(pullRequest({ state: 'CLOSED' }), 'pr-1')])).toEqual([]);
  });

  test('states a merge with its date and without claiming deployment, even when stale', () => {
    const merged = pullRequest({
      mergedAt: parseCanonicalInstant('2026-10-20T09:00:00.000Z'),
      observedAt: STALE,
      reviewDecision: 'APPROVED',
      state: 'MERGED',
      updatedAt: parseCanonicalInstant('2026-10-20T09:00:00.000Z'),
    });
    expect(interpret([pullRequestFact(merged, 'pr-1')])).toEqual([
      {
        evidence: ['pr-1'],
        kind: 'pull-request-merged',
        text: 'fixture/project#66 merged at 2026-10-20T09:00:00.000Z; merge does not prove deployment.',
        uncertainty: 'Merge is final; what happened after it (deploy, release, revert) is unobserved.',
      },
    ]);
  });

  test('describes local changes without dating them or assuming validation', () => {
    expect(interpret([checkoutStatusFact(checkout(), 'co-1')])).toEqual([
      {
        evidence: ['co-1'],
        kind: 'local-changes-unvalidated',
        text: `2 modified, 3 untracked observed at ${FRESH} on feat/work-view in example; since when is unknown; validation and delivery unobserved.`,
        uncertainty:
          'The first dirty observation does not date the changes; whether they were tested, committed or pushed elsewhere is not visible.',
      },
    ]);
    expect(
      interpret([checkoutStatusFact(checkout({ dirty: false, modifiedCount: 0, untrackedCount: 0 }), 'co-1')]),
    ).toEqual([]);
  });

  test('names a checkout several roots share, and keeps the statement tied to the observation', () => {
    const shared = interpretExternalFacts({
      facts: [checkoutStatusFact(checkout(), 'co-1')],
      now: NOW,
      rootsPerCheckout: new Map([['/home/alex/projects/example', 3]]),
    });
    expect(shared).toHaveLength(1);
    expect(shared[0]?.kind).toBe('local-changes-unvalidated');
    expect(shared[0]?.text).toEndWith('validation and delivery unobserved. Checkout shared by 3 roots.');
    expect(shared[0]?.uncertainty).toContain('may belong to any of the roots sharing this checkout');
    // One root, or another path in the map: the statement is unchanged.
    const alone = interpretExternalFacts({
      facts: [checkoutStatusFact(checkout(), 'co-1')],
      now: NOW,
      rootsPerCheckout: new Map([
        ['/home/alex/projects/example', 1],
        ['/home/alex/projects/other', 4],
      ]),
    });
    expect(alone).toEqual(interpret([checkoutStatusFact(checkout(), 'co-1')]));
    expect(alone[0]?.text).not.toContain('shared');
  });

  test('turns a stale observation into an uncertainty instead of a current state', () => {
    const stale = interpret([
      pullRequestFact(pullRequest({ observedAt: STALE }), 'pr-1'),
      checkoutStatusFact(checkout({ observedAt: STALE }), 'co-1'),
    ]);
    expect(stale.map(({ kind }) => kind)).toEqual(['coverage-gap', 'coverage-gap']);
    expect(stale[0]?.uncertainty).toBe(`last observation ${STALE}; current state unknown`);
    expect(stale[0]?.text).toContain('nothing fresher');
    expect(stale[1]?.uncertainty).toBe(`last observation ${STALE}; current state unknown`);
    // The freshness window is the caller's; a wide one makes the same facts current again.
    expect(
      interpretExternalFacts({
        facts: [pullRequestFact(pullRequest({ observedAt: STALE }), 'pr-1')],
        freshMs: 7 * 24 * 60 * 60 * 1000,
        now: NOW,
      }).map(({ kind }) => kind),
    ).toEqual(['external-review-pending']);
  });

  test('names the exact action for an unauthenticated read', () => {
    const active = interpret([pullRequestFact(failedPullRequest({ outcome: 'unauthenticated' }), 'pr-1')]);
    expect(active).toEqual([
      {
        evidence: ['pr-1'],
        kind: 'coverage-gap',
        text: `GitHub rejected the read of fixture/project#66 as unauthenticated at ${FRESH}.`,
        uncertainty: 'Action: sign in gh for github.com. Until then the pull request state is unknown.',
      },
    ]);
    const configured = interpret([
      pullRequestFact(failedPullRequest({ accountLabel: 'alice', outcome: 'unauthenticated' }), 'pr-1'),
    ]);
    expect(configured[0]?.uncertainty).toBe(
      'Action: configure github.accounts for fixture (gh login alice has no usable token). Until then the pull request state is unknown.',
    );
  });

  test('keeps a merged pull request and a still-dirty checkout as two independent statements', () => {
    const merged = pullRequest({ reviewDecision: 'APPROVED', state: 'MERGED' });
    const result = interpret([pullRequestFact(merged, 'pr-1'), checkoutStatusFact(checkout(), 'co-1')]);
    expect(result.map(({ kind, evidence }) => [kind, evidence])).toEqual([
      ['pull-request-merged', ['pr-1']],
      ['local-changes-unvalidated', ['co-1']],
    ]);
  });

  test('never conflates the same number on another repository', () => {
    const result = interpret([
      pullRequestFact(pullRequest(), 'pr-a'),
      pullRequestFact(
        pullRequest({ repository: 'other/project', reviewDecision: 'APPROVED', state: 'MERGED' }),
        'pr-b',
      ),
    ]);
    expect(result.map(({ kind, text }) => [kind, text.split(' ')[0]])).toEqual([
      ['external-review-pending', 'fixture/project#66'],
      ['pull-request-merged', 'other/project#66'],
    ]);
  });

  test('a failed observation does not replace the last successful one', () => {
    const result = interpret([
      pullRequestFact(pullRequest(), 'pr-observed'),
      pullRequestFact(
        failedPullRequest({ observedAt: parseCanonicalInstant('2026-10-21T21:30:00.000Z') }),
        'pr-failed',
      ),
    ]);
    expect(result.map(({ kind, evidence }) => [kind, evidence])).toEqual([
      ['external-review-pending', ['pr-observed']],
      ['coverage-gap', ['pr-failed']],
    ]);
    expect(result[1]?.text).toContain('(network)');
    expect(result[1]?.uncertainty).toContain('an earlier successful one, if any, is the last known state');
  });

  test('reports unreadable checkouts as coverage gaps and ignores unrelated facts', () => {
    const result = interpretExternalFacts({
      facts: [
        checkoutStatusFact(checkout({ dirty: null, outcome: 'denied' }), 'co-1'),
        {
          id: 'wrap',
          kind: 'wrap-up',
          at: FRESH,
          provenance: { coverage: 'complete', machineId: 'machine-a', observedAt: FRESH, source: 'claude-desktop' },
          text: 'Done',
        },
      ],
      now: NOW,
    });
    expect(result).toEqual([
      {
        evidence: ['co-1'],
        kind: 'coverage-gap',
        text: `Checkout example could not be read at ${FRESH} (denied).`,
        uncertainty: 'Local changes, if any, are unknown from this observation.',
      },
    ]);
  });

  test('caps the result at the contract bound', () => {
    const facts = Array.from({ length: 20 }, (_, index) =>
      pullRequestFact(
        pullRequest({ number: index + 1, url: `https://github.com/fixture/project/pull/${index + 1}` }),
        `pr-${index}`,
      ),
    );
    expect(interpret(facts)).toHaveLength(16);
  });
});

const jiraIssue = (overrides: Partial<JiraIssueObservation> = {}): JiraIssueObservation => ({
  assigneeLabel: 'Alex',
  commentCount: 2,
  comments: [
    { authorLabel: 'Sam', createdAt: parseCanonicalInstant('2026-10-21T20:30:00.000Z'), excerpt: 'Second.', id: '2' },
    { authorLabel: 'Sam', createdAt: parseCanonicalInstant('2026-10-21T17:00:00.000Z'), excerpt: 'First.', id: '1' },
  ],
  key: 'XLB-2090',
  machineId: 'machine-a',
  observedAt: FRESH,
  outcome: 'observed',
  outcomeMessage: null,
  parentKey: null,
  sprint: null,
  status: 'In Progress',
  statusCategory: 'in-progress',
  summary: 'Promo badge',
  updatedAt: parseCanonicalInstant('2026-10-21T20:30:00.000Z'),
  ...overrides,
});

const failedJiraIssue = (overrides: Partial<JiraIssueObservation> = {}): JiraIssueObservation =>
  jiraIssue({
    assigneeLabel: null,
    commentCount: null,
    comments: [],
    outcome: 'unauthenticated',
    outcomeMessage: 'Jira rejected the credentials (HTTP 401)',
    status: null,
    statusCategory: null,
    summary: null,
    updatedAt: null,
    ...overrides,
  });

const ACTIVITY_BEFORE_REPLY = parseCanonicalInstant('2026-10-21T18:00:00.000Z');
const ACTIVITY_AFTER_REPLY = parseCanonicalInstant('2026-10-21T21:30:00.000Z');

const session = (
  overrides: Partial<
    Pick<ClaudeDesktopSessionObservation, 'branch' | 'declaredPullRequests' | 'sourceBranch' | 'writtenBranches'>
  > = {},
) => ({ branch: null, declaredPullRequests: [], sourceBranch: null, writtenBranches: [], ...overrides });

describe('explicitJiraKeys', () => {
  test('reads a key only from a branch segment, never from a title, a cwd or a bare number', () => {
    expect(jiraKeysInBranch('feat/XLB-2090/slug')).toEqual(['XLB-2090']);
    expect(jiraKeysInBranch('fix/XLB-2091/mobile-nav')).toEqual(['XLB-2091']);
    expect(jiraKeysInBranch('XLB-2092')).toEqual(['XLB-2092']);
    expect(jiraKeysInBranch('chore/XLB-0/agent-setup')).toEqual([]);
    expect(jiraKeysInBranch('pr/user/123')).toEqual([]);
    expect(jiraKeysInBranch('feat/xlb-2090/slug')).toEqual([]);
    expect(jiraKeysInBranch('feat/XLB-1998-promo-badge')).toEqual([]);
    expect(explicitJiraKeys(session({ writtenBranches: ['feat/XLB-2090/slug', 'chore/XLB-0/agent-setup'] }))).toEqual([
      'XLB-2090',
    ]);
    expect(
      explicitJiraKeys(
        session({
          branch: 'fix/XLB-2091/mobile-nav',
          declaredPullRequests: [
            {
              baseRef: 'main',
              branch: 'release/XLB-2093/cut',
              host: 'github.com',
              number: 1,
              own: true,
              repository: 'fixture/project',
              state: 'OPEN',
              url: null,
            },
          ],
          sourceBranch: 'hotfix/XLB-2092/urgent',
          writtenBranches: ['feat/XLB-2090/slug', 'fix/XLB-2091/mobile-nav'],
        }),
      ),
    ).toEqual(['XLB-2090', 'XLB-2091', 'XLB-2092', 'XLB-2093']);
    // The title is not an input of this function at all; a key there cannot reach the result.
    expect(explicitJiraKeys({ ...session(), title: 'XLB-1998 promo badge' } as never)).toEqual([]);
  });
});

describe('jiraIssueFact and interpretJiraFacts', () => {
  test('counts the comments after the family activity and names a reply that arrived since', () => {
    const fact = jiraIssueFact(jiraIssue(), 'jira-1', ACTIVITY_BEFORE_REPLY);
    expect(fact).toEqual({
      commentCount: 2,
      id: 'jira-1',
      key: 'XLB-2090',
      kind: 'jira-issue',
      newCommentsSince: 1,
      newestCommentAt: parseCanonicalInstant('2026-10-21T20:30:00.000Z'),
      outcome: 'observed',
      provenance: { coverage: 'complete', machineId: 'machine-a', observedAt: FRESH, source: 'jira' },
      status: 'In Progress',
      statusCategory: 'in-progress',
      updatedAt: parseCanonicalInstant('2026-10-21T20:30:00.000Z'),
      url: null,
    });
    expect(interpretJiraFacts({ facts: [fact], familyLastActivityAt: ACTIVITY_BEFORE_REPLY, now: NOW })).toEqual([
      {
        evidence: ['jira-1'],
        kind: 'jira-reply-arrived',
        text: `1 comment arrived on XLB-2090 after this session family's last activity (${ACTIVITY_BEFORE_REPLY}); no resumption observed.`,
        uncertainty: `You may have read them in Jira; this view cannot tell. Newest comment 2026-10-21T20:30:00.000Z, observed ${FRESH}.`,
      },
    ]);
  });

  test('a reply before the family resumed is not an arrival, and a failed read counts nothing', () => {
    const resumed = jiraIssueFact(jiraIssue(), 'jira-1', ACTIVITY_AFTER_REPLY);
    expect(resumed.newCommentsSince).toBe(0);
    expect(interpretJiraFacts({ facts: [resumed], familyLastActivityAt: ACTIVITY_AFTER_REPLY, now: NOW })).toEqual([]);
    const failed = jiraIssueFact(failedJiraIssue(), 'jira-2', ACTIVITY_BEFORE_REPLY);
    expect(failed.newCommentsSince).toBeNull();
    expect(failed.provenance.coverage).toBe('partial');
  });

  test('names the exact action for an unauthenticated read and the missing CLI for a disabled one', () => {
    const facts = [
      jiraIssueFact(failedJiraIssue(), 'jira-1', ACTIVITY_BEFORE_REPLY),
      jiraIssueFact(
        failedJiraIssue({ outcome: 'disabled', outcomeMessage: 'acli not installed' }),
        'jira-2',
        ACTIVITY_BEFORE_REPLY,
      ),
      jiraIssueFact(failedJiraIssue({ outcome: 'network' }), 'jira-3', ACTIVITY_BEFORE_REPLY),
    ];
    const result = interpretJiraFacts({ facts, familyLastActivityAt: ACTIVITY_BEFORE_REPLY, now: NOW });
    expect(result.map(({ kind }) => kind)).toEqual(['coverage-gap', 'coverage-gap', 'coverage-gap']);
    expect(result[0]?.text).toBe(`Jira rejected the read of XLB-2090 as unauthenticated at ${FRESH}.`);
    expect(result[0]?.uncertainty).toContain('sign in to Jira (acli jira auth login)');
    expect(result[1]?.text).toBe(`XLB-2090 could not be read at ${FRESH}: the Atlassian CLI (acli) is not installed.`);
    expect(result[2]?.text).toBe(`XLB-2090 could not be read from Jira at ${FRESH} (network).`);
  });

  test('a To Do ticket beside an open or merged pull request is a difference, not an error', () => {
    const todo = jiraIssueFact(
      jiraIssue({ comments: [], commentCount: 0, status: 'To Do', statusCategory: 'todo' }),
      'jira-1',
      ACTIVITY_BEFORE_REPLY,
    );
    const merged = pullRequestFact(pullRequest({ state: 'MERGED', updatedAt: FRESH }), 'pr-1');
    const withObserved = interpretJiraFacts({
      facts: [merged, todo],
      familyLastActivityAt: ACTIVITY_BEFORE_REPLY,
      now: NOW,
    });
    expect(withObserved).toEqual([
      {
        evidence: ['jira-1'],
        kind: 'jira-status-differs',
        text: `XLB-2090 is still To Do (Jira status To Do, observed ${FRESH}) while fixture/project#66 is MERGED (GitHub ${FRESH}); a different status is not automatically an error.`,
        uncertainty:
          'Whether the ticket should follow the pull request is a team convention this view does not know; both are dated reads, not current states.',
      },
    ]);
    const declared: WorkFact = {
      branch: 'feat/XLB-2090/slug',
      host: 'github.com',
      id: 'decl-1',
      kind: 'declared-pull-request',
      number: 66,
      provenance: { coverage: 'complete', machineId: 'machine-a', observedAt: FRESH, source: 'claude-desktop' },
      repository: 'fixture/project',
      state: 'open',
      url: null,
    };
    const withDeclared = interpretJiraFacts({
      facts: [declared, todo],
      familyLastActivityAt: ACTIVITY_BEFORE_REPLY,
      now: NOW,
    });
    expect(withDeclared[0]?.text).toContain('while fixture/project#66 is OPEN (the session declared');
    // In progress beside a merged pull request, or To Do without any pull request: nothing to say.
    expect(
      interpretJiraFacts({
        facts: [merged, jiraIssueFact(jiraIssue({ comments: [] }), 'jira-2', ACTIVITY_BEFORE_REPLY)],
        familyLastActivityAt: ACTIVITY_BEFORE_REPLY,
        now: NOW,
      }),
    ).toEqual([]);
    expect(interpretJiraFacts({ facts: [todo], familyLastActivityAt: ACTIVITY_BEFORE_REPLY, now: NOW })).toEqual([]);
  });

  test('a stale observation keeps an arrival but turns a quiet state into an uncertainty', () => {
    const quiet = jiraIssueFact(jiraIssue({ comments: [], observedAt: STALE }), 'jira-1', ACTIVITY_BEFORE_REPLY);
    expect(interpretJiraFacts({ facts: [quiet], familyLastActivityAt: ACTIVITY_BEFORE_REPLY, now: NOW })).toEqual([
      {
        evidence: ['jira-1'],
        kind: 'coverage-gap',
        text: `XLB-2090 was In Progress when last observed at ${STALE}; nothing fresher.`,
        uncertainty: `last observation ${STALE}; current state unknown`,
      },
    ]);
    const arrived = jiraIssueFact(jiraIssue({ observedAt: STALE }), 'jira-2', ACTIVITY_BEFORE_REPLY);
    expect(
      interpretJiraFacts({ facts: [arrived], familyLastActivityAt: ACTIVITY_BEFORE_REPLY, now: NOW }).map(
        ({ kind }) => kind,
      ),
    ).toEqual(['jira-reply-arrived']);
  });

  test('ignores facts of other kinds and caps at the contract bound', () => {
    const facts = Array.from({ length: 20 }, (_value, index) =>
      jiraIssueFact(
        failedJiraIssue({ key: `XLB-${String(index + 1)}` }),
        `jira-${String(index)}`,
        ACTIVITY_BEFORE_REPLY,
      ),
    );
    expect(
      interpretJiraFacts({
        facts: [checkoutStatusFact(checkout(), 'co-1'), ...facts],
        familyLastActivityAt: ACTIVITY_BEFORE_REPLY,
        now: NOW,
      }),
    ).toHaveLength(16);
  });
});
