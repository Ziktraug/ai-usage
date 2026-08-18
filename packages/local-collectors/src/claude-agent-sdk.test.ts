import { describe, expect, test } from 'bun:test';
import { Effect, Exit } from 'effect';
import { type ClaudeUsageQuery, createClaudeAgentSdkBatchSource } from './claude-agent-sdk';

const REQUEST = {
  machineId: 'machine-1',
  machineLabel: 'Desktop',
  observedAt: new Date('2026-08-08T12:00:00.000Z'),
};

const livePayload = () => ({
  rate_limits: {
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    five_hour: { resets_at: '2026-08-08T16:20:00.000Z', utilization: 67 },
    limits: [
      {
        group: 'session',
        is_active: false,
        kind: 'session',
        percent: 67,
        resets_at: '2026-08-08T16:20:00.000Z',
        scope: null,
        severity: 'normal',
      },
      {
        group: 'weekly',
        is_active: true,
        kind: 'weekly_all',
        percent: 71,
        resets_at: '2026-08-10T05:00:00.000Z',
        scope: null,
        severity: 'normal',
      },
    ],
    seven_day: { resets_at: '2026-08-10T05:00:00.000Z', utilization: 71 },
  },
  rate_limits_available: true,
  subscription_type: 'team',
});

const sourceReturning = (result: unknown, onInterrupt?: () => void) =>
  createClaudeAgentSdkBatchSource({
    openQuery: () =>
      Promise.resolve({
        interrupt: () => {
          onInterrupt?.();
          return Promise.resolve(undefined);
        },
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise.resolve(result),
      } satisfies ClaudeUsageQuery),
  });

const collect = async (result: unknown, onInterrupt?: () => void) =>
  await Effect.runPromise(sourceReturning(result, onInterrupt).collect(REQUEST));

describe('Claude Agent SDK quota source', () => {
  test('maps the limits array into provider windows', async () => {
    const batch = await collect(livePayload());
    const [observation] = batch.observations;

    expect(observation?.providerKey).toBe('claude');
    expect(observation?.plan).toBe('team');
    expect(observation?.state).toBe('ok');
    expect(observation?.source).toEqual({ confidence: 'authoritative', key: 'claude-agent-sdk', mode: 'poll' });
    expect(observation?.windows).toEqual([
      {
        blocked: false,
        group: '5h',
        id: 'session',
        label: '5h',
        limitSeconds: null,
        remainingPercent: 33,
        resetsAt: '2026-08-08T16:20:00.000Z',
        scope: 'global',
        usedPercent: 67,
      },
      {
        blocked: false,
        group: 'weekly',
        id: 'weekly_all',
        label: 'Weekly',
        limitSeconds: null,
        remainingPercent: 29,
        resetsAt: '2026-08-10T05:00:00.000Z',
        scope: 'global',
        usedPercent: 71,
      },
    ]);
  });

  test('never invents a window duration', async () => {
    const batch = await collect(livePayload());

    expect(batch.observations[0]?.windows.every((window) => window.limitSeconds === null)).toBe(true);
  });

  test('falls back to the named members when limits[] is absent', async () => {
    const payload = livePayload();
    const { limits: _dropped, ...rateLimits } = payload.rate_limits;
    const batch = await collect({ ...payload, rate_limits: rateLimits });

    expect(batch.observations[0]?.windows.map((window) => window.id)).toEqual(['session', 'weekly_all']);
    expect(batch.observations[0]?.windows[0]?.usedPercent).toBe(67);
  });

  test('records an observation with no windows when plan limits do not apply', async () => {
    const batch = await collect({ rate_limits: null, rate_limits_available: false, subscription_type: null });
    const [observation] = batch.observations;

    expect(observation?.state).toBe('unsupported');
    expect(observation?.windows).toEqual([]);
    expect(observation?.plan).toBeNull();
  });

  test('blocks a window only once it is exhausted, not when severity merely rises', async () => {
    const warned = livePayload();
    // The live API reports `warning` from around 75%. Treating that as blocked would paint the ring
    // critical while three quarters of the allowance is still spendable.
    warned.rate_limits.limits[1] = { ...warned.rate_limits.limits[1], percent: 75, severity: 'warning' } as never;
    const warnedBatch = await collect(warned);

    expect(warnedBatch.observations[0]?.windows[1]?.blocked).toBe(false);
    expect(warnedBatch.observations[0]?.state).toBe('ok');

    const exhausted = livePayload();
    exhausted.rate_limits.limits[1] = { ...exhausted.rate_limits.limits[1], percent: 100 } as never;
    const exhaustedBatch = await collect(exhausted);

    expect(exhaustedBatch.observations[0]?.windows[1]?.blocked).toBe(true);
    expect(exhaustedBatch.observations[0]?.state).toBe('partial');
  });

  test('adds per-model weekly windows without displacing the global ones', async () => {
    const payload = livePayload();
    const withModels = {
      ...payload,
      rate_limits: {
        ...payload.rate_limits,
        model_scoped: [{ display_name: 'Fable', resets_at: '2026-08-10T05:00:00.000Z', utilization: 12 }],
      },
    };
    const batch = await collect(withModels);
    const modelWindow = batch.observations[0]?.windows.find((window) => window.scope === 'model');

    expect(batch.observations[0]?.windows).toHaveLength(3);
    expect(modelWindow).toMatchObject({ id: 'model:Fable', label: 'Fable · Weekly', usedPercent: 12 });
  });

  test('tolerates an amputated payload rather than throwing', async () => {
    const batch = await collect({
      rate_limits: { limits: [{ kind: 'session', percent: null, resets_at: '2026-08-08T16:20:00.000Z' }] },
      rate_limits_available: true,
    });
    const [window] = batch.observations[0]?.windows ?? [];

    // A missing percentage stays null; coercing it to zero would read as "nothing used".
    expect(window?.usedPercent).toBeNull();
    expect(window?.remainingPercent).toBeNull();
    expect(batch.observations[0]?.state).toBe('ok');
  });

  test('releases the session even when the usage read fails', async () => {
    let interrupted = false;
    const source = createClaudeAgentSdkBatchSource({
      openQuery: () =>
        Promise.resolve({
          interrupt: () => {
            interrupted = true;
            return Promise.resolve(undefined);
          },
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise.reject(new Error('boom')),
        } satisfies ClaudeUsageQuery),
    });
    const exit = await Effect.runPromiseExit(source.collect(REQUEST));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(interrupted).toBe(true);
  });

  test('closes the session, not just the turn, so the host process can exit', async () => {
    // `interrupt` ends the current turn and leaves the session's handles open; only closing the
    // generator disposes it. Interrupting alone left the usage engine alive after it had already
    // succeeded, and the CLI reported the command as cancelled once its deadline passed.
    const calls: string[] = [];
    const source = createClaudeAgentSdkBatchSource({
      openQuery: () =>
        Promise.resolve({
          interrupt: () => {
            calls.push('interrupt');
            return Promise.resolve(undefined);
          },
          return: () => {
            calls.push('return');
            return Promise.resolve(undefined);
          },
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise.resolve(livePayload()),
        } satisfies ClaudeUsageQuery),
    });
    await Effect.runPromise(source.collect(REQUEST));

    expect(calls).toEqual(['interrupt', 'return']);
  });

  test('survives an SDK build that exposes no session disposal', async () => {
    // Both teardown calls are optional on the interface: the surface is undocumented, so an older or
    // newer build missing either one must degrade to a normal reading rather than throwing.
    const source = createClaudeAgentSdkBatchSource({
      openQuery: () =>
        Promise.resolve({
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise.resolve(livePayload()),
        } satisfies ClaudeUsageQuery),
    });
    const batch = await Effect.runPromise(source.collect(REQUEST));

    expect(batch.observations).toHaveLength(1);
  });

  test('degrades a structurally incompatible payload to unsupported', async () => {
    const batch = await collect('nope');

    expect(batch.observations).toHaveLength(1);
    expect(batch.observations[0]).toMatchObject({ providerKey: 'claude', state: 'unsupported', windows: [] });
  });

  test('refuses to open a session once the request is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let opened = false;
    const source = createClaudeAgentSdkBatchSource({
      openQuery: () => {
        opened = true;
        return Promise.reject(new Error('should not open'));
      },
    });
    const exit = await Effect.runPromiseExit(source.collect({ ...REQUEST, signal: controller.signal }));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(opened).toBe(false);
  });

  test('aborts an in-flight read and fully closes its session', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    let markOpened = (): void => undefined;
    const opened = new Promise<void>((resolve) => {
      markOpened = resolve;
    });
    const source = createClaudeAgentSdkBatchSource({
      openQuery: () => {
        markOpened();
        return Promise.resolve({
          interrupt: () => {
            calls.push('interrupt');
            return Promise.resolve(undefined);
          },
          return: () => {
            calls.push('return');
            return Promise.resolve(undefined);
          },
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise<never>(() => undefined),
        } satisfies ClaudeUsageQuery);
      },
      timeoutMs: 1000,
    });
    const pendingExit = Effect.runPromiseExit(source.collect({ ...REQUEST, signal: controller.signal }));
    await opened;

    controller.abort();
    const exit = await pendingExit;

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain('aborted');
    expect(calls).toEqual(['interrupt', 'return']);
  });

  test('closes a session that opens only after the read timeout', async () => {
    const calls: string[] = [];
    let resolveSession = (_session: ClaudeUsageQuery): void => undefined;
    const pendingSession = new Promise<ClaudeUsageQuery>((resolve) => {
      resolveSession = resolve;
    });
    const source = createClaudeAgentSdkBatchSource({ openQuery: () => pendingSession, timeoutMs: 5 });

    const exit = await Effect.runPromiseExit(source.collect(REQUEST));
    resolveSession({
      interrupt: () => {
        calls.push('interrupt');
        return Promise.resolve(undefined);
      },
      return: () => {
        calls.push('return');
        return Promise.resolve(undefined);
      },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => {
        calls.push('usage');
        return Promise.resolve(livePayload());
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain('timeout');
    expect(calls).toEqual(['interrupt', 'return']);
  });

  test('bounds every teardown call and still attempts full disposal', async () => {
    const calls: string[] = [];
    const source = createClaudeAgentSdkBatchSource({
      openQuery: () =>
        Promise.resolve({
          interrupt: () => {
            calls.push('interrupt');
            return new Promise<never>(() => undefined);
          },
          return: () => {
            calls.push('return');
            return new Promise<never>(() => undefined);
          },
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise.resolve(livePayload()),
        } satisfies ClaudeUsageQuery),
      timeoutMs: 5,
    });
    const startedAt = performance.now();

    const batch = await Effect.runPromise(source.collect(REQUEST));

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(batch.observations).toHaveLength(1);
    expect(calls).toEqual(['interrupt', 'return']);
  });
});
