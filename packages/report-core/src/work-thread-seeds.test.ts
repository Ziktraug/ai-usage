import { describe, expect, test } from 'bun:test';
import { parseCanonicalInstant } from './canonical-instant';
import { type PullRequestObservation, parsePullRequestObservation } from './work-attention';
import { WORK_THREAD_BOUNDS } from './work-thread';
import { workThreadSeedsFromPullRequests } from './work-thread-seeds';

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
        routingJiraKey: null,
        title: 'Improve the demo',
      },
      {
        discoveredAt: observedAt,
        intent: 'review',
        linkKind: 'pull-request',
        origin: 'pull-request',
        originKey: 'github.com/other/project#12',
        projectLabel: 'other/project',
        routingJiraKey: null,
        title: 'Improve the demo',
      },
      {
        discoveredAt: observedAt,
        intent: 'change',
        linkKind: 'pull-request',
        origin: 'pull-request',
        originKey: 'other.example/demo/project#12',
        projectLabel: 'demo/project',
        routingJiraKey: null,
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
        routingJiraKey: null,
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
        routingJiraKey: null,
        title: 'Updated title',
      },
    ]);
    expect(workThreadSeedsFromPullRequests([newest, original])).toEqual(seeds);
    expect(workThreadSeedsFromPullRequests([original])[0]?.originKey).toBe(seeds[0]?.originKey);
    const linkOnly = { ...newest, discoveryRole: null };
    expect(workThreadSeedsFromPullRequests([original, linkOnly])).toEqual([]);
    expect(workThreadSeedsFromPullRequests([linkOnly, original])).toEqual([]);
  });

  test('only an authored PR whose branch names exactly one ticket carries a routing key', () => {
    const routing = (overrides: Partial<PullRequestObservation>) =>
      workThreadSeedsFromPullRequests([pullRequest(overrides)])[0]?.routingJiraKey;
    expect(routing({ headRef: 'fix/XLB-2085/wallet' })).toBe('jira:default/XLB-2085');
    expect(routing({ headRef: 'fix/XLB-2085/XLB-2086' })).toBeNull();
    expect(routing({ headRef: 'fix/xlb-2085-wallet' })).toBeNull();
    expect(routing({ headRef: 'chore/XLB-0/setup' })).toBeNull();
    expect(routing({ discoveryRole: 'review-requested', headRef: 'fix/XLB-2085/wallet' })).toBeNull();
  });

  test('legacy PR parser defaults new fields to null and validates reported enum values', () => {
    const { discoveryRole: _role, mergeable: _mergeable, mergeStateStatus: _state, ...legacy } = pullRequest();
    expect(parsePullRequestObservation(legacy)).toEqual({
      ...legacy,
      closedAt: null,
      createdAt: null,
      discoveryRole: null,
      mergeable: null,
      mergeStateStatus: null,
      unresolvedReviewThreads: null,
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
