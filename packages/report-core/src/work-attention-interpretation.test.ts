import { describe, expect, test } from 'bun:test';
import { canonicalInstantFromDate } from './canonical-instant';
import type { WorkFact, WorkFactProvenance, WorkRootDeclaration } from './work-attention';
import { interpretWorkRoot, type WorkRootCoverageInput } from './work-attention-interpretation';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const iso = (hoursAgo: number) => canonicalInstantFromDate(new Date(NOW.getTime() - hoursAgo * 3_600_000));

const provenance = (hoursAgo: number, source: WorkFactProvenance['source'] = 'claude-desktop'): WorkFactProvenance => ({
  coverage: 'complete',
  machineId: 'machine-a',
  observedAt: iso(hoursAgo),
  source,
});

const declaredTurn = (declaration: WorkRootDeclaration): WorkFact => ({
  declaredAt: declaration.at,
  desktopSessionId: 'local_root',
  detail: declaration.detail,
  id: 'local_root:declared-turn',
  kind: 'declared-turn',
  needsAction: declaration.needsAction,
  provenance: provenance(5),
  status: declaration.status,
});

const declaredPullRequest = (id: string, state: string, hoursAgo: number): WorkFact => ({
  branch: 'fixture/branch',
  host: 'github.com',
  id,
  kind: 'declared-pull-request',
  number: 117,
  provenance: provenance(hoursAgo),
  repository: 'fixture/ai-usage',
  state,
  url: null,
});

const observedPullRequest = (
  id: string,
  pullRequest: {
    readonly outcome?: 'observed' | 'network';
    readonly state: 'OPEN' | 'MERGED' | 'CLOSED' | null;
    readonly updatedAtHoursAgo: number | null;
  },
  observedHoursAgo: number,
): WorkFact => ({
  accountLabel: null,
  checksRollup: 'success',
  draft: false,
  host: 'github.com',
  id,
  kind: 'pull-request',
  number: 90,
  outcome: pullRequest.outcome ?? 'observed',
  provenance: provenance(observedHoursAgo, 'github'),
  repository: 'fixture/ai-usage',
  reviewDecision: null,
  state: pullRequest.state,
  updatedAt: pullRequest.updatedAtHoursAgo === null ? null : iso(pullRequest.updatedAtHoursAgo),
  url: null,
});

const proposal = (id: string, resolution: 'open' | 'started_notified' | 'dismissed'): WorkFact => ({
  createdAt: iso(2),
  id,
  kind: 'proposal',
  provenance: provenance(1),
  resolution,
  suggestionId: id,
  title: 'Fixture proposal',
  tldr: null,
});

const blocked = (needsAction: string | null, hoursAgo = 5): WorkRootDeclaration => ({
  at: iso(hoursAgo),
  detail: 'Stopped on a question.',
  needsAction,
  status: 'blocked',
});

const covered: WorkRootCoverageInput = { parentMissing: false, sessionJoined: true, unsupportedReason: null };

const interpret = (
  declaration: WorkRootDeclaration | null,
  facts: readonly WorkFact[] = [],
  coverage: WorkRootCoverageInput = covered,
) => interpretWorkRoot({ coverage, declaration, facts, now: NOW });

const kinds = (result: ReturnType<typeof interpretWorkRoot>) => result.interpretations.map(({ kind }) => kind);

describe('interpretWorkRoot', () => {
  test('a blocked declaration with a question is an open request', () => {
    const declaration = blocked('Confirm whether checkout 3 should be deleted.');
    const result = interpret(declaration, [declaredTurn(declaration)]);
    expect(result.attention).toBe('human-request');
    expect(kinds(result)).toEqual(['request-open']);
    expect(result.interpretations[0]?.evidence).toEqual(['local_root:declared-turn']);
    expect(result.interpretations[0]?.text).toContain('checkout 3');
  });

  test('a review-ready declaration is a human request', () => {
    const result = interpret({ at: iso(1), detail: 'Ready.', needsAction: null, status: 'review_ready' });
    expect(result.attention).toBe('human-request');
    expect(kinds(result)).toEqual(['review-ready']);
  });

  test('a completed declaration or none asks nothing', () => {
    expect(interpret({ at: iso(1), detail: 'Done.', needsAction: null, status: 'completed' })).toEqual({
      attention: 'none',
      interpretations: [],
    });
    expect(interpret(null)).toEqual({ attention: 'none', interpretations: [] });
    // Blocked without a question is not a request the product can relay.
    expect(interpret(blocked(null)).attention).toBe('none');
    expect(interpret(blocked('   ')).attention).toBe('none');
  });

  test('a request for a pull request is satisfied by one declared later in the same family', () => {
    const declaration = blocked('Open the pull request for the collector branch and push it.');
    const result = interpret(declaration, [declaredTurn(declaration), declaredPullRequest('child:pr', 'OPEN', 3)]);
    expect(result.attention).toBe('none');
    expect(kinds(result)).toEqual(['request-satisfied-elsewhere']);
    expect(result.interpretations[0]?.evidence).toEqual(['child:pr']);
    expect(result.interpretations[0]?.uncertainty).toContain('same family of sessions');
    expect(result.interpretations[0]?.text).toContain('fixture/ai-usage#117 (OPEN)');
    // Vocabulary variants and a MERGED state also satisfy.
    for (const needsAction of ['Please push the branch.', 'Commit the fix.', 'Merge it when green.', 'Open a PR.']) {
      const variant = blocked(needsAction);
      expect(interpret(variant, [declaredTurn(variant), declaredPullRequest('x', 'merged', 1)]).attention).toBe('none');
    }
  });

  test('an ambiguous question is never satisfied by a pull request', () => {
    const declaration = blocked('Yes or no?');
    const result = interpret(declaration, [declaredTurn(declaration), declaredPullRequest('child:pr', 'OPEN', 1)]);
    expect(result.attention).toBe('human-request');
    expect(kinds(result)).toEqual(['request-open']);
    // "prs" inside another word does not count either.
    const other = blocked('Should the supressor stay?');
    expect(interpret(other, [declaredTurn(other), declaredPullRequest('child:pr', 'OPEN', 1)]).attention).toBe(
      'human-request',
    );
  });

  test('a pull request declared before the request, or closed, satisfies nothing', () => {
    const declaration = blocked('Push the fix and merge it.', 6);
    expect(interpret(declaration, [declaredTurn(declaration), declaredPullRequest('old', 'MERGED', 30)])).toMatchObject(
      { attention: 'human-request' },
    );
    expect(
      interpret(declaration, [declaredTurn(declaration), declaredPullRequest('closed', 'CLOSED', 1)]),
    ).toMatchObject({ attention: 'human-request' });
  });

  test('open proposals are an optional lead that never outranks a request', () => {
    const lead = interpret(null, [proposal('p1', 'open'), proposal('p2', 'open')]);
    expect(lead.attention).toBe('optional-lead');
    expect(kinds(lead)).toEqual(['proposal-open']);
    expect(lead.interpretations[0]?.evidence).toEqual(['p1', 'p2']);
    expect(lead.interpretations[0]?.text).toBe('2 proposals are open and unanswered.');

    const declaration = blocked('Decide.');
    const both = interpret(declaration, [declaredTurn(declaration), proposal('p1', 'open')]);
    expect(both.attention).toBe('human-request');
    expect(kinds(both)).toEqual(['request-open', 'proposal-open']);
  });

  test('resolved proposals are reported as observed states, with dismissal reasons unknown', () => {
    const result = interpret(null, [proposal('p1', 'started_notified'), proposal('p2', 'dismissed')]);
    expect(result.attention).toBe('none');
    expect(kinds(result)).toEqual(['proposal-resolved']);
    expect(result.interpretations[0]?.text).toBe('1 proposal started, 1 proposal dismissed');
    expect(result.interpretations[0]?.uncertainty).toContain('reason is not recorded');
    const startedOnly = interpret(null, [proposal('p1', 'started_notified')]);
    expect(startedOnly.interpretations[0]?.uncertainty).not.toContain('dismissed');
  });

  test('an old declaration is stale but keeps its attention', () => {
    const declaration = blocked('Answer the stale question.', 40 * 24);
    const result = interpret(declaration, [declaredTurn(declaration)]);
    expect(result.attention).toBe('human-request');
    expect(kinds(result)).toEqual(['request-open', 'declared-status-stale']);
    expect(result.interpretations[1]?.text).toContain(declaration.at.slice(0, 10));
    const fresh = interpretWorkRoot({
      coverage: covered,
      declaration,
      facts: [],
      now: NOW,
      staleAfterMs: 60 * 24 * 3_600_000,
    });
    expect(kinds(fresh)).toEqual(['request-open']);
  });

  test('coverage gaps are named, one per missing piece, and never asserted as certainty', () => {
    const unsupported = interpret(null, [], { ...covered, unsupportedReason: 'Unsupported field shape: prs.' });
    expect(kinds(unsupported)).toEqual(['coverage-gap']);
    expect(unsupported.interpretations[0]?.text).toContain('Unsupported field shape: prs.');

    const unjoined = interpret(null, [], { ...covered, sessionJoined: false });
    expect(kinds(unjoined)).toEqual(['coverage-gap']);
    expect(unjoined.interpretations[0]?.text).toContain('No collected Session');

    const orphan = interpret(
      { at: iso(4), detail: 'Ready.', needsAction: null, status: 'review_ready' },
      [
        {
          desktopSessionId: 'local_missing',
          id: 'local_root:spawned-from',
          kind: 'spawned-from',
          provenance: provenance(4),
          taskId: null,
          title: null,
        },
      ],
      { ...covered, parentMissing: true },
    );
    expect(orphan.attention).toBe('human-request');
    expect(kinds(orphan)).toEqual(['review-ready', 'coverage-gap']);
    expect(orphan.interpretations[1]?.evidence).toEqual(['local_root:spawned-from']);
    expect(orphan.interpretations[1]?.uncertainty).toContain('may be a child');

    // A join that could not be consulted is not this root's gap.
    expect(interpret(null, [], { ...covered, sessionJoined: null })).toEqual({
      attention: 'none',
      interpretations: [],
    });
  });

  test('a request for a pull request is satisfied by one GitHub showed changed after the declaration', () => {
    // Declared MERGED long before the request: the declaration path does not satisfy it.
    const declaration = blocked('Push the fix and merge it.', 6);
    const before = interpret(declaration, [declaredTurn(declaration), declaredPullRequest('child:pr', 'MERGED', 30)]);
    expect(before.attention).toBe('human-request');

    const merged = observedPullRequest('gh:90', { state: 'MERGED', updatedAtHoursAgo: 2 }, 1);
    const result = interpret(declaration, [
      declaredTurn(declaration),
      declaredPullRequest('child:pr', 'MERGED', 30),
      merged,
    ]);
    expect(result.attention).toBe('none');
    expect(kinds(result)).toEqual(['request-satisfied-elsewhere']);
    expect(result.interpretations[0]?.evidence).toEqual(['gh:90']);
    expect(result.interpretations[0]?.text).toBe(
      `Asked to act on a pull request; GitHub showed fixture/ai-usage#90 (MERGED) at ${iso(1)} for a pull request this family declared.`,
    );
    expect(result.interpretations[0]?.uncertainty).toContain(
      'observed on GitHub for the PR this session family declared',
    );

    // An open pull request GitHub never dated counts from its observation time alone.
    const open = observedPullRequest('gh:91', { state: 'OPEN', updatedAtHoursAgo: null }, 1);
    expect(interpret(declaration, [declaredTurn(declaration), open]).attention).toBe('none');

    // Declared and observed together: both are named and both are evidence.
    const both = interpret(declaration, [
      declaredTurn(declaration),
      declaredPullRequest('child:new', 'OPEN', 3),
      merged,
    ]);
    expect(both.interpretations[0]?.evidence).toEqual(['child:new', 'gh:90']);
    expect(both.interpretations[0]?.text).toContain('later declared fixture/ai-usage#117 (OPEN) and GitHub showed');
  });

  test('an observed pull request changed before the request, read before it, failed or closed satisfies nothing', () => {
    const declaration = blocked('Push the fix and merge it.', 6);
    const cases: readonly WorkFact[] = [
      // Merged before the declaration, however recently read.
      observedPullRequest('gh:stale', { state: 'MERGED', updatedAtHoursAgo: 30 }, 1),
      // Read before the declaration.
      observedPullRequest('gh:early', { state: 'OPEN', updatedAtHoursAgo: null }, 8),
      observedPullRequest('gh:failed', { outcome: 'network', state: null, updatedAtHoursAgo: null }, 1),
      observedPullRequest('gh:closed', { state: 'CLOSED', updatedAtHoursAgo: 1 }, 1),
    ];
    for (const fact of cases) {
      const result = interpret(declaration, [declaredTurn(declaration), fact]);
      expect(result.attention).toBe('human-request');
      expect(kinds(result)).toEqual(['request-open']);
    }
    // A question without pull request vocabulary is never answered by one.
    const question = blocked('Yes or no?');
    expect(
      interpret(question, [
        declaredTurn(question),
        observedPullRequest('gh:1', { state: 'MERGED', updatedAtHoursAgo: 1 }, 1),
      ]).attention,
    ).toBe('human-request');
  });

  test('does not name external waits: an observed open pull request alone leaves attention at none', () => {
    // `external-review-pending` belongs to `interpretExternalFacts`; the read model merges the two.
    const observed = observedPullRequest('gh:117', { state: 'OPEN', updatedAtHoursAgo: null }, 1);
    expect(interpret(null, [observed])).toEqual({ attention: 'none', interpretations: [] });
    const declaration = blocked('Decide.');
    expect(interpret(declaration, [declaredTurn(declaration), observed]).attention).toBe('human-request');
  });

  test('refuses an invalid clock or stale window', () => {
    expect(() => interpretWorkRoot({ coverage: covered, declaration: null, facts: [], now: 'yesterday' })).toThrow(
      RangeError,
    );
    expect(() =>
      interpretWorkRoot({ coverage: covered, declaration: null, facts: [], now: NOW, staleAfterMs: 0 }),
    ).toThrow(RangeError);
  });
});
