import { describe, expect, test } from 'bun:test';
import {
  parseCheckoutStatusObservation,
  parseClaudeDesktopSessionObservation,
  parseJiraIssueObservation,
  parsePullRequestObservation,
  WORK_ATTENTION_BOUNDS,
} from './work-attention';

const desktop = {
  accountDirectory: 'account-dir',
  archived: false,
  branch: 'feat/example',
  cliSessionId: '0f6d1d4e-1c1c-4d6a-9f1f-9d6c1a2b3c4d',
  completedTurns: 12,
  createdAt: 1_760_000_000_000,
  cwd: '/home/alex/projects/example',
  declaredPullRequests: [
    {
      baseRef: 'main',
      branch: 'feat/example',
      host: 'github.com',
      number: 42,
      own: true,
      repository: 'alex/example',
      state: 'OPEN',
      url: 'https://github.com/alex/example/pull/42',
    },
  ],
  desktopSessionId: 'local_6fd0e3a1-0000-4000-8000-000000000001',
  effort: 'high',
  fileModifiedAt: '2026-10-21T19:00:00.000Z',
  filePath: '.config/Claude/claude-code-sessions/account-dir/org-dir/local_6fd0e3a1.json',
  format: 'claude-desktop-session-v1',
  lastActivityAt: '2026-10-21T18:59:00.000Z',
  lastTurnReport: null,
  machineId: 'machine-a',
  model: 'claude-opus-5-5',
  observedAt: '2026-10-21T19:05:00.000Z',
  openSuggestions: [
    { createdAt: 1_760_000_100_000, expiresAt: null, id: 'task_abc', title: 'Follow up', tldr: 'Short' },
  ],
  organizationDirectory: 'org-dir',
  originCwd: '/home/alex/projects/example',
  priorCliSessionIds: [],
  resolvedSuggestions: { task_old: 'dismissed' },
  sideSessionNotes: [],
  sourceBranch: 'main',
  spawnedFrom: null,
  title: 'Example session',
  titleSource: 'auto',
  turnSummary: {
    detail: 'Waiting for a decision on the PR title',
    needsAction: 'commit on this branch?',
    status: 'blocked',
    summarizesUuid: 'uuid-1',
  },
  unsupportedReason: null,
  worktreePath: null,
  wrapUpDescription: null,
  writtenBranches: ['feat/example'],
};

describe('parseClaudeDesktopSessionObservation', () => {
  test('accepts a complete row and normalizes epoch timestamps', () => {
    const parsed = parseClaudeDesktopSessionObservation(desktop);
    expect(parsed).not.toBeNull();
    expect(String(parsed?.createdAt)).toBe('2025-10-09T08:53:20.000Z');
    expect(parsed?.turnSummary?.needsAction).toBe('commit on this branch?');
    expect(parsed?.resolvedSuggestions).toEqual({ task_old: 'dismissed' });
    expect(parsed?.declaredPullRequests[0]?.number).toBe(42);
  });

  test('absent optional families parse as empty, never as undefined', () => {
    const { openSuggestions: _o, resolvedSuggestions: _r, declaredPullRequests: _p, ...rest } = desktop;
    const parsed = parseClaudeDesktopSessionObservation(rest);
    expect(parsed?.openSuggestions).toEqual([]);
    expect(parsed?.resolvedSuggestions).toEqual({});
    expect(parsed?.declaredPullRequests).toEqual([]);
  });

  test('rejects an unknown turn status, an unknown resolution and over-bound text', () => {
    expect(
      parseClaudeDesktopSessionObservation({ ...desktop, turnSummary: { ...desktop.turnSummary, status: 'done' } }),
    ).toBeNull();
    expect(
      parseClaudeDesktopSessionObservation({ ...desktop, resolvedSuggestions: { task_x: 'accepted' } }),
    ).toBeNull();
    expect(
      parseClaudeDesktopSessionObservation({
        ...desktop,
        lastTurnReport: 'x'.repeat(WORK_ATTENTION_BOUNDS.maxReportText + 1),
      }),
    ).toBeNull();
  });

  test('requires the join key and the file provenance', () => {
    expect(parseClaudeDesktopSessionObservation({ ...desktop, cliSessionId: '' })).toBeNull();
    expect(parseClaudeDesktopSessionObservation({ ...desktop, fileModifiedAt: 'not-a-date' })).toBeNull();
    expect(parseClaudeDesktopSessionObservation({ ...desktop, machineId: undefined })).toBeNull();
  });
});

describe('parsePullRequestObservation', () => {
  const observed = {
    accountLabel: 'alex',
    baseRef: 'main',
    checksRollup: 'pending',
    draft: false,
    headRef: 'feat/example',
    host: 'github.com',
    machineId: 'machine-a',
    mergedAt: null,
    number: 42,
    observedAt: '2026-10-21T19:05:00.000Z',
    outcome: 'observed',
    outcomeMessage: null,
    repository: 'alex/example',
    reviewDecision: 'REVIEW_REQUIRED',
    state: 'OPEN',
    title: 'Example',
    updatedAt: '2026-10-21T18:00:00.000Z',
    url: 'https://github.com/alex/example/pull/42',
  };
  test('keeps a failed read as an observation with null GitHub fields', () => {
    const failed = parsePullRequestObservation({
      ...observed,
      outcome: 'unauthenticated',
      outcomeMessage: 'gh: not logged in',
      state: null,
      draft: null,
      reviewDecision: null,
      checksRollup: null,
      title: null,
      url: null,
      headRef: null,
      baseRef: null,
      updatedAt: null,
    });
    expect(failed?.outcome).toBe('unauthenticated');
    expect(failed?.state).toBeNull();
    expect(parsePullRequestObservation(observed)?.checksRollup).toBe('pending');
  });
  test('rejects unknown states and non-positive numbers', () => {
    expect(parsePullRequestObservation({ ...observed, state: 'open' })).toBeNull();
    expect(parsePullRequestObservation({ ...observed, number: 0 })).toBeNull();
    expect(parsePullRequestObservation({ ...observed, outcome: 'ok' })).toBeNull();
  });
});

describe('parseJiraIssueObservation', () => {
  const observed = {
    assigneeLabel: 'Alex',
    commentCount: 3,
    comments: [
      { authorLabel: 'Sam', createdAt: '2026-10-21T18:00:00.000Z', excerpt: 'Looks fine, one question.', id: '1' },
    ],
    key: 'XLB-2090',
    machineId: 'machine-a',
    observedAt: '2026-10-21T19:05:00.000Z',
    outcome: 'observed',
    outcomeMessage: null,
    parentKey: 'XLB-2000',
    sprint: 'Sprint 42',
    status: 'In Progress',
    statusCategory: 'in-progress',
    summary: 'Promo badge',
    updatedAt: '2026-10-21T18:00:00.000Z',
  };
  test('accepts an observed issue and a failed read with null Jira fields', () => {
    expect(parseJiraIssueObservation(observed)).toEqual(observed as never);
    const failed = parseJiraIssueObservation({
      ...observed,
      assigneeLabel: null,
      commentCount: null,
      comments: [],
      outcome: 'unauthenticated',
      outcomeMessage: 'Jira rejected the credentials (HTTP 401)',
      parentKey: null,
      sprint: null,
      status: null,
      statusCategory: null,
      summary: null,
      updatedAt: null,
    });
    expect(failed?.outcome).toBe('unauthenticated');
    expect(failed?.status).toBeNull();
    expect(parseJiraIssueObservation({ ...observed, comments: undefined, parentKey: undefined })).toMatchObject({
      comments: [],
      parentKey: null,
    });
  });
  test('rejects a malformed key, an unknown category, an address as a person, and over-bound comments', () => {
    expect(parseJiraIssueObservation({ ...observed, key: 'xlb-2090' })).toBeNull();
    expect(parseJiraIssueObservation({ ...observed, key: '2090' })).toBeNull();
    expect(parseJiraIssueObservation({ ...observed, statusCategory: 'open' })).toBeNull();
    expect(parseJiraIssueObservation({ ...observed, outcome: 'ok' })).toBeNull();
    expect(parseJiraIssueObservation({ ...observed, parentKey: 'parent' })).toBeNull();
    expect(parseJiraIssueObservation({ ...observed, assigneeLabel: 'alex@example.com' })).toBeNull();
    expect(
      parseJiraIssueObservation({
        ...observed,
        comments: [{ ...observed.comments[0], authorLabel: 'sam@example.com' }],
      }),
    ).toBeNull();
    expect(
      parseJiraIssueObservation({ ...observed, comments: [{ ...observed.comments[0], excerpt: 'x'.repeat(281) }] }),
    ).toBeNull();
    expect(
      parseJiraIssueObservation({
        ...observed,
        comments: Array.from({ length: 11 }, (_value, index) => ({ ...observed.comments[0], id: String(index) })),
      }),
    ).toBeNull();
    expect(parseJiraIssueObservation({ ...observed, commentCount: -1 })).toBeNull();
  });
});

describe('parseCheckoutStatusObservation', () => {
  const observed = {
    ahead: 2,
    behind: 0,
    branch: 'feat/example',
    checkoutPath: '/home/alex/projects/example',
    dirty: true,
    headSha: 'abc123',
    lastCommitAt: '2026-10-21T17:00:00.000Z',
    machineId: 'machine-a',
    modifiedCount: 3,
    observedAt: '2026-10-21T19:05:00.000Z',
    outcome: 'observed',
    stagedCount: 0,
    untrackedCount: 1,
    upstream: 'origin/feat/example',
  };
  test('accepts an observed checkout and a missing one with null counts', () => {
    expect(parseCheckoutStatusObservation(observed)?.dirty).toBe(true);
    const missing = parseCheckoutStatusObservation({
      ...observed,
      outcome: 'missing',
      branch: null,
      headSha: null,
      upstream: null,
      ahead: null,
      behind: null,
      stagedCount: null,
      modifiedCount: null,
      untrackedCount: null,
      lastCommitAt: null,
      dirty: null,
    });
    expect(missing?.outcome).toBe('missing');
    expect(missing?.modifiedCount).toBeNull();
  });
  test('rejects negative counts and unknown outcomes', () => {
    expect(parseCheckoutStatusObservation({ ...observed, modifiedCount: -1 })).toBeNull();
    expect(parseCheckoutStatusObservation({ ...observed, outcome: 'clean' })).toBeNull();
  });
});
