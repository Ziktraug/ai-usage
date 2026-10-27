import { describe, expect, test } from 'bun:test';
import {
  BoundedProcessError,
  type BoundedProcessOptions,
  type BoundedProcessResult,
} from '@ai-usage/local-machine/bounded-process';
import { Cause, Effect, Exit } from 'effect';
import { createOpenCodeUsageLimitsBatchSource, OpenCodeQuotaCollectionError } from './opencode-usage-limits';

const REQUEST = {
  machineId: 'machine-1',
  machineLabel: 'Desktop',
  observedAt: new Date('2026-10-27T10:00:00.000Z'),
};

const WORKSPACE_ID = 'wrk_01KH4239QEJW6W1D62XVGV0B';
const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;

/** The response shape `opencode api --standalone experimental.usage.limits` printed on 2.2.0. */
const livePayload = (data: unknown = liveData()) => ({ data, location: { directory: '/tmp' } });

const liveData = () => ({
  budgets: [],
  go: {
    monthly: { limited: false, percent: 26, resetsAt: Date.parse('2026-11-12T08:08:24.000Z') },
    rolling: { limited: false, percent: 0, resetsAt: Date.parse('2026-10-27T14:41:29.174Z') },
    weekly: { limited: false, percent: 29, resetsAt: Date.parse('2026-11-02T00:00:00.000Z') },
  },
  workspace: { id: WORKSPACE_ID, name: 'Personal', usageURL: 'https://opencode.ai/workspace/activity' },
});

const runnerReturning = (result: Partial<BoundedProcessResult>, calls: BoundedProcessOptions[] = []) =>
  createOpenCodeUsageLimitsBatchSource({
    run: (options) => {
      calls.push(options);
      return Effect.succeed({ durationMs: 1, exitCode: 0, stdout: '', ...result });
    },
  });

const collect = (stdout: unknown, calls: BoundedProcessOptions[] = []) =>
  Effect.runPromise(
    runnerReturning({ stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout) }, calls).collect(REQUEST),
  );

const failureOf = async (source: ReturnType<typeof createOpenCodeUsageLimitsBatchSource>) => {
  const exit = await Effect.runPromiseExit(source.collect(REQUEST));
  if (Exit.isSuccess(exit)) {
    throw new Error('Expected the read to fail');
  }
  const error = Cause.squash(exit.cause);
  if (!(error instanceof OpenCodeQuotaCollectionError)) {
    throw new Error('Expected an OpenCode quota collection error');
  }
  return error;
};

describe('OpenCode usage-limits source', () => {
  test('asks the CLI for one standalone read, away from the engine checkout and its environment', async () => {
    const calls: BoundedProcessOptions[] = [];
    await collect(livePayload(), calls);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.command).toBe('opencode');
    expect(call?.args).toEqual(['api', '--standalone', 'experimental.usage.limits']);
    expect(call?.cwd).not.toBe(process.cwd());
    // Only switches are named; no credential or provider variable is handed to the child.
    expect(Object.keys(call?.env ?? {}).sort()).toEqual([
      'NO_COLOR',
      'OPENCODE_DISABLE_AUTOUPDATE',
      'OPENCODE_DISABLE_FILEWATCHER',
      'OPENCODE_DISABLE_MODELS_FETCH',
    ]);
  });

  test('maps the three Go meters into provider windows', async () => {
    const batch = await collect(livePayload());
    expect(batch.hasMore).toBe(false);
    expect(batch.observations).toHaveLength(1);
    const [observation] = batch.observations;
    expect(observation).toMatchObject({
      machineId: 'machine-1',
      machineLabel: 'Desktop',
      observedAt: '2026-10-27T10:00:00.000Z',
      plan: 'go',
      providerKey: 'opencode',
      providerLabel: 'OpenCode',
      source: { confidence: 'authoritative', key: 'opencode-usage-limits', mode: 'poll' },
      state: 'ok',
    });
    expect(observation?.windows).toEqual([
      {
        blocked: false,
        group: '5h',
        id: 'go:rolling',
        label: '5h',
        limitSeconds: null,
        remainingPercent: 100,
        resetsAt: '2026-10-27T14:41:29.174Z',
        scope: 'global',
        usedPercent: 0,
      },
      {
        blocked: false,
        group: 'weekly',
        id: 'go:weekly',
        label: 'Weekly',
        limitSeconds: null,
        remainingPercent: 71,
        resetsAt: '2026-11-02T00:00:00.000Z',
        scope: 'global',
        usedPercent: 29,
      },
      {
        blocked: false,
        group: 'monthly',
        id: 'go:monthly',
        label: 'Monthly',
        limitSeconds: null,
        remainingPercent: 74,
        resetsAt: '2026-11-12T08:08:24.000Z',
        scope: 'global',
        usedPercent: 26,
      },
    ]);
  });

  test('scopes the reading to a digest of the Console workspace, never the id or its name', async () => {
    const batch = await collect(livePayload());
    const [observation] = batch.observations;
    expect(observation?.accountScope).toMatch(FINGERPRINT_PATTERN);
    const serialized = JSON.stringify(batch);
    expect(serialized).not.toContain(WORKSPACE_ID);
    expect(serialized).not.toContain('Personal');
    expect(serialized).not.toContain('usageURL');

    const other = await collect(livePayload({ ...liveData(), workspace: { id: 'wrk_other' } }));
    expect(other.observations[0]?.accountScope).not.toBe(observation?.accountScope);
  });

  test("blocks a window on OpenCode's own limited flag", async () => {
    const data = liveData();
    const batch = await collect(
      livePayload({ ...data, go: { ...data.go, rolling: { ...data.go.rolling, limited: true, percent: 64 } } }),
    );
    const [observation] = batch.observations;
    expect(observation?.state).toBe('partial');
    expect(observation?.windows.find((window) => window.id === 'go:rolling')).toMatchObject({
      blocked: true,
      usedPercent: 64,
    });
  });

  test('keeps Console budgets out of the subscription windows', async () => {
    const batch = await collect(
      livePayload({
        ...liveData(),
        budgets: [{ id: 'rule-1', limit: 50, resetsAt: Date.parse('2026-11-01T00:00:00.000Z'), spent: 49 }],
      }),
    );
    expect(batch.observations[0]?.windows.map((window) => window.id)).toEqual([
      'go:rolling',
      'go:weekly',
      'go:monthly',
    ]);
  });

  test('records a window-less unsupported observation for a workspace without Go', async () => {
    const batch = await collect(livePayload({ budgets: [], workspace: { id: WORKSPACE_ID } }));
    expect(batch.observations[0]).toMatchObject({ plan: null, state: 'unsupported', windows: [] });
  });

  test('drops an amputated meter rather than inventing a zero', async () => {
    const data = liveData();
    const batch = await collect(
      livePayload({ ...data, go: { rolling: {}, weekly: { percent: 'x' }, monthly: data.go.monthly } }),
    );
    expect(batch.observations[0]?.windows.map((window) => window.id)).toEqual(['go:monthly']);
  });

  test('reads a null answer as a location not signed in to the Console', async () => {
    const error = await failureOf(runnerReturning({ stdout: JSON.stringify(livePayload(null)) }));
    expect(error.reason).toBe('auth-required');
  });

  test('reads a CLI older than the route as unsupported, from its one classified stderr fact', async () => {
    const calls: BoundedProcessOptions[] = [];
    const source = createOpenCodeUsageLimitsBatchSource({
      run: (options) => {
        calls.push(options);
        return Effect.succeed({
          durationMs: 1,
          exitCode: 1,
          stderrClass:
            options.classifyStderr?.(
              'UnknownError: ...\n  [cause]: Error: Operation not found: experimental.usage.limits',
            ) ?? null,
          stdout: '',
        });
      },
    });
    const error = await failureOf(source);
    expect(error.reason).toBe('unsupported');
    expect(calls[0]?.classifyStderr?.('Console unavailable')).toBeNull();
  });

  test('reads any other non-zero exit as a protocol failure', async () => {
    const error = await failureOf(runnerReturning({ exitCode: 1, stderrClass: null }));
    expect(error.reason).toBe('protocol');
  });

  test('maps the bounded runner failures', async () => {
    const failing = (kind: BoundedProcessError['kind']) =>
      createOpenCodeUsageLimitsBatchSource({
        run: () => Effect.fail(new BoundedProcessError({ kind, message: kind })),
      });
    expect((await failureOf(failing('unavailable'))).reason).toBe('unsupported');
    expect((await failureOf(failing('timed-out'))).reason).toBe('timeout');
    expect((await failureOf(failing('output-limit'))).reason).toBe('protocol');
  });

  test('rejects output that is not the documented envelope', async () => {
    expect((await failureOf(runnerReturning({ stdout: 'HTTP 503' }))).reason).toBe('malformed-result');
    expect((await failureOf(runnerReturning({ stdout: '{"location":{}}' }))).reason).toBe('malformed-result');
    expect((await failureOf(runnerReturning({ stdout: '{"data":[]}' }))).reason).toBe('malformed-result');
  });

  test('refuses a relative executable path', async () => {
    const source = createOpenCodeUsageLimitsBatchSource({
      command: 'bin/opencode',
      run: () => Effect.die(new Error('must not spawn')),
    });
    expect((await failureOf(source)).reason).toBe('unsupported');
  });
});
