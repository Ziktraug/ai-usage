import { describe, expect, test } from 'bun:test';
import { parse } from 'valibot';
import {
  parseWorkAttemptsListOutput,
  parseWorkAttemptsStartOutput,
  type WorkAttemptsListData,
  type WorkAttemptWire,
  workAttemptsContract,
  workAttemptsListInputSchema,
  workAttemptsStartInputSchema,
} from './work-attempts';
import { parseWorkRoutingContext } from './work-routing';

const attempt: WorkAttemptWire = {
  acceptance: 'pending',
  attemptId: '0f2c2b0e-6b1a-4c3e-9f1d-2a7b8c9d0e1f',
  candidateId: 'declared:["machine-a","claude-code","personal"]',
  declared: { accountScope: 'personal', effort: null, model: 'opus' },
  durationMs: 12_000,
  endedAt: '2026-10-22T10:01:00.000Z',
  executorHarness: 'claude-code',
  exitCode: 0,
  failureReason: null,
  machineId: 'machine-a',
  nativeSessionId: 'native-1',
  nativeSessionRowId: 'row-1',
  numTurns: 3,
  requestedAt: '2026-10-22T10:00:00.000Z',
  resultExcerpt: 'Finding 1: src/a.ts:12 (medium)\nA null path reaches the launcher.',
  resultKind: 'review',
  startedAt: '2026-10-22T10:00:01.000Z',
  state: 'finished',
  target: {
    checkoutOrigin: 'desktop-cwd',
    checkoutPath: '/home/operator/src/ai-usage',
    desktopSessionId: 'local_desk',
    harness: 'claude',
    projectLabel: 'ai-usage',
    sessionTitle: 'Investigate checkout 3',
    sourceSessionId: 'session-a',
  },
  updatedAt: '2026-10-22T10:01:00.000Z',
  validations: [],
};

const listData: WorkAttemptsListData = {
  attempts: [attempt],
  generatedAt: '2026-10-22T10:02:00.000Z',
  skipped: 0,
  target: {
    admitted: true,
    checkoutOrigin: 'desktop-cwd',
    checkoutPath: '/home/operator/src/ai-usage',
    harness: 'claude',
    sourceSessionId: 'session-a',
  },
  truncated: false,
};

describe('Work attempts Web contract', () => {
  test('exposes two POST procedures and parses both inputs strictly', () => {
    expect(workAttemptsContract.list['~orpc'].route).toMatchObject({ method: 'POST', path: '/work/attempts' });
    expect(workAttemptsContract.start['~orpc'].route).toMatchObject({ method: 'POST', path: '/work/attempts/start' });
    expect(parse(workAttemptsListInputSchema, {})).toEqual({});
    expect(
      parse(workAttemptsListInputSchema, { limit: 50, target: { harness: 'claude', sourceSessionId: 's' } }),
    ).toEqual({ limit: 50, target: { harness: 'claude', sourceSessionId: 's' } });
    expect(() => parse(workAttemptsListInputSchema, { limit: 51 })).toThrow();
    expect(() => parse(workAttemptsListInputSchema, { machineId: 'x' })).toThrow();
    const start = {
      action: 'read-only-review',
      candidateId: 'c',
      target: { harness: 'claude', sourceSessionId: 's' },
    } as const;
    expect(parse(workAttemptsStartInputSchema, start)).toEqual(start);
    expect(
      parse(workAttemptsStartInputSchema, { ...start, target: { ...start.target, desktopSessionId: null } }),
    ).toMatchObject({
      target: { desktopSessionId: null },
    });
    expect(() => parse(workAttemptsStartInputSchema, { ...start, action: 'write-review' })).toThrow();
    expect(() => parse(workAttemptsStartInputSchema, { ...start, force: true })).toThrow();
  });

  test('accepts the list and start envelopes and refuses drift, oversize excerpts and foreign tags', () => {
    expect(parseWorkAttemptsListOutput({ data: listData, ok: true })).toEqual({ data: listData, ok: true });
    expect(parseWorkAttemptsListOutput({ error: { message: 'Demo.', tag: 'ForbiddenDemo' }, ok: false })).toMatchObject(
      { ok: false },
    );
    expect(() =>
      parseWorkAttemptsListOutput({ data: { ...listData, attempts: [{ ...attempt, pid: 42 }] }, ok: true }),
    ).toThrow();
    expect(() =>
      parseWorkAttemptsListOutput({ data: { ...listData, attempts: [{ ...attempt, idempotencyKey: 'k' }] }, ok: true }),
    ).toThrow();
    expect(() =>
      parseWorkAttemptsListOutput({
        data: { ...listData, attempts: [{ ...attempt, resultExcerpt: 'x'.repeat(4001) }] },
        ok: true,
      }),
    ).toThrow();
    expect(() =>
      parseWorkAttemptsListOutput({ data: { ...listData, attempts: [{ ...attempt, state: 'done' }] }, ok: true }),
    ).toThrow();
    expect(() => parseWorkAttemptsListOutput({ error: { message: 'x', tag: 'Refused' }, ok: false })).toThrow();

    expect(
      parseWorkAttemptsStartOutput({ data: { attemptId: 'a', reused: true, state: 'running' }, ok: true }),
    ).toEqual({
      data: { attemptId: 'a', reused: true, state: 'running' },
      ok: true,
    });
    expect(
      parseWorkAttemptsStartOutput({
        error: { message: 'add routing.reviewTargets for /x', reason: 'target-not-allowed', tag: 'Refused' },
        ok: false,
      }),
    ).toMatchObject({ error: { reason: 'target-not-allowed' }, ok: false });
    expect(() =>
      parseWorkAttemptsStartOutput({ error: { message: 'x', reason: 'because', tag: 'Refused' }, ok: false }),
    ).toThrow();
    expect(() =>
      parseWorkAttemptsStartOutput({ error: { message: 'x', tag: 'IncompatibleStore' }, ok: false }),
    ).toThrow();
  });

  test('the routing context carries the declared review targets as optional bounded fields', () => {
    const context = {
      configPath: null,
      declarationErrors: [],
      declarations: [],
      executorObservations: [],
      generatedAt: '2026-10-22T10:02:00.000Z',
      machineId: null,
    };
    expect(parseWorkRoutingContext(context)).toEqual(context);
    const withTargets = {
      ...context,
      reviewTargetErrors: ['routing.reviewTargets[1].checkoutPath: must be an absolute path'],
      reviewTargets: [{ checkoutPath: '/home/operator/src', label: null }],
    };
    expect(parseWorkRoutingContext(withTargets)).toEqual(withTargets);
    expect(() => parseWorkRoutingContext({ ...context, reviewTargets: [{ checkoutPath: '' }] })).toThrow();
    expect(() => parseWorkRoutingContext({ ...context, reviewTargets: [{ checkoutPath: '/x', secret: 1 }] })).toThrow();
  });
});
