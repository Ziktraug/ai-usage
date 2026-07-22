import { describe, expect, test } from 'bun:test';
import { Cause, Data, Effect, Exit } from 'effect';
import { classifyExit, runBoundaryEffect, safeClassify, withMeasured } from './index';
import { makeCaptureWideEventSink, makeTestWideEventSinkLayer } from './sink';

class ProviderQuotaRefreshAborted extends Data.TaggedError('ProviderQuotaRefreshAborted')<{
  readonly publicMessage?: string;
}> {}

class UnknownDomainError extends Data.TaggedError('UnknownDomainError')<{
  readonly message: string;
}> {}

class CliArgumentError extends Data.TaggedError('CliArgumentError')<{
  readonly message: string;
  readonly publicMessage?: string;
}> {}

describe('wide-event model and classifier', () => {
  test('default success classification', () => {
    expect(classifyExit(Exit.succeed(1))).toEqual({ outcome: 'success', error: null });
  });

  test('typed failure becomes failure without generic messages for unknown tags', () => {
    const classification = classifyExit(Exit.fail(new UnknownDomainError({ message: 'secret body' })));
    expect(classification.outcome).toBe('failure');
    expect(classification.error).toBeNull();
  });

  test('interruption-only cause becomes interrupted', () => {
    expect(classifyExit(Exit.failCause(Cause.interrupt(1 as never)))).toEqual({
      outcome: 'interrupted',
      error: null,
    });
  });

  test('ProviderQuotaRefreshAborted becomes interrupted with allowlisted tag', () => {
    const classification = classifyExit(Exit.fail(new ProviderQuotaRefreshAborted({ publicMessage: 'aborted' })));
    expect(classification.outcome).toBe('interrupted');
    expect(classification.error).toEqual({
      tag: 'ProviderQuotaRefreshAborted',
      message: 'aborted',
    });
  });

  test('allowlisted errors require an explicit scrubbed publicMessage', () => {
    expect(classifyExit(Exit.fail(new CliArgumentError({ message: 'Bearer private-token' }))).error).toEqual({
      tag: 'CliArgumentError',
    });
    expect(
      classifyExit(
        Exit.fail(
          new CliArgumentError({
            message: 'internal detail',
            publicMessage: 'Request failed: https://fixture.invalid?access_token=private-token',
          }),
        ),
      ).error,
    ).toEqual({
      message: 'Request failed: https://fixture.invalid?access_token=[REDACTED]',
      tag: 'CliArgumentError',
    });
  });

  test('custom classifier can mark timed-out and degraded; thrown classifier falls back', () => {
    const timedOut = safeClassify(Exit.succeed({ status: 'timed-out' }), (exit) => {
      if (Exit.isSuccess(exit) && exit.value.status === 'timed-out') {
        return { outcome: 'timed-out' as const, error: null };
      }
      return { outcome: 'success' as const, error: null };
    });
    expect(timedOut.outcome).toBe('timed-out');

    const degraded = safeClassify(Exit.succeed({ warnings: 1 }), () => ({
      outcome: 'degraded' as const,
      error: null,
    }));
    expect(degraded.outcome).toBe('degraded');

    const fallback = safeClassify(Exit.succeed(1), () => {
      throw new Error('classifier boom');
    });
    expect(fallback).toEqual({ outcome: 'success', error: null });
  });

  test('custom classifier can mark swallowed domain failure as failure', () => {
    const classification = safeClassify(Exit.succeed(undefined), (exit) => {
      if (Exit.isSuccess(exit) && exit.value === undefined) {
        return { outcome: 'failure' as const, error: null };
      }
      return { outcome: 'success' as const, error: null };
    });
    expect(classification.outcome).toBe('failure');
  });

  test('runBoundaryEffect emits one sanitized snapshot for success', async () => {
    const sink = makeCaptureWideEventSink();
    const program = runBoundaryEffect(
      { boundary: 'test.boundary', annotations: { sourceId: 'cursor' } },
      withMeasured('child')(Effect.succeed('ok')),
    ).pipe(Effect.provide(makeTestWideEventSinkLayer(sink)));

    await Effect.runPromise(program);
    expect(sink.events()).toHaveLength(1);
    const event = sink.events()[0];
    expect(event?.schemaVersion).toBe(2);
    expect(event?.resource).toMatchObject({ runtimeMode: 'test', serviceName: 'ai-usage', surface: 'web' });
    expect(event?.event).toBe('wide-event');
    expect(event?.boundary).toBe('test.boundary');
    expect(event?.outcome).toBe('success');
    expect(event?.annotations.sourceId).toBe('cursor');
    expect(event?.services[0]?.name).toBe('child');
    expect(event?.traceId).not.toBe('untraced');
    expect(event?.spanId).not.toBe('untraced');
  });
});
