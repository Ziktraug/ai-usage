import { describe, expect, test } from 'bun:test';
import {
  acceptanceOutcome,
  acceptedLabel,
  cancelOutcome,
  coverageText,
  delegationStateLabel,
  evaluationLine,
  evidenceText,
  executedLabel,
  guaranteeText,
  isEndedDelegationState,
  refusalOrFailureText,
  routeLine,
  SELECTOR_STATEMENT_LABEL,
  scopeLine,
  selectionText,
  truncationText,
  USAGE_SOURCE_LABEL,
  usageLine,
  verifiedLabel,
} from './work-delegations-model';

const QUALIFICATION_ID = '7d3a9b2c-1e4f-4a5b-8c6d-9e0f1a2b3c4d';

describe('Work delegations model', () => {
  test('names states, ended-ness and the three facts in words', () => {
    expect(delegationStateLabel('lost')).toBe('contact lost; verify in the harness');
    expect(delegationStateLabel('abstained')).toBe('abstained (kept with the caller)');
    expect(
      ['finished', 'failed', 'cancelled', 'refused', 'abstained'].map((state) =>
        isEndedDelegationState(state as never),
      ),
    ).toEqual([true, true, true, true, true]);
    expect(['requested', 'starting', 'running', 'lost'].map((state) => isEndedDelegationState(state as never))).toEqual(
      [false, false, false, false],
    );
    expect(executedLabel('unknown')).toBe('unknown (contact lost)');
    expect(verifiedLabel('not-verified')).toBe('not verified');
    expect(verifiedLabel('partially-confirmed')).toBe('partially-confirmed');
    expect(acceptedLabel('pending')).toBe('pending — not recorded by you');
    expect(acceptedLabel('taken-over')).toBe('taken-over');
  });

  test('states the route with the requested and resolved model, and the scope', () => {
    expect(
      routeLine({
        accountScope: 'personal',
        context: 'personal',
        effort: 'high',
        harness: 'claude-code',
        harnessVersion: '2.1.306',
        modelRequested: 'claude-opus-4-1',
        modelResolved: 'unknown',
        poolId: 'p',
        routeId: 'r',
      }),
    ).toBe('Claude Code · personal (personal) · model requested claude-opus-4-1, resolved: unknown · effort high.');
    expect(
      routeLine({
        accountScope: null,
        context: null,
        effort: null,
        harness: 'codex',
        harnessVersion: null,
        modelRequested: null,
        modelResolved: 'gpt-5-codex',
        poolId: 'p',
        routeId: 'r',
      }),
    ).toBe('Codex · unknown account · model requested none, resolved: gpt-5-codex.');
    expect(routeLine(null)).toBe('No route: nothing was launched.');
    expect(scopeLine({ commit: 'HEAD~2', kind: 'commit' })).toBe('commit HEAD~2');
    expect(scopeLine({ base: 'main', head: 'feature/x', kind: 'range' })).toBe('range main..feature/x');
  });

  test('keeps refusal and failure apart and labels the selector statement and the harness usage', () => {
    expect(
      refusalOrFailureText({ failure: null, refusal: { message: 'No route.', reason: 'no-admissible-route' } }),
    ).toBe('Refused (no-admissible-route): No route.');
    expect(refusalOrFailureText({ failure: 'engine restarted', refusal: null })).toBe('Failure: engine restarted');
    expect(refusalOrFailureText({ failure: null, refusal: null })).toBeNull();
    const choice = selectionText({
      confidence: 0.7,
      kind: 'choice',
      qualificationId: QUALIFICATION_ID,
      rationale: ['recommended for correctness'],
      routeId: 'route-a',
      selectorVersion: 'calling-model/claude-code',
    });
    expect(choice).toContain(SELECTOR_STATEMENT_LABEL);
    expect(choice).toContain('rationale: recommended for correctness');
    expect(choice).toContain('confidence 0.7 (self-reported)');
    expect(
      selectionText({
        kind: 'abstain',
        note: 'Too small to delegate.',
        qualificationId: QUALIFICATION_ID,
        reason: 'keep-with-caller',
        selectorVersion: 'calling-model/codex',
      }),
    ).toBe('Abstained (keep-with-caller): Too small to delegate.; selector calling-model/codex.');
    expect(selectionText(null)).toBe('No selection recorded.');
    expect(
      usageLine({ cachedInputTokens: null, inputTokens: 18_000, outputTokens: 1200, source: 'harness-reported' }),
    ).toBe(`Usage ${USAGE_SOURCE_LABEL}: input 18,000 · cached input not reported · output 1,200 tokens.`);
    expect(usageLine(null)).toBe('No usage reported by the harness.');
  });

  test('describes result coverage, evidence, truncation and the guarantee', () => {
    expect(coverageText({ notReviewed: ['b.ts'], reviewed: 'a.ts.' })).toBe('Reviewed: a.ts. Not reviewed: b.ts.');
    expect(coverageText({ notReviewed: [], reviewed: 'everything.' })).toBe(
      'Reviewed: everything. Not reviewed: nothing declared.',
    );
    expect(coverageText(null)).toBe('Coverage: not stated.');
    expect(
      evidenceText([
        { line: 12, path: 'a.ts' },
        { line: null, path: 'b.ts' },
      ]),
    ).toBe('a.ts:12, b.ts');
    expect(evidenceText([])).toBe('no evidence path');
    expect(truncationText({ evaluations: 0, evidence: 0, findings: 0, notReviewed: 0 })).toBeNull();
    expect(truncationText({ evaluations: 0, evidence: 2, findings: 1, notReviewed: 0 })).toContain(
      '1 finding(s), 2 evidence',
    );
    expect(truncationText({ evaluations: 3, evidence: 0, findings: 0, notReviewed: 0 })).toContain(
      '3 evaluation(s) omitted',
    );
    expect(
      guaranteeText({
        cliVersion: '2.1.306',
        controls: ['tools Read Grep Glob', 'safe mode'],
        effort: null,
        harness: 'claude-code',
        limits: [],
        model: null,
      }),
    ).toBe(
      'Ran under Claude Code 2.1.306, model not passed (CLI default). Controls: tools Read Grep Glob; safe mode. Limits: none stated.',
    );
    expect(
      evaluationLine(
        {
          author: 'automated-check',
          authorLabel: 'engine',
          checks: ['output contract satisfied'],
          evaluationId: 'e',
          kind: 'verification',
          note: null,
          recordedAt: '2026-10-25T09:05:01.000Z',
          verdict: 'confirmed',
        },
        'just now',
      ),
    ).toBe('confirmed — by an automated check (engine), just now; checks: output contract satisfied.');
  });

  test('turns the engine answers to cancel and acceptance into one sentence each', () => {
    expect(cancelOutcome({ data: { jobId: 'j', result: 'cancelling', state: 'running' }, ok: true })).toEqual({
      failed: false,
      message: 'Cancellation requested: the engine terminates the worker and records the end.',
    });
    expect(
      cancelOutcome({ data: { jobId: 'j', result: 'not-cancellable-lost', state: 'lost' }, ok: true }).message,
    ).toContain('nothing is signalled');
    expect(cancelOutcome({ error: { message: 'Engine down.', tag: 'EngineUnavailable' }, ok: false })).toEqual({
      failed: true,
      message: 'Not cancelled: Engine down.',
    });
    expect(acceptanceOutcome({ data: { evaluationId: 'abcdefgh-rest' }, ok: true }, 'accepted')).toEqual({
      failed: false,
      message: 'Recorded as accepted by you (evaluation abcdefgh).',
    });
    expect(
      acceptanceOutcome({ error: { message: 'The job is still running.', tag: 'Conflict' }, ok: false }, 'rejected'),
    ).toEqual({
      failed: true,
      message: 'Not recorded: The job is still running.',
    });
  });
});
