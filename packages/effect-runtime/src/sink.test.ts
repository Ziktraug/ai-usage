import { describe, expect, test } from 'bun:test';
import { Deferred, Effect, Fiber } from 'effect';
import type { WideEventSnapshot } from './model';
import { testWideEventResource } from './resource';
import {
  combineWideEventSinks,
  makeCaptureWideEventSink,
  submitWideEventBestEffort,
  type WideEventSinkShape,
} from './sink';

const SUBMIT_BUDGET_MS = 250;
const BUDGET_SLACK_MS = 750;

const event: WideEventSnapshot = {
  schemaVersion: 2,
  event: 'wide-event',
  eventId: 'event-id',
  boundary: 'sink-test',
  startedAt: '2026-07-25T12:00:00.000Z',
  emittedAt: '2026-07-25T12:00:00.010Z',
  traceId: 'untraced',
  spanId: 'untraced',
  outcome: 'success',
  durationMs: 10,
  error: null,
  resource: testWideEventResource,
  annotations: {},
  services: [],
};

const elapsedMillis = async (run: () => Promise<unknown>): Promise<number> => {
  const startedAt = performance.now();
  await run();
  return performance.now() - startedAt;
};

describe('submitWideEventBestEffort', () => {
  test('waits for a fast transport so its event is captured before returning', async () => {
    const sink = makeCaptureWideEventSink();

    await Effect.runPromise(submitWideEventBestEffort(sink, event));

    expect(sink.events()).toHaveLength(1);
    expect(await Effect.runPromise(sink.diagnostics())).toMatchObject({ accepted: 1 });
  });

  test('returns within the budget and interrupts a hanging transport', async () => {
    const interrupted = await Effect.runPromise(Deferred.make<void>());
    const hanging: WideEventSinkShape = {
      submit: () => Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
      diagnostics: () => Effect.succeed({ accepted: 0, dropped: 0, failed: 0 }),
    };

    const elapsed = await elapsedMillis(() => Effect.runPromise(submitWideEventBestEffort(hanging, event)));

    expect(elapsed).toBeGreaterThanOrEqual(SUBMIT_BUDGET_MS - 50);
    expect(elapsed).toBeLessThan(SUBMIT_BUDGET_MS + BUDGET_SLACK_MS);
    await Effect.runPromise(Deferred.await(interrupted).pipe(Effect.timeout('2 seconds')));
  });

  test('an uninterruptible transport cannot hold an uninterruptible caller beyond the budget', async () => {
    const released = await Effect.runPromise(Deferred.make<void>());
    const stuck: WideEventSinkShape = {
      submit: () => Effect.uninterruptible(Deferred.await(released)),
      diagnostics: () => Effect.succeed({ accepted: 0, dropped: 0, failed: 0 }),
    };

    const elapsed = await elapsedMillis(() =>
      Effect.runPromise(Effect.uninterruptible(submitWideEventBestEffort(stuck, event))),
    );

    expect(elapsed).toBeLessThan(SUBMIT_BUDGET_MS + BUDGET_SLACK_MS);
    await Effect.runPromise(Deferred.succeed(released, undefined));
  });

  test('a combined sink interrupts a hanging transport when its own submission is abandoned', async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const interrupted = await Effect.runPromise(Deferred.make<void>());
    const hanging: WideEventSinkShape = {
      submit: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      diagnostics: () => Effect.succeed({ accepted: 0, dropped: 0, failed: 0 }),
    };
    const combined = combineWideEventSinks({ name: 'hanging', sink: hanging });

    // An outer best-effort budget that is spent first abandons the combined submission by interrupting
    // it, which interrupts the per-transport waiter before that waiter's own budget runs out.
    const submission = Effect.runFork(combined.submit(event));
    await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Fiber.interrupt(submission));

    await Effect.runPromise(Deferred.await(interrupted).pipe(Effect.timeout('2 seconds')));
  });

  test('a transport defect never reaches the caller', async () => {
    const exploding: WideEventSinkShape = {
      submit: () => Effect.die('sink exploded'),
      diagnostics: () => Effect.succeed({ accepted: 0, dropped: 0, failed: 1 }),
    };

    await expect(Effect.runPromise(submitWideEventBestEffort(exploding, event))).resolves.toBeUndefined();
  });
});
