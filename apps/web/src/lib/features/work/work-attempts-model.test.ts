import { describe, expect, test } from 'bun:test';
import type { ReviewCandidate, ReviewRecommendation } from '@ai-usage/report-core/work-routing';
import type { WorkAttemptsListOutput, WorkAttemptWire } from '@ai-usage/web-contract/work-attempts';
import {
  checkoutOriginLabel,
  formatDurationSeconds,
  guaranteeSummary,
  launchGate,
  liveAttemptOf,
  reservationNotice,
  reviewAttemptStateLabel,
  scopeSummary,
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

describe('reservation, scope and guarantee texts', () => {
  const scope = {
    base: 'first-parent',
    baseSha: 'c'.repeat(40),
    fileCount: 4,
    files: [
      { additions: 3, coverage: 'complete', deletions: 1, path: 'a.ts', previousPath: null, status: 'modified' },
      { additions: 9, coverage: 'partial', deletions: 0, path: 'b.ts', previousPath: null, status: 'added' },
      { additions: 0, coverage: 'omitted', deletions: 2, path: 'c.ts', previousPath: null, status: 'deleted' },
    ],
    headSha: 'b'.repeat(40),
    includedBytes: 2048,
    includedLines: 60,
    kind: 'commit',
    parentCount: 2,
    patchBytes: 5120,
    patchLines: 140,
    patchSha256: 'd'.repeat(64),
    repositoryPrefix: '',
    subject: 'merge: side',
    truncated: true,
    workingTreeDirty: false,
  } satisfies NonNullable<WorkAttemptWire['scope']>;

  test('a lost attempt that still holds the target keeps the launch, and says what the engine will check', () => {
    const held = { reservation: { held: true, releaseEvidence: null, releasedAt: null }, state: 'lost' } as const;
    expect(reservationNotice(held)).toContain('still reserves this target');
    expect(reservationNotice(held)).toContain('never adopts or stops that process');
    expect(
      reservationNotice({
        reservation: { held: false, releaseEvidence: 'process-absent', releasedAt: '2026-10-22T10:05:00.000Z' },
        state: 'lost',
      }),
    ).toBe('Reservation released: no process on this machine carried its launch marker any more.');
    expect(reservationNotice({ ...held, state: 'finished' })).toBeNull();
    // The button stays: a click is the explicit request for the engine's process check.
    expect(
      launchGate({
        attempts: list([{ ...attempt('lost'), reservation: held.reservation }], admitted),
        attemptsPending: false,
        chosen,
        recommendation: real,
        reviewTargetsDeclared: 1,
      }).kind,
    ).toBe('open');
  });

  test('the scope names one commit, its base, what was cut and the patch hash', () => {
    expect(scopeSummary(scope)).toBe(
      `Reviewed commit bbbbbbbbbbbb "merge: side" against its first parent cccccccccccc (a merge, first parent only), one revision only. Patch partial: 2 KB of 5 KB, 60 of 140 lines; 4 files (1 complete, 1 partial, 1 omitted, 1 not listed); sha256 dddddddddddd.`,
    );
    expect(
      scopeSummary({
        ...scope,
        base: 'empty-tree',
        files: scope.files.slice(0, 1),
        includedBytes: 900,
        includedLines: 1,
        parentCount: 0,
        patchBytes: 900,
        patchLines: 1,
        subject: null,
        truncated: false,
        fileCount: 1,
      }),
    ).toBe(
      'Reviewed commit bbbbbbbbbbbb against the empty tree (a root commit), one revision only. Patch complete: 900 B, 1 line; 1 file (1 complete); sha256 dddddddddddd.',
    );
  });

  test('the guarantee states the excluded sources, the managed policy and the limits of read-only', () => {
    const guarantee = {
      cliVersion: '2.1.306',
      effort: null,
      model: 'opus',
      managedSettings: 'absent',
      safeMode: true,
      settingSources: [],
      tools: ['Read', 'Grep', 'Glob'],
    } satisfies NonNullable<WorkAttemptWire['guarantee']>;
    const text = guaranteeSummary(guarantee);
    expect(text).toContain(
      'Ran under Claude Code 2.1.306: settings loaded none (user, project and local settings, and their hooks, were not loaded)',
    );
    expect(text).toContain('safe mode on; tools Read, Grep, Glob; model opus;');
    expect(guaranteeSummary({ ...guarantee, effort: 'high', model: null })).toContain(
      'model not passed (CLI default), effort high;',
    );
    expect(text).toContain('policy delivered by an organization is not observable here');
    expect(text).toContain('no OS sandbox is claimed');
    expect(guaranteeSummary({ ...guarantee, managedSettings: 'present' })).toContain(
      'cannot be excluded: its hooks, if any, still ran',
    );
  });
});
