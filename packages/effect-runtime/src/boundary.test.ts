import { describe, expect, test } from 'bun:test';
import { Deferred, Effect, Exit, Fiber } from 'effect';
import { runBoundaryEffect, withMeasured, withMeasuredIfAvailable } from './index';
import { makeCaptureWideEventSink, makeWideEventSinkLayer, noopWideEventSink, type WideEventSink } from './sink';

const runWithCapture = <A, E>(effect: Effect.Effect<A, E, WideEventSink>) => {
  const sink = makeCaptureWideEventSink();
  return {
    sink,
    program: effect.pipe(Effect.provide(makeWideEventSinkLayer(sink))),
  };
};

describe('boundary runner and hop tree', () => {
  test('reconstructs nested hops in sequence order', async () => {
    const { sink, program } = runWithCapture(
      runBoundaryEffect(
        { boundary: 'nested' },
        withMeasured('outer')(
          withMeasured('inner')(Effect.succeed(1)).pipe(Effect.zipLeft(withMeasured('sibling')(Effect.succeed(2)))),
        ),
      ),
    );

    await Effect.runPromise(program);
    const event = sink.events()[0];
    expect(event?.services.map((hop) => hop.name)).toEqual(['outer']);
    expect(event?.services[0]?.children?.map((hop) => hop.name)).toEqual(['inner', 'sibling']);
  });

  test('keeps parallel children deterministic by sequence', async () => {
    const { sink, program } = runWithCapture(
      runBoundaryEffect(
        { boundary: 'parallel' },
        Effect.all([withMeasured('a')(Effect.sleep('5 millis')), withMeasured('b')(Effect.sleep('1 millis'))], {
          concurrency: 'unbounded',
        }),
      ),
    );

    await Effect.runPromise(program);
    const names = sink.events()[0]?.services.map((hop) => hop.name) ?? [];
    expect(names).toEqual(['a', 'b']);
  });

  test('isolates sequential boundaries on one fiber', async () => {
    const sink = makeCaptureWideEventSink();
    const program = Effect.gen(function* () {
      yield* runBoundaryEffect({ boundary: 'one', annotations: { n: 1 } }, withMeasured('h1')(Effect.succeed(1)));
      yield* runBoundaryEffect({ boundary: 'two', annotations: { n: 2 } }, withMeasured('h2')(Effect.succeed(2)));
    }).pipe(Effect.provide(makeWideEventSinkLayer(sink)));

    await Effect.runPromise(program);
    expect(sink.events()).toHaveLength(2);
    expect(sink.events()[0]?.boundary).toBe('one');
    expect(sink.events()[0]?.services.map((hop) => hop.name)).toEqual(['h1']);
    expect(sink.events()[1]?.boundary).toBe('two');
    expect(sink.events()[1]?.services.map((hop) => hop.name)).toEqual(['h2']);
    expect(sink.events()[0]?.eventId).not.toBe(sink.events()[1]?.eventId);
  });

  test('emits exactly once even under concurrent finalize pressure', async () => {
    const sink = makeCaptureWideEventSink();
    const program = runBoundaryEffect({ boundary: 'once' }, Effect.succeed('ok')).pipe(
      Effect.provide(makeWideEventSinkLayer(sink)),
    );
    await Effect.runPromise(program);
    expect(sink.events()).toHaveLength(1);
  });

  test('finalizes interrupted boundaries as interrupted', async () => {
    const sink = makeCaptureWideEventSink();
    const started = await Effect.runPromise(Deferred.make<void>());
    const program = runBoundaryEffect(
      { boundary: 'interrupt' },
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        yield* Effect.never;
      }),
    ).pipe(Effect.provide(makeWideEventSinkLayer(sink)));

    const fiber = Effect.runFork(program);
    await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Fiber.interrupt(fiber));
    // Allow uninterruptible finalizer to submit.
    await Effect.runPromise(Effect.sleep('20 millis'));
    expect(sink.events()).toHaveLength(1);
    expect(sink.events()[0]?.outcome).toBe('interrupted');
  });

  test('withMeasuredIfAvailable is a no-op without an outer boundary', async () => {
    const result = await Effect.runPromise(withMeasuredIfAvailable('orphan')(Effect.succeed(42)));
    expect(result).toBe(42);
  });

  test('withMeasuredIfAvailable records a hop inside a boundary and never emits alone', async () => {
    const { sink, program } = runWithCapture(
      runBoundaryEffect({ boundary: 'owner' }, withMeasuredIfAvailable('quota.refresh')(Effect.succeed('done'))),
    );
    await Effect.runPromise(program);
    expect(sink.events()).toHaveLength(1);
    expect(sink.events()[0]?.services.map((hop) => hop.name)).toEqual(['quota.refresh']);
  });

  test('sink failure does not change the business result', async () => {
    const failingSink = {
      submit: () => Effect.die('sink exploded'),
      diagnostics: () => Effect.succeed({ accepted: 0, dropped: 0, failed: 1 }),
    };
    const result = await Effect.runPromise(
      runBoundaryEffect({ boundary: 'safe' }, Effect.succeed('value')).pipe(
        Effect.provide(makeWideEventSinkLayer(failingSink)),
      ),
    );
    expect(result).toBe('value');
  });

  test('classifier failure falls back without changing the business exit', async () => {
    const sink = makeCaptureWideEventSink();
    const exit = await Effect.runPromiseExit(
      runBoundaryEffect(
        {
          boundary: 'classify-fail',
          classify: () => {
            throw new Error('boom');
          },
        },
        Effect.fail('domain-error' as const),
      ).pipe(Effect.provide(makeWideEventSinkLayer(sink))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(sink.events()[0]?.outcome).toBe('failure');
  });

  test('noop sink accepts submissions without mutable global state', async () => {
    const result = await Effect.runPromise(
      runBoundaryEffect({ boundary: 'noop' }, Effect.succeed(1)).pipe(
        Effect.provide(makeWideEventSinkLayer(noopWideEventSink)),
      ),
    );
    expect(result).toBe(1);
  });
});
