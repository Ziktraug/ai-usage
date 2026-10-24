import { describe, expect, test } from 'bun:test';
import { parseCanonicalInstant } from './canonical-instant';
import { type JiraIssueObservation, type PullRequestObservation, parsePullRequestObservation } from './work-attention';
import { WORK_THREAD_BOUNDS } from './work-thread';
import { workThreadSeedsFromJiraIssues, workThreadSeedsFromPullRequests } from './work-thread-seeds';

const observedAt = parseCanonicalInstant('2026-10-24T10:00:00.000Z');
const later = parseCanonicalInstant('2026-10-24T11:00:00.000Z');
const pullRequest = (overrides: Partial<PullRequestObservation> = {}): PullRequestObservation => ({
  accountLabel: null,
  baseRef: 'trunk',
  checksRollup: 'success',
  discoveryRole: 'author',
  draft: false,
  headRef: 'change',
  host: 'github.com',
  machineId: 'machine-a',
  mergeable: 'MERGEABLE',
  mergedAt: null,
  mergeStateStatus: 'BEHIND',
  number: 12,
  observedAt,
  outcome: 'observed',
  outcomeMessage: null,
  repository: 'demo/project',
  reviewDecision: null,
  state: 'OPEN',
  title: 'Improve the demo',
  updatedAt: observedAt,
  url: 'https://github.com/demo/project/pull/12',
  ...overrides,
});
const jiraIssue = (overrides: Partial<JiraIssueObservation> = {}): JiraIssueObservation => ({
  assigneeLabel: 'Demo Person',
  commentCount: 0,
  comments: [],
  key: 'DEMO-12',
  machineId: 'machine-a',
  observedAt,
  outcome: 'observed',
  outcomeMessage: null,
  parentKey: null,
  sprint: null,
  status: 'In progress',
  statusCategory: 'in-progress',
  summary: 'Improve the demo',
  updatedAt: observedAt,
  ...overrides,
});

describe('work thread seeds', () => {
  test('keeps fully qualified identities and chooses author or review intent without sessions', () => {
    const observations = [
      pullRequest(),
      pullRequest({ repository: 'other/project', discoveryRole: 'review-requested' }),
      pullRequest({ host: 'other.example' }),
    ];
    expect(workThreadSeedsFromPullRequests(observations)).toEqual([
      {
        discoveredAt: observedAt,
        intent: 'change',
        linkKind: 'pull-request',
        origin: 'pull-request',
        originKey: 'github.com/demo/project#12',
        projectLabel: 'demo/project',
        title: 'Improve the demo',
      },
      {
        discoveredAt: observedAt,
        intent: 'review',
        linkKind: 'pull-request',
        origin: 'pull-request',
        originKey: 'github.com/other/project#12',
        projectLabel: 'other/project',
        title: 'Improve the demo',
      },
      {
        discoveredAt: observedAt,
        intent: 'change',
        linkKind: 'pull-request',
        origin: 'pull-request',
        originKey: 'other.example/demo/project#12',
        projectLabel: 'demo/project',
        title: 'Improve the demo',
      },
    ]);
    expect(workThreadSeedsFromPullRequests([...observations].reverse())).toEqual(
      workThreadSeedsFromPullRequests(observations),
    );
  });

  test('latest successful observations win deterministically and failures or link-only observations never seed', () => {
    const observations = [
      pullRequest(),
      pullRequest({ observedAt: later, title: 'New title' }),
      pullRequest({ observedAt: later, outcome: 'network', title: null }),
      pullRequest({ discoveryRole: null, number: 20 }),
    ];
    const before = JSON.stringify(observations);
    expect(workThreadSeedsFromPullRequests(observations)).toEqual([
      {
        discoveredAt: later,
        intent: 'change',
        linkKind: 'pull-request',
        origin: 'pull-request',
        originKey: 'github.com/demo/project#12',
        projectLabel: 'demo/project',
        title: 'New title',
      },
    ]);
    expect(workThreadSeedsFromPullRequests([...observations].reverse())).toEqual(
      workThreadSeedsFromPullRequests(observations),
    );
    expect(JSON.stringify(observations)).toBe(before);
  });

  test('titles fit the frozen thread contract and retain source identity when absent', () => {
    expect(workThreadSeedsFromPullRequests([pullRequest({ title: 'x'.repeat(512) })])[0]?.title).toHaveLength(
      WORK_THREAD_BOUNDS.maxTitle,
    );
    expect(workThreadSeedsFromPullRequests([pullRequest({ title: null })])[0]?.title).toBe('demo/project#12');
    expect(workThreadSeedsFromJiraIssues([jiraIssue({ summary: null })])[0]?.title).toBe('DEMO-12');
  });

  test('a newer successful link-only observation removes discovery eligibility', () => {
    const observations = [pullRequest(), pullRequest({ discoveryRole: null, observedAt: later })];
    expect(workThreadSeedsFromPullRequests(observations)).toEqual([]);
    expect(workThreadSeedsFromPullRequests([...observations].reverse())).toEqual([]);
  });

  test('repository casing cannot split discovery identity or resurrect an older discovery role', () => {
    const original = pullRequest({ repository: 'Fixture/Project' });
    const newest = pullRequest({
      discoveryRole: 'review-requested',
      observedAt: later,
      repository: 'fixture/PROJECT',
      title: 'Updated title',
    });
    const seeds = workThreadSeedsFromPullRequests([original, newest]);
    expect(seeds).toEqual([
      {
        discoveredAt: later,
        intent: 'review',
        linkKind: 'pull-request',
        origin: 'pull-request',
        originKey: 'github.com/fixture/project#12',
        projectLabel: 'fixture/PROJECT',
        title: 'Updated title',
      },
    ]);
    expect(workThreadSeedsFromPullRequests([newest, original])).toEqual(seeds);
    expect(workThreadSeedsFromPullRequests([original])[0]?.originKey).toBe(seeds[0]?.originKey);
    const linkOnly = { ...newest, discoveryRole: null };
    expect(workThreadSeedsFromPullRequests([original, linkOnly])).toEqual([]);
    expect(workThreadSeedsFromPullRequests([linkOnly, original])).toEqual([]);
  });

  test('Jira uses the CLI default site, latest success and no inferred intent', () => {
    const observations = [
      jiraIssue(),
      jiraIssue({ observedAt: later, summary: 'Updated summary' }),
      jiraIssue({ observedAt: later, outcome: 'network' }),
      jiraIssue({ key: 'OTHER-12' }),
    ];
    expect(workThreadSeedsFromJiraIssues(observations)).toEqual([
      {
        discoveredAt: later,
        intent: null,
        linkKind: 'jira-issue',
        origin: 'jira-issue',
        originKey: 'jira:default/DEMO-12',
        projectLabel: 'DEMO',
        title: 'Updated summary',
      },
      {
        discoveredAt: observedAt,
        intent: null,
        linkKind: 'jira-issue',
        origin: 'jira-issue',
        originKey: 'jira:default/OTHER-12',
        projectLabel: 'OTHER',
        title: 'Improve the demo',
      },
    ]);
    expect(workThreadSeedsFromJiraIssues([...observations].reverse())).toEqual(
      workThreadSeedsFromJiraIssues(observations),
    );
  });

  test('legacy PR parser defaults new fields to null and validates reported enum values', () => {
    const { discoveryRole: _role, mergeable: _mergeable, mergeStateStatus: _state, ...legacy } = pullRequest();
    expect(parsePullRequestObservation(legacy)).toEqual({
      ...legacy,
      discoveryRole: null,
      mergeable: null,
      mergeStateStatus: null,
    });
    expect(parsePullRequestObservation(pullRequest())).toMatchObject({
      discoveryRole: 'author',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BEHIND',
    });
    expect(parsePullRequestObservation({ ...legacy, discoveryRole: 'viewer' })).toBeNull();
    expect(parsePullRequestObservation({ ...legacy, mergeable: 'BEHIND' })).toBeNull();
    expect(parsePullRequestObservation({ ...legacy, mergeStateStatus: 123 })).toBeNull();
    expect(parsePullRequestObservation({ ...legacy, mergeStateStatus: 'FUTURE_STATE' })?.mergeStateStatus).toBe(
      'FUTURE_STATE',
    );
  });
});
