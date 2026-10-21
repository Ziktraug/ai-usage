import { describe, expect, test } from 'bun:test';
import type { WorkAttemptsListOutput, WorkAttemptWire } from '@ai-usage/web-contract/work-attempts';
import { createWebQueryClient } from '../client';
import {
  WORK_ATTEMPTS_LIST_LIMIT,
  WORK_ATTEMPTS_LIVE_REFETCH_MS,
  workAttemptsHaveLive,
  workAttemptsQueryOptions,
} from './work-attempts';

const attempt = (state: WorkAttemptWire['state']): WorkAttemptWire => ({
  acceptance: 'pending',
  attemptId: `attempt-${state}`,
  candidateId: 'declared:["m","claude-code","a"]',
  declared: null,
  durationMs: null,
  endedAt: null,
  executorHarness: 'claude-code',
  exitCode: null,
  failureReason: null,
  machineId: 'm',
  nativeSessionId: null,
  nativeSessionRowId: null,
  numTurns: null,
  requestedAt: '2026-10-22T10:00:00.000Z',
  resultExcerpt: null,
  resultKind: null,
  startedAt: null,
  state,
  target: {
    checkoutOrigin: null,
    checkoutPath: null,
    desktopSessionId: null,
    harness: 'claude',
    projectLabel: null,
    sessionTitle: null,
    sourceSessionId: 's',
  },
  updatedAt: '2026-10-22T10:00:00.000Z',
  validations: [],
});

const output = (states: readonly WorkAttemptWire['state'][]): WorkAttemptsListOutput => ({
  data: {
    attempts: states.map(attempt),
    generatedAt: '2026-10-22T10:05:00.000Z',
    skipped: 0,
    target: null,
    truncated: false,
  },
  ok: true,
});

describe('Work attempts Query options', () => {
  test('uses one finite-swr identity per target, forwards cancellation and polls only while an attempt is live', async () => {
    const observedSignals: AbortSignal[] = [];
    const inputs: unknown[] = [];
    const client = createWebQueryClient();
    const options = workAttemptsQueryOptions(
      {
        list: (input, { signal } = {}) => {
          inputs.push(input);
          if (signal) {
            observedSignals.push(signal);
          }
          return Promise.resolve(output(['running']));
        },
      },
      { harness: 'claude', sourceSessionId: 's' },
      { browser: true, enabled: true },
    );
    await expect(client.fetchQuery(options)).resolves.toEqual(output(['running']));
    expect(inputs).toEqual([{ limit: WORK_ATTEMPTS_LIST_LIMIT, target: { harness: 'claude', sourceSessionId: 's' } }]);
    expect(observedSignals).toHaveLength(1);
    expect(options).toMatchObject({
      enabled: true,
      queryKey: ['web', 'finite-swr', 'work-attempts', 'list', 'claude', 's'],
      refetchOnMount: true,
      retry: false,
    });
    const interval = options.refetchInterval;
    if (typeof interval !== 'function') {
      throw new Error('refetchInterval must be computed from the data');
    }
    const query = client.getQueryCache().find({ queryKey: options.queryKey });
    if (!query) {
      throw new Error('query must exist after fetch');
    }
    expect(interval(query as never)).toBe(WORK_ATTEMPTS_LIVE_REFETCH_MS);
    expect(workAttemptsHaveLive(output(['finished', 'lost']))).toBe(false);
    expect(workAttemptsHaveLive(output(['finished', 'requested']))).toBe(true);
    expect(workAttemptsHaveLive({ error: { message: 'x', tag: 'Unavailable' }, ok: false })).toBe(false);
    expect(workAttemptsHaveLive(undefined)).toBe(false);
    expect(
      workAttemptsQueryOptions(
        { list: () => Promise.resolve(output([])) },
        { harness: 'claude', sourceSessionId: 's' },
        { browser: false, enabled: true },
      ).enabled,
    ).toBe(false);
  });
});
