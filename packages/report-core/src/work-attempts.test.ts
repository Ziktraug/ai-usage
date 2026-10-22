import { describe, expect, test } from 'bun:test';
import type { ProviderStatus } from './provider-status';
import {
  boundReviewExcerpt,
  buildReviewPrompt,
  decideReviewLaunch,
  isCheckoutPathAdmitted,
  isLiveReviewAttemptState,
  normalizeCheckoutPath,
  parseClaudeStreamJsonLine,
  parseReviewAttempt,
  parseReviewTargetDeclarations,
  REVIEW_ATTEMPT_BOUNDS,
  type ReviewAttempt,
  type ReviewLaunchDecisionInput,
  resolveReviewCheckoutPath,
  reviewAttemptIdempotencyKey,
  reviewAttemptIdentity,
} from './work-attempts';
import type { ExecutorDeclaration, ExecutorObservation } from './work-executors';
import type { ReviewTarget } from './work-routing';

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const NOW = '2026-10-22T10:00:00.000Z';
const RECENT = '2026-10-22T09:58:00.000Z';
const MACHINE = 'machine-a';
const TARGET: ReviewTarget = {
  harness: 'claude',
  kind: 'session',
  machineId: MACHINE,
  projectLabel: 'ai-usage',
  sourceSessionId: 'session-a',
};
const declaration: ExecutorDeclaration = {
  accountScope: 'personal',
  authorization: 'allowed',
  capabilities: ['read-only-review'],
  declaredAt: '2026-10-21T08:00:00.000Z',
  effort: null,
  harness: 'claude-code',
  machineId: MACHINE,
  model: null,
  quality: 'review-capable',
  subscription: 'verified',
  targets: [{ kind: 'any-local-session' }],
};
const CANDIDATE_ID = `declared:${JSON.stringify([MACHINE, 'claude-code', 'personal'])}`;
const observation: ExecutorObservation = {
  authEvidence: 'claude auth status exit 0 loggedIn=true',
  authMethod: null,
  authState: 'logged-in',
  binaryPath: '/usr/bin/claude',
  harness: 'claude-code',
  machineId: MACHINE,
  observedAt: RECENT,
  outcome: 'observed',
  version: '2.1.306 (Claude Code)',
};
const quota: ProviderStatus = {
  generatedAt: RECENT,
  key: 'claude',
  label: 'Claude',
  machineId: MACHINE,
  machineLabel: 'Machine A',
  plan: 'max',
  source: 'live-api',
  state: 'ok',
  windows: [
    {
      blocked: false,
      group: '5h',
      id: 'five_hour',
      label: '5h',
      limitSeconds: 18_000,
      remainingPercent: 60,
      resetsAt: '2026-10-22T13:00:00.000Z',
      scope: 'global',
      usedPercent: 40,
    },
  ],
};
const allowedInput: ReviewLaunchDecisionInput = {
  candidateId: CANDIDATE_ID,
  checkout: { checkoutPath: '/home/op/src/ai-usage', origin: 'desktop-cwd' },
  declarations: [declaration],
  executorObservations: [observation],
  now: NOW,
  otherLiveAttempt: null,
  providers: [quota],
  reviewTargets: [{ checkoutPath: '/home/op/src', label: null }],
  target: TARGET,
};

const attempt: ReviewAttempt = {
  acceptance: 'pending',
  action: 'read-only-review',
  attemptId: '0f2c2b0e-6b1a-4c3e-9f1d-2a7b8c9d0e1f',
  candidateId: CANDIDATE_ID,
  declaration,
  durationMs: 12_345,
  endedAt: '2026-10-22T10:01:00.000Z',
  executorHarness: 'claude-code',
  exitCode: 0,
  failureReason: null,
  idempotencyKey: 'a'.repeat(64),
  machineId: MACHINE,
  nativeSessionId: 'native-1',
  numTurns: 3,
  pid: 4242,
  requestedAt: NOW,
  resultExcerpt: 'Finding 1: src/a.ts:12 (medium)\n\tA null path reaches the launcher.',
  resultKind: 'review',
  startedAt: '2026-10-22T10:00:01.000Z',
  state: 'finished',
  target: {
    checkoutOrigin: 'desktop-cwd',
    checkoutPath: '/home/op/src/ai-usage',
    desktopSessionId: 'local_desk',
    harness: 'claude',
    projectLabel: 'ai-usage',
    sessionTitle: 'Investigate checkout 3',
    sourceSessionId: 'session-a',
  },
  updatedAt: '2026-10-22T10:01:00.000Z',
  validations: [],
};

describe('review target declarations', () => {
  test('parses absolute checkouts, normalizes slashes and locates each refused entry without echoing it', () => {
    const parsed = parseReviewTargetDeclarations(
      [
        { checkoutPath: '/home/op/src//ai-usage/', label: 'main' },
        { checkoutPath: 'relative/path' },
        { checkoutPath: '/home/op/../root' },
        { checkoutPath: '/home/op/src/ai-usage', label: 'duplicate' },
        { checkoutPath: '/tmp/x', label: '' },
        { checkoutPath: '/tmp/y', other: true },
        'nope',
      ],
      { path: 'home.routing.reviewTargets' },
    );
    expect(parsed.targets).toEqual([{ checkoutPath: '/home/op/src/ai-usage', label: 'main' }]);
    expect(parsed.issues.map((issue) => issue.path)).toEqual([
      'home.routing.reviewTargets[1].checkoutPath',
      'home.routing.reviewTargets[2].checkoutPath',
      'home.routing.reviewTargets[3]',
      'home.routing.reviewTargets[4].label',
      'home.routing.reviewTargets[5]',
      'home.routing.reviewTargets[6]',
    ]);
    expect(JSON.stringify(parsed.issues)).not.toContain('relative/path');
    expect(parseReviewTargetDeclarations(undefined)).toEqual({ issues: [], targets: [] });
    expect(parseReviewTargetDeclarations({ checkoutPath: '/x' }).issues).toHaveLength(1);
  });

  test('admits the declared checkout and its descendants only', () => {
    const targets = [{ checkoutPath: '/home/op/src/ai-usage', label: null }];
    expect(isCheckoutPathAdmitted('/home/op/src/ai-usage', targets)).toBe(true);
    expect(isCheckoutPathAdmitted('/home/op/src/ai-usage/', targets)).toBe(true);
    expect(isCheckoutPathAdmitted('/home/op/src/ai-usage/.claude/worktrees/x', targets)).toBe(true);
    expect(isCheckoutPathAdmitted('/home/op/src/ai-usage-other', targets)).toBe(false);
    expect(isCheckoutPathAdmitted('/home/op/src', targets)).toBe(false);
    expect(isCheckoutPathAdmitted('/home/op/src/ai-usage/../secret', targets)).toBe(false);
    expect(isCheckoutPathAdmitted('ai-usage', targets)).toBe(false);
    expect(isCheckoutPathAdmitted('/anything', [{ checkoutPath: '/', label: null }])).toBe(true);
    expect(normalizeCheckoutPath('/a/./b')).toBeNull();
    expect(normalizeCheckoutPath('/a/b/')).toBe('/a/b');
  });

  test('resolves the checkout from the Desktop worktree, then its cwd, then the served session path', () => {
    expect(
      resolveReviewCheckoutPath({
        desktop: { cwd: '/repo', worktreePath: '/repo/.claude/worktrees/w' },
        session: null,
      }),
    ).toEqual({ checkoutPath: '/repo/.claude/worktrees/w', origin: 'desktop-worktree' });
    expect(
      resolveReviewCheckoutPath({ desktop: { cwd: '/repo/', worktreePath: null }, session: { sourcePath: '/other' } }),
    ).toEqual({ checkoutPath: '/repo', origin: 'desktop-cwd' });
    expect(resolveReviewCheckoutPath({ desktop: null, session: { sourcePath: '/served' } })).toEqual({
      checkoutPath: '/served',
      origin: 'served-session',
    });
    expect(resolveReviewCheckoutPath({ desktop: { cwd: 'relative', worktreePath: null }, session: null })).toBeNull();
    expect(resolveReviewCheckoutPath({ desktop: null, session: { sourcePath: null } })).toBeNull();
  });
});

describe('review attempt identity', () => {
  test('hashes machine, action, harness, session and checkout in that order, stably', async () => {
    const parts = {
      action: 'read-only-review' as const,
      checkoutPath: '/repo',
      harness: 'claude',
      machineId: MACHINE,
      sourceSessionId: 'session-a',
    };
    expect(reviewAttemptIdentity(parts)).toBe('machine-a|read-only-review|claude|session-a|/repo');
    const key = await reviewAttemptIdempotencyKey(parts);
    expect(key).toMatch(SHA256_HEX);
    expect(await reviewAttemptIdempotencyKey(parts)).toBe(key);
    expect(await reviewAttemptIdempotencyKey({ ...parts, checkoutPath: '/repo2' })).not.toBe(key);
    expect(await reviewAttemptIdempotencyKey({ ...parts, checkoutPath: null })).not.toBe(key);
    expect(isLiveReviewAttemptState('running')).toBe(true);
    expect(isLiveReviewAttemptState('lost')).toBe(false);
  });
});

describe('launch decision', () => {
  test('allows a declared, admitted, available candidate with a real recommendation', () => {
    const decision = decideReviewLaunch(allowedInput);
    expect(decision.kind).toBe('allowed');
    if (decision.kind === 'allowed') {
      expect(decision.candidate.id).toBe(CANDIDATE_ID);
      expect(decision.declaration).toEqual(declaration);
      expect(decision.checkout.checkoutPath).toBe('/home/op/src/ai-usage');
    }
  });

  test('refuses another live attempt on the target before anything else', () => {
    const decision = decideReviewLaunch({ ...allowedInput, otherLiveAttempt: { attemptId: 'attempt-1' } });
    expect(decision).toMatchObject({ kind: 'refused', reason: 'attempt-already-live' });
    expect(decision.kind === 'refused' && decision.message).toContain('attempt-1');
  });

  test('refuses without a declaration, for an observed-only candidate and for a foreign candidate id', () => {
    expect(decideReviewLaunch({ ...allowedInput, declarations: [] })).toMatchObject({
      kind: 'refused',
      reason: 'no-declaration',
    });
    const observedOnly = decideReviewLaunch({
      ...allowedInput,
      candidateId: `observed:${JSON.stringify([MACHINE, 'claude', null])}`,
      declarations: [{ ...declaration, harness: 'codex', accountScope: 'other' }],
    });
    expect(observedOnly).toMatchObject({ kind: 'refused', reason: 'no-declaration' });
    expect(
      decideReviewLaunch({ ...allowedInput, candidateId: 'declared:["elsewhere","claude-code","x"]' }),
    ).toMatchObject({ kind: 'refused', reason: 'no-declaration' });
  });

  test('refuses Codex as an executor for this version', () => {
    const codex: ExecutorDeclaration = { ...declaration, harness: 'codex' };
    const decision = decideReviewLaunch({
      ...allowedInput,
      candidateId: `declared:${JSON.stringify([MACHINE, 'codex', 'personal'])}`,
      declarations: [codex],
      executorObservations: [{ ...observation, harness: 'codex' }],
      providers: [{ ...quota, key: 'codex', label: 'Codex' }],
    });
    expect(decision).toMatchObject({ kind: 'refused', reason: 'harness-unsupported' });
  });

  test('refuses a target outside routing.reviewTargets and names the path to add', () => {
    const outside = decideReviewLaunch({
      ...allowedInput,
      reviewTargets: [{ checkoutPath: '/elsewhere', label: null }],
    });
    expect(outside).toMatchObject({
      kind: 'refused',
      message: 'add routing.reviewTargets for /home/op/src/ai-usage',
      reason: 'target-not-allowed',
    });
    expect(decideReviewLaunch({ ...allowedInput, checkout: null })).toMatchObject({
      kind: 'refused',
      reason: 'target-not-allowed',
    });
  });

  test('refuses an executor that is not observed available, with the qualification actions', () => {
    const loggedOut = decideReviewLaunch({
      ...allowedInput,
      executorObservations: [
        { ...observation, authState: 'logged-out', authEvidence: 'claude auth status exit 0 loggedIn=false' },
      ],
    });
    expect(loggedOut).toMatchObject({ kind: 'refused', reason: 'executor-unavailable' });
    expect(loggedOut.kind === 'refused' && loggedOut.missing.join(' ')).toContain('claude auth login');
    const stale = decideReviewLaunch({
      ...allowedInput,
      executorObservations: [{ ...observation, observedAt: '2026-10-22T08:00:00.000Z' }],
    });
    expect(stale).toMatchObject({ kind: 'refused', reason: 'executor-unavailable' });
  });

  test('refuses a conditional or absent recommendation and names the missing fact', () => {
    const staleQuota = decideReviewLaunch({
      ...allowedInput,
      providers: [{ ...quota, generatedAt: '2026-10-22T09:00:00.000Z' }],
    });
    expect(staleQuota).toMatchObject({ kind: 'refused', reason: 'recommendation-not-real' });
    expect(staleQuota.kind === 'refused' && staleQuota.missing.join(' ')).toContain('quota observation');
    const noQuota = decideReviewLaunch({ ...allowedInput, providers: [] });
    expect(noQuota).toMatchObject({ kind: 'refused', reason: 'recommendation-not-real' });
    expect(noQuota.kind === 'refused' && noQuota.message).toContain('conditional');
    const exhausted = decideReviewLaunch({
      ...allowedInput,
      providers: [
        { ...quota, windows: [{ ...quota.windows[0]!, blocked: true, usedPercent: 100, remainingPercent: 0 }] },
      ],
    });
    expect(exhausted).toMatchObject({ kind: 'refused', reason: 'recommendation-not-real' });
  });
});

describe('prompt and stream-json reading', () => {
  test('builds a bounded generic prompt and says when git could not answer', () => {
    const prompt = buildReviewPrompt({ gitDiffStat: null, gitLog: 'abc1234 fix: thing', sessionTitle: 'Title' });
    expect(prompt).toContain('Do not modify files.');
    expect(prompt).toContain('Target session: Title');
    expect(prompt).toContain('Latest commit (git log -1): abc1234 fix: thing');
    expect(prompt).toContain('Changed files (git diff --stat HEAD~1..HEAD):\nunavailable');
    const long = buildReviewPrompt({ gitDiffStat: 'x'.repeat(10_000), gitLog: null, sessionTitle: null });
    expect(long.length).toBeLessThan(REVIEW_ATTEMPT_BOUNDS.maxPromptContext + 400);
    expect(long).toContain('[truncated]');
  });

  test('reads only init and result lines', () => {
    expect(parseClaudeStreamJsonLine('{"type":"system","subtype":"init","session_id":"s-1","tools":["Read"]}')).toEqual(
      { kind: 'init', sessionId: 's-1' },
    );
    expect(parseClaudeStreamJsonLine('{"type":"assistant","message":{"content":[]}}')).toBeNull();
    expect(parseClaudeStreamJsonLine('not json')).toBeNull();
    expect(parseClaudeStreamJsonLine('')).toBeNull();
    expect(
      parseClaudeStreamJsonLine(
        '{"type":"result","subtype":"success","is_error":false,"num_turns":4,"duration_ms":8123,"result":"Findings...","session_id":"s-1"}',
      ),
    ).toEqual({
      durationMs: 8123,
      isError: false,
      kind: 'result',
      numTurns: 4,
      sessionId: 's-1',
      subtype: 'success',
      text: 'Findings...',
    });
    expect(parseClaudeStreamJsonLine('{"type":"result","subtype":"error_max_turns","is_error":true}')).toMatchObject({
      isError: true,
      kind: 'result',
      numTurns: null,
      text: null,
    });
  });

  test('bounds the excerpt and strips control characters', () => {
    expect(boundReviewExcerpt(null)).toBeNull();
    expect(boundReviewExcerpt('\u0007 \u0000')).toBeNull();
    expect(boundReviewExcerpt('a\u001bb\nc')).toBe('ab\nc');
    const bounded = boundReviewExcerpt('x'.repeat(5000));
    expect(bounded?.length).toBeLessThanOrEqual(REVIEW_ATTEMPT_BOUNDS.maxExcerpt);
    expect(bounded?.endsWith('[truncated]')).toBe(true);
  });
});

describe('attempt re-validation', () => {
  test('accepts a complete record, including a multi-line excerpt, and refuses drift', () => {
    expect(parseReviewAttempt(attempt)).toEqual(attempt);
    expect(parseReviewAttempt({ ...attempt, state: 'done' })).toBeNull();
    expect(parseReviewAttempt({ ...attempt, extra: true })).toBeNull();
    expect(
      parseReviewAttempt({ ...attempt, resultExcerpt: 'x'.repeat(REVIEW_ATTEMPT_BOUNDS.maxExcerpt + 1) }),
    ).toBeNull();
    expect(parseReviewAttempt({ ...attempt, resultExcerpt: 'bad\u0007' })).toBeNull();
    expect(parseReviewAttempt({ ...attempt, requestedAt: 'yesterday' })).toBeNull();
    expect(parseReviewAttempt({ ...attempt, validations: ['ran tests'] })?.validations).toEqual(['ran tests']);
    expect(parseReviewAttempt({ ...attempt, target: { ...attempt.target, checkoutPath: null } })).toBeNull();
    expect(
      parseReviewAttempt({ ...attempt, target: { ...attempt.target, checkoutOrigin: null, checkoutPath: null } }),
    ).not.toBeNull();
    expect(parseReviewAttempt({ ...attempt, declaration: null, exitCode: -1 })?.exitCode).toBe(-1);
  });
});
