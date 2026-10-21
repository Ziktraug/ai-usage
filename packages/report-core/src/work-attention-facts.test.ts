import { describe, expect, test } from 'bun:test';
import { parseCanonicalInstant } from './canonical-instant';
import type { CheckoutStatusObservation, PullRequestObservation } from './work-attention';
import { checkoutStatusFact, interpretExternalFacts, pullRequestFact } from './work-attention-facts';

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
