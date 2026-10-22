import { describe, expect, test } from 'bun:test';
import { canonicalInstantFromDate } from './canonical-instant';
import type { WorkFact, WorkFactProvenance, WorkRootDeclaration } from './work-attention';
import {
  interpretWorkRoot,
  NO_HARNESS_CONTEXT,
  type WorkLinkedSession,
  type WorkRootCoverageInput,
  type WorkRootHarnessInput,
} from './work-attention-interpretation';

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

/** `hoursAgo` dates the session's activity and, unless `fileHoursAgo` says otherwise, its file. */
const declaredPullRequest = (
  id: string,
  state: string,
  hoursAgo: number,
  options: { readonly declaredBy?: 'root' | 'child'; readonly fileHoursAgo?: number; readonly number?: number } = {},
): WorkFact => ({
  branch: 'fixture/branch',
  declaredBy: options.declaredBy ?? 'child',
  host: 'github.com',
  id,
  kind: 'declared-pull-request',
  lastActivityAt: iso(hoursAgo),
  number: options.number ?? 117,
  provenance: provenance(options.fileHoursAgo ?? hoursAgo),
  repository: 'fixture/ai-usage',
  state,
  url: null,
});

const observedPullRequest = (
  id: string,
  pullRequest: {
    readonly draft?: boolean | null;
    readonly mergedAtHoursAgo?: number | null;
    readonly number?: number;
    readonly outcome?: 'observed' | 'network';
    readonly state: 'OPEN' | 'MERGED' | 'CLOSED' | null;
    readonly updatedAtHoursAgo: number | null;
  },
  observedHoursAgo: number,
): WorkFact => ({
  accountLabel: null,
  checksRollup: 'success',
  draft: pullRequest.draft === undefined ? false : pullRequest.draft,
  host: 'github.com',
  id,
  kind: 'pull-request',
  mergedAt:
    pullRequest.mergedAtHoursAgo === undefined || pullRequest.mergedAtHoursAgo === null
      ? null
      : iso(pullRequest.mergedAtHoursAgo),
  number: pullRequest.number ?? 90,
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

const STAYS_YOURS = 'This does not prove it is the same work; the question stays yours until you confirm.';

describe('interpretWorkRoot', () => {
  test('a blocked declaration with a question is an open request', () => {
    const declaration = blocked('Confirm whether checkout 3 should be deleted.');
    const result = interpret(declaration, [declaredTurn(declaration)]);
    expect(result.attention).toBe('human-request');
    expect(result.reconsidered).toBe(false);
    expect(kinds(result)).toEqual(['request-open']);
    expect(result.interpretations[0]?.evidence).toEqual(['local_root:declared-turn']);
    expect(result.interpretations[0]?.text).toContain('checkout 3');
    expect(result.interpretations[0]?.uncertainty).toContain('nothing observed since says it was answered');
  });

  test('a review-ready declaration is a human request', () => {
    const result = interpret({ at: iso(1), detail: 'Ready.', needsAction: null, status: 'review_ready' });
    expect(result.attention).toBe('human-request');
    expect(result.reconsidered).toBe(false);
    expect(kinds(result)).toEqual(['review-ready']);
  });

  test('a completed declaration or none asks nothing', () => {
    expect(interpret({ at: iso(1), detail: 'Done.', needsAction: null, status: 'completed' })).toEqual({
      attention: 'none',
      interpretations: [],
      reconsidered: false,
    });
    expect(interpret(null)).toEqual({ attention: 'none', interpretations: [], reconsidered: false });
    // Blocked without a question is not a request the product can relay.
    expect(interpret(blocked(null)).attention).toBe('none');
    expect(interpret(blocked('   ')).attention).toBe('none');
  });

  test('a pull request a child declared after the request marks it reconsidered, never answered', () => {
    const declaration = blocked('Open the pull request for the collector branch and push it.');
    const result = interpret(declaration, [declaredTurn(declaration), declaredPullRequest('child:pr', 'OPEN', 3)]);
    expect(result.attention).toBe('human-request');
    expect(result.reconsidered).toBe(true);
    expect(kinds(result)).toEqual(['request-open', 'request-satisfied-elsewhere']);
    expect(result.interpretations[0]?.uncertainty).toContain('a later pull request may be the answer');
    expect(result.interpretations[1]).toEqual({
      evidence: ['child:pr'],
      kind: 'request-satisfied-elsewhere',
      text: `Possibly answered elsewhere: fixture/ai-usage#117 (OPEN) listed by a child session (last active at ${iso(3)}), after the question.`,
      uncertainty: STAYS_YOURS,
    });
    // Vocabulary variants and a MERGED state are read the same way.
    for (const needsAction of ['Please push the branch.', 'Commit the fix.', 'Merge it when green.', 'Open a PR.']) {
      const variant = blocked(needsAction);
      const read = interpret(variant, [declaredTurn(variant), declaredPullRequest('x', 'merged', 1)]);
      expect(read.attention).toBe('human-request');
      expect(read.reconsidered).toBe(true);
    }
  });

  test('probe F4: a child file rewritten after the question is not a listing after it; the child’s activity is', () => {
    const declaration = blocked('Open the pull request for the collector branch.');
    // The child was last active 8 h ago, before the question; the app rewrote its file 2 h ago.
    const rewritten = declaredPullRequest('child:pr', 'OPEN', 8, { fileHoursAgo: 2 });
    const stale = interpret(declaration, [declaredTurn(declaration), rewritten]);
    expect(stale.attention).toBe('human-request');
    expect(stale.reconsidered).toBe(false);
    expect(kinds(stale)).toEqual(['request-open']);
    // Active after the question: the listing counts, whatever the file's modification time says.
    const active = declaredPullRequest('child:pr', 'OPEN', 3, { fileHoursAgo: 2 });
    const result = interpret(declaration, [declaredTurn(declaration), active]);
    expect(result.reconsidered).toBe(true);
    expect(result.interpretations[1]?.text).toBe(
      `Possibly answered elsewhere: fixture/ai-usage#117 (OPEN) listed by a child session (last active at ${iso(3)}), after the question.`,
    );
  });

  test('probe A: the root’s own declared pull request never answers its own question', () => {
    // The desktop app lists the checkout branch's pull request on the root itself.
    const declaration = blocked('Should I push the WIP commit before the review starts?');
    const result = interpret(declaration, [
      declaredTurn(declaration),
      declaredPullRequest('root:pr', 'OPEN', 1, { declaredBy: 'root', number: 66 }),
    ]);
    expect(result.attention).toBe('human-request');
    expect(result.reconsidered).toBe(false);
    expect(kinds(result)).toEqual(['request-open']);
  });

  test('probe B: a question without pull request vocabulary is never reconsidered by one', () => {
    const declaration = blocked('Yes or no?');
    const result = interpret(declaration, [declaredTurn(declaration), declaredPullRequest('child:pr', 'OPEN', 1)]);
    expect(result.attention).toBe('human-request');
    expect(result.reconsidered).toBe(false);
    expect(kinds(result)).toEqual(['request-open']);
    // "prs" inside another word does not count either.
    const other = blocked('Should the supressor stay?');
    expect(interpret(other, [declaredTurn(other), declaredPullRequest('child:pr', 'OPEN', 1)]).reconsidered).toBe(
      false,
    );
    const observedOnly = blocked('Yes or no?');
    expect(
      interpret(observedOnly, [
        declaredTurn(observedOnly),
        observedPullRequest('gh:1', { mergedAtHoursAgo: 1, state: 'MERGED', updatedAtHoursAgo: 1 }, 1),
      ]).reconsidered,
    ).toBe(false);
  });

  test('probe D: an open pull request merely updated after the question is a hint, not an answer', () => {
    const declaration = blocked('Push the WIP commit and open the PR.');
    const bumped = observedPullRequest('gh:66', { number: 66, state: 'OPEN', updatedAtHoursAgo: 1 }, 0.5);
    // Observed alone, or beside the root's own declaration of the same pull request.
    for (const facts of [
      [declaredTurn(declaration), bumped],
      [
        declaredTurn(declaration),
        declaredPullRequest('root:pr', 'OPEN', 1, { declaredBy: 'root', number: 66 }),
        bumped,
      ],
    ]) {
      const result = interpret(declaration, facts);
      expect(result.attention).toBe('human-request');
      expect(result.reconsidered).toBe(false);
      expect(kinds(result)).toEqual(['request-open']);
    }
    // The same open pull request declared by a child after the question: both sources agree.
    const both = interpret(declaration, [
      declaredTurn(declaration),
      declaredPullRequest('child:pr', 'OPEN', 2, { number: 66 }),
      bumped,
    ]);
    expect(both.attention).toBe('human-request');
    expect(both.reconsidered).toBe(true);
    expect(both.interpretations[1]?.evidence).toEqual(['child:pr', 'gh:66']);
    expect(both.interpretations[1]?.text).toContain('listed by a child session');
    expect(both.interpretations[1]?.text).toContain('observed on GitHub');
    // A draft, or an open pull request GitHub never dated, is not an answer even with the child.
    const draft = observedPullRequest('gh:66', { draft: true, number: 66, state: 'OPEN', updatedAtHoursAgo: 1 }, 0.5);
    const undated = observedPullRequest('gh:66', { number: 66, state: 'OPEN', updatedAtHoursAgo: null }, 0.5);
    for (const fact of [draft, undated]) {
      const read = interpret(declaration, [declaredTurn(declaration), declaredPullRequest('old', 'OPEN', 8), fact]);
      expect(read.reconsidered).toBe(false);
    }
  });

  test('a pull request GitHub showed merged at or after the request marks it reconsidered', () => {
    // Declared MERGED by the child long before the request: the declaration path says nothing.
    const declaration = blocked('Push the fix and merge it.', 6);
    const before = interpret(declaration, [declaredTurn(declaration), declaredPullRequest('child:pr', 'MERGED', 30)]);
    expect(before.attention).toBe('human-request');
    expect(before.reconsidered).toBe(false);

    const merged = observedPullRequest('gh:90', { mergedAtHoursAgo: 2, state: 'MERGED', updatedAtHoursAgo: 2 }, 1);
    const result = interpret(declaration, [
      declaredTurn(declaration),
      declaredPullRequest('child:pr', 'MERGED', 30),
      merged,
    ]);
    expect(result.attention).toBe('human-request');
    expect(result.reconsidered).toBe(true);
    expect(kinds(result)).toEqual(['request-open', 'request-satisfied-elsewhere']);
    expect(result.interpretations[1]?.evidence).toEqual(['gh:90']);
    expect(result.interpretations[1]?.text).toBe(
      `Possibly answered elsewhere: fixture/ai-usage#90 (MERGED, merged at ${iso(2)}) observed on GitHub at ${iso(1)}, after the question.`,
    );
    expect(result.interpretations[1]?.uncertainty).toBe(STAYS_YOURS);

    // Merged before the request, or merged at an unknown time, is not an answer however recently read.
    const earlier = observedPullRequest('gh:stale', { mergedAtHoursAgo: 30, state: 'MERGED', updatedAtHoursAgo: 1 }, 1);
    const undated = observedPullRequest(
      'gh:undated',
      { mergedAtHoursAgo: null, state: 'MERGED', updatedAtHoursAgo: 1 },
      1,
    );
    for (const fact of [earlier, undated]) {
      const read = interpret(declaration, [declaredTurn(declaration), fact]);
      expect(read.reconsidered).toBe(false);
      expect(kinds(read)).toEqual(['request-open']);
    }

    // Declared and observed together: both are named and both are evidence.
    const both = interpret(declaration, [
      declaredTurn(declaration),
      declaredPullRequest('child:new', 'OPEN', 3),
      merged,
    ]);
    expect(both.interpretations[1]?.evidence).toEqual(['child:new', 'gh:90']);
    expect(both.interpretations[1]?.text).toContain(
      `fixture/ai-usage#117 (OPEN) listed by a child session (last active at ${iso(3)}); fixture/ai-usage#90 (MERGED`,
    );
  });

  test('a pull request declared before the request, closed, read before it or failed changes nothing', () => {
    const declaration = blocked('Push the fix and merge it.', 6);
    const cases: readonly WorkFact[] = [
      declaredPullRequest('old', 'MERGED', 30),
      declaredPullRequest('closed', 'CLOSED', 1),
      // Read before the declaration.
      observedPullRequest('gh:early', { mergedAtHoursAgo: 7, state: 'MERGED', updatedAtHoursAgo: null }, 8),
      observedPullRequest('gh:failed', { outcome: 'network', state: null, updatedAtHoursAgo: null }, 1),
      observedPullRequest('gh:closed', { state: 'CLOSED', updatedAtHoursAgo: 1 }, 1),
    ];
    for (const fact of cases) {
      const result = interpret(declaration, [declaredTurn(declaration), fact]);
      expect(result.attention).toBe('human-request');
      expect(result.reconsidered).toBe(false);
      expect(kinds(result)).toEqual(['request-open']);
    }
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
      reconsidered: false,
    });
  });

  test('does not name external waits: an observed open pull request alone leaves attention at none', () => {
    // `external-review-pending` belongs to `interpretExternalFacts`; the read model merges the two.
    const observed = observedPullRequest('gh:117', { state: 'OPEN', updatedAtHoursAgo: null }, 1);
    expect(interpret(null, [observed])).toEqual({ attention: 'none', interpretations: [], reconsidered: false });
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

describe('interpretWorkRoot against what the harness recorded after the request (ADR 0056)', () => {
  const question = blocked('Which of the two 320px layouts do you prefer?', 5);
  const withHarness = (
    declaration: WorkRootDeclaration | null,
    harness: Partial<WorkRootHarnessInput>,
    facts: readonly WorkFact[] = declaration === null ? [] : [declaredTurn(declaration)],
  ) =>
    interpretWorkRoot({
      coverage: covered,
      declaration,
      facts,
      harness: { ...NO_HARNESS_CONTEXT, ...harness },
      now: NOW,
    });
  const childTurn = (id: string, status: 'blocked' | 'completed' | 'review_ready', hoursAgo: number): WorkFact => ({
    declaredAt: iso(hoursAgo),
    desktopSessionId: id,
    detail: `Declared ${status}.`,
    id: `${id}:declared-turn`,
    kind: 'declared-turn',
    needsAction: status === 'blocked' ? 'Child question?' : null,
    provenance: provenance(hoursAgo),
    status,
  });
  const linked = (
    id: string,
    link: WorkLinkedSession['link'],
    linkedHoursAgo: number,
    status: 'blocked' | 'completed' | 'review_ready' | null,
    declaredHoursAgo = linkedHoursAgo - 0.5,
  ): WorkLinkedSession => ({
    declaration: status === null ? null : { at: iso(declaredHoursAgo), factId: `${id}:declared-turn`, status },
    desktopSessionId: id,
    link,
    linkedAt: iso(linkedHoursAgo),
    linkFactId: link === 'side-session-note' ? `local_root:note:${id}` : null,
    title: `Fixture ${id}`,
  });

  test('a message recorded after the question answers it: no confirmation, dated, with its evidence', () => {
    const result = withHarness(question, { latestUserFrameAt: iso(4) });
    expect(result.attention).toBe('none');
    expect(result.reconsidered).toBe(false);
    expect(kinds(result)).toEqual(['request-answered']);
    expect(result.interpretations[0]?.evidence).toEqual(['local_root:declared-turn']);
    expect(result.interpretations[0]?.text).toBe(
      `Answered in Claude Desktop: you wrote to the session at ${iso(4)}, after the question “Which of the two 320px layouts do you prefer?” (asked ${iso(5)}); it has not declared since.`,
    );
    expect(result.interpretations[0]?.uncertainty).toContain('authorization');
  });

  test('a message recorded before the question answers nothing', () => {
    const result = withHarness(question, { latestUserFrameAt: iso(5.5) });
    expect(result.attention).toBe('human-request');
    expect(kinds(result)).toEqual(['request-open']);
  });

  test('a review request answered in the harness and an archived session are no longer waiting', () => {
    const review: WorkRootDeclaration = { at: iso(5), detail: 'Ready.', needsAction: null, status: 'review_ready' };
    expect(kinds(withHarness(review, { latestUserFrameAt: iso(4) }))).toEqual(['request-answered']);
    const archived = withHarness(question, { archived: true });
    expect(archived.attention).toBe('none');
    expect(kinds(archived)).toEqual(['request-archived']);
  });

  test('Q1 answered, then Q2: Q1 is read as answered with its dates, Q2 stays the current request', () => {
    const current = blocked('Delete checkout 3 now?', 3);
    const result = withHarness(
      current,
      {
        earlierDeclarations: [
          {
            declaredAt: iso(6),
            factId: 'local_root:declared-turn:q1',
            needsAction: 'Which of the two 320px layouts do you prefer?',
            repliedAt: iso(5),
            status: 'blocked',
            supersededAt: iso(3),
          },
        ],
        latestUserFrameAt: iso(5),
      },
      [declaredTurn(current)],
    );
    expect(result.attention).toBe('human-request');
    expect(result.reconsidered).toBe(false);
    expect(kinds(result)).toEqual(['request-open', 'earlier-request-answered']);
    expect(result.interpretations[0]?.text).toBe('The session stopped on a question: Delete checkout 3 now?');
    expect(result.interpretations[1]?.evidence).toEqual(['local_root:declared-turn:q1', 'local_root:declared-turn']);
    expect(result.interpretations[1]?.text).toBe(
      `Answered in Claude Desktop: the question “Which of the two 320px layouts do you prefer?” (asked ${iso(6)}); you wrote to the session at ${iso(5)} and it declared again at ${iso(3)}.`,
    );
  });

  test('an earlier question replaced without a recorded message is no longer asked, and says so', () => {
    const current = blocked('Delete checkout 3 now?', 3);
    const result = withHarness(
      current,
      {
        earlierDeclarations: [
          {
            declaredAt: iso(6),
            factId: 'local_root:declared-turn:q1',
            needsAction: 'Which layout?',
            repliedAt: null,
            status: 'blocked',
            supersededAt: iso(3),
          },
        ],
      },
      [declaredTurn(current)],
    );
    expect(kinds(result)).toEqual(['request-open', 'earlier-request-superseded']);
    expect(result.interpretations[1]?.uncertainty).toContain('No message from you was recorded in between');
  });

  test('the same question asked again after a message stays the current request and says it was asked before', () => {
    const current = blocked('Which layout?', 3);
    const result = withHarness(
      current,
      {
        earlierDeclarations: [
          {
            declaredAt: iso(6),
            factId: 'local_root:declared-turn:q1',
            needsAction: '  which   layout? ',
            repliedAt: iso(5),
            status: 'blocked',
            supersededAt: iso(3),
          },
        ],
        latestUserFrameAt: iso(5),
      },
      [declaredTurn(current)],
    );
    expect(result.attention).toBe('human-request');
    expect(kinds(result)).toEqual(['request-open']);
    expect(result.interpretations[0]?.uncertainty).toContain(
      `you wrote to the session at ${iso(5)}, and it asked again`,
    );
  });

  test('a session started from this one after the question and declared completed handles it, with provenance', () => {
    const result = withHarness(
      question,
      { linkedSessions: [linked('local_child', 'spawned-from', 4, 'completed', 3)] },
      [declaredTurn(question), childTurn('local_child', 'completed', 3)],
    );
    expect(result.attention).toBe('none');
    expect(kinds(result)).toEqual(['request-handled-elsewhere']);
    expect(result.interpretations[0]?.evidence).toEqual(['local_root:declared-turn', 'local_child:declared-turn']);
    expect(result.interpretations[0]?.text).toBe(
      `Handled in “Fixture local_child”: started from this session at ${iso(4)}, after the question “Which of the two 320px layouts do you prefer?” (asked ${iso(5)}), and declared completed at ${iso(3)}.`,
    );
  });

  test('a report a session sent after the question, then its completion, is an explicit link that handles it', () => {
    const result = withHarness(question, {
      linkedSessions: [linked('local_reporter', 'side-session-note', 4.5, 'completed', 4)],
    });
    expect(kinds(result)).toEqual(['request-handled-elsewhere']);
    expect(result.interpretations[0]?.text).toContain('reported to this session at');
  });

  test('a child started before the question that finished after it leaves a current confirmed block', () => {
    const result = withHarness(question, {
      linkedSessions: [linked('local_child', 'spawned-from', 8, 'completed', 3)],
    });
    expect(result.attention).toBe('human-request');
    expect(result.reconsidered).toBe(false);
    expect(kinds(result)).toEqual(['request-open']);
  });

  test('work continued after the question without a completion is an older declaration to reconsider', () => {
    const result = withHarness(question, {
      linkedSessions: [
        linked('local_child', 'spawned-from', 4, 'review_ready', 3),
        linked('local_reporter', 'side-session-note', 2, null),
      ],
    });
    expect(result.attention).toBe('human-request');
    expect(result.reconsidered).toBe(true);
    expect(kinds(result)).toEqual(['request-open', 'request-continued-elsewhere']);
    expect(result.interpretations[0]?.uncertainty).toContain('work continued in a linked session after it');
    expect(result.interpretations[1]?.text).toContain('Older declaration to reconsider');
    expect(result.interpretations[1]?.text).toContain('declared review ready at');
    expect(result.interpretations[1]?.text).toContain('no declaration read');
    expect(result.interpretations[1]?.evidence).toEqual([
      'local_child:declared-turn',
      'local_root:note:local_reporter',
    ]);
  });

  test('a message answers the request it followed and no other: the next proposal stays pending', () => {
    const proposals: WorkFact[] = [proposal('p-old', 'open'), proposal('p-new', 'open'), proposal('p-gone', 'open')];
    const result = withHarness(
      question,
      {
        latestUserFrameAt: iso(4),
        openProposals: [
          { createdAt: iso(4.5), expiresAt: iso(-100), factId: 'p-old', title: 'Old offer' },
          { createdAt: iso(3.5), expiresAt: iso(-100), factId: 'p-new', title: 'New offer' },
          { createdAt: iso(200), expiresAt: iso(32), factId: 'p-gone', title: 'Expired offer' },
        ],
      },
      [declaredTurn(question), ...proposals],
    );
    expect(result.attention).toBe('optional-lead');
    expect(kinds(result)).toEqual(['request-answered', 'proposal-open', 'proposal-superseded', 'proposal-expired']);
    const byKind = new Map(result.interpretations.map((entry) => [entry.kind, entry]));
    expect(byKind.get('proposal-open')?.evidence).toEqual(['p-new']);
    expect(byKind.get('proposal-superseded')?.evidence).toEqual(['p-old']);
    expect(byKind.get('proposal-superseded')?.text).toContain('“Old offer”');
    expect(byKind.get('proposal-expired')?.evidence).toEqual(['p-gone']);
  });

  test('without a pending offer left, superseded and expired proposals are no lead', () => {
    const result = withHarness(
      null,
      {
        latestUserFrameAt: iso(4),
        openProposals: [{ createdAt: iso(5), expiresAt: null, factId: 'p-old', title: 'Old offer' }],
      },
      [proposal('p-old', 'open')],
    );
    expect(result.attention).toBe('none');
    expect(kinds(result)).toEqual(['proposal-superseded']);
  });

  test('an unrelated pull request merged after a question resolves nothing (current prudence)', () => {
    const result = withHarness(question, { latestUserFrameAt: iso(5.5) }, [
      declaredTurn(question),
      observedPullRequest('gh:90', { mergedAtHoursAgo: 2, state: 'MERGED', updatedAtHoursAgo: 2 }, 1),
    ]);
    expect(result.attention).toBe('human-request');
    expect(result.reconsidered).toBe(false);
    expect(kinds(result)).toEqual(['request-open']);
  });
});
