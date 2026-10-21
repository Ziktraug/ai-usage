import { describe, expect, test } from 'bun:test';
import type { ReviewCandidate, ReviewRecommendation } from '@ai-usage/report-core/work-routing';
import type { WorkAttemptsListOutput, WorkAttemptWire } from '@ai-usage/web-contract/work-attempts';
import {
  checkoutOriginLabel,
  formatDurationSeconds,
  launchGate,
  liveAttemptOf,
  reviewAttemptStateLabel,
  shortAttemptId,
} from './work-attempts-model';

const chosen = { harness: 'claude-code', id: 'declared:["m","claude-code","a"]' } as ReviewCandidate;
const real: ReviewRecommendation = { candidateId: chosen.id, kind: 'real', missing: null };
const attempt = (state: WorkAttemptWire['state']): WorkAttemptWire =>
  ({ attemptId: `attempt-${state}`, state }) as WorkAttemptWire;
const list = (
  attempts: WorkAttemptWire[],
  target: Extract<WorkAttemptsListOutput, { ok: true }>['data']['target'],
): WorkAttemptsListOutput => ({
  data: { attempts, generatedAt: '2026-10-22T10:05:00.000Z', skipped: 0, target, truncated: false },
  ok: true,
});
const admitted = {
  admitted: true,
  checkoutOrigin: 'desktop-cwd' as const,
  checkoutPath: '/home/operator/src/ai-usage',
  harness: 'claude',
  sourceSessionId: 's',
};

describe('launch gate', () => {
  test('opens only for a real Claude Code recommendation on an admitted checkout with no live attempt', () => {
    expect(
      launchGate({
        attempts: list([attempt('finished')], admitted),
        attemptsPending: false,
        chosen,
        recommendation: real,
        reviewTargetsDeclared: 1,
      }),
    ).toEqual({ checkoutPath: '/home/operator/src/ai-usage', kind: 'open' });
  });

  test('closes with the engine refusal wording, in the engine order', () => {
    const base = {
      attempts: list([], admitted),
      attemptsPending: false,
      chosen,
      recommendation: real,
      reviewTargetsDeclared: 1,
    };
    expect(
      launchGate({ ...base, recommendation: { ...real, kind: 'conditional', missing: 'quota observation' } }).kind,
    ).toBe('closed');
    expect(launchGate({ ...base, recommendation: null })).toMatchObject({
      reason: expect.stringContaining('real recommendation'),
    });
    expect(
      launchGate({
        ...base,
        chosen: { ...chosen, harness: 'codex' } as ReviewCandidate,
        recommendation: { ...real, candidateId: chosen.id },
      }),
    ).toMatchObject({
      reason: expect.stringContaining('only Claude Code launches a review'),
    });
    expect(launchGate({ ...base, attempts: list([attempt('running')], admitted) })).toMatchObject({
      reason: 'a review is already running (attempt attempt-running); wait for it to end.',
    });
    expect(launchGate({ ...base, attempts: null, attemptsPending: true })).toMatchObject({
      reason: expect.stringContaining('still being read'),
    });
    expect(launchGate({ ...base, attempts: { error: { message: 'x', tag: 'Unavailable' }, ok: false } })).toMatchObject(
      {
        reason: 'review attempts are unavailable (Unavailable).',
      },
    );
    expect(
      launchGate({
        ...base,
        attempts: list([], { ...admitted, admitted: false, checkoutOrigin: null, checkoutPath: null }),
      }),
    ).toMatchObject({
      reason: expect.stringContaining('names no checkout'),
    });
    expect(launchGate({ ...base, attempts: list([], null) })).toMatchObject({
      reason: expect.stringContaining('names no checkout'),
    });
    expect(launchGate({ ...base, reviewTargetsDeclared: 0 })).toMatchObject({
      reason:
        'no checkout is declared for execution; add routing.reviewTargets for /home/operator/src/ai-usage to the home config.',
    });
    expect(launchGate({ ...base, attempts: list([], { ...admitted, admitted: false }) })).toEqual({
      kind: 'closed',
      reason: 'add routing.reviewTargets for /home/operator/src/ai-usage.',
    });
  });

  test('labels states, origins, ids and durations', () => {
    expect(reviewAttemptStateLabel('lost')).toBe('contact lost; verify in the harness');
    expect(reviewAttemptStateLabel('running')).toBe('running');
    expect(checkoutOriginLabel('served-session')).toBe('served session path');
    expect(shortAttemptId('0f2c2b0e-6b1a-4c3e-9f1d-2a7b8c9d0e1f')).toBe('0f2c2b0e');
    expect(formatDurationSeconds(12_345)).toBe('12.3 s');
    expect(formatDurationSeconds(null)).toBeNull();
    expect(liveAttemptOf(list([attempt('finished'), attempt('starting')], null))?.attemptId).toBe('attempt-starting');
    expect(liveAttemptOf(null)).toBeNull();
  });
});
