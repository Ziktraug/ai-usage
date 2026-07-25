import { Clock, Effect, type Exit, Option } from 'effect';
import { safeClassify } from './classifier';
import { nanosToMillis } from './duration';
import type { BoundaryClassification, LogValue } from './model';
import { WideEventResourceService } from './resource';
import { submitWideEventBestEffort, WideEventSink } from './sink';
import {
  createWideEventController,
  currentWideEventHop,
  makeWideEventLayer,
  type WideEventService,
} from './wide-event';

export interface BoundaryRunOptions<A, E> {
  readonly annotations?: Readonly<Record<string, LogValue>>;
  readonly boundary: string;
  readonly classify?: (exit: Exit.Exit<A, E>) => BoundaryClassification;
}

const millisecondsToIso = (milliseconds: number): string => new Date(milliseconds).toISOString();

const newEventId = (): string => globalThis.crypto.randomUUID();

export const runBoundaryEffect = <A, E, R>(
  options: BoundaryRunOptions<A, E>,
  effect: Effect.Effect<A, E, R | WideEventService>,
): Effect.Effect<A, E, Exclude<R, WideEventService> | WideEventResourceService | WideEventSink> =>
  Effect.gen(function* () {
    const sink = yield* WideEventSink;
    const resource = yield* WideEventResourceService;
    const eventId = newEventId();
    const startedAtMillis = yield* Clock.currentTimeMillis;
    const startedAt = millisecondsToIso(startedAtMillis);
    const startedAtNanos = yield* Clock.currentTimeNanos;
    const controller = createWideEventController({
      boundary: options.boundary,
      eventId,
      resource,
      startedAt,
      ...(options.annotations === undefined ? {} : { annotations: options.annotations }),
    });

    const finalize = (exit: Exit.Exit<A, E>) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const emittedAtMillis = yield* Clock.currentTimeMillis;
          const completedAtNanos = yield* Clock.currentTimeNanos;
          const classification = safeClassify(exit, options.classify);
          const event = yield* controller.emit({
            durationMs: nanosToMillis(completedAtNanos - startedAtNanos),
            emittedAt: millisecondsToIso(emittedAtMillis),
            outcome: classification.outcome,
            error: classification.error ?? null,
            ...(classification.annotations === undefined ? {} : { annotations: classification.annotations }),
          });
          yield* submitWideEventBestEffort(sink, event).pipe(Effect.catchAllCause(() => Effect.void));
        }).pipe(Effect.catchAllCause(() => Effect.void)),
      );

    const body = Effect.gen(function* () {
      const span = yield* Effect.currentSpan.pipe(Effect.option);
      if (Option.isSome(span)) {
        yield* controller.setRootTrace({
          spanId: span.value.spanId,
          traceId: span.value.traceId,
        });
      }
      return yield* effect;
    }).pipe(
      Effect.provide(makeWideEventLayer(controller)),
      Effect.onExit(finalize),
      Effect.withSpan(options.boundary, { root: true }),
      Effect.withTracerEnabled(true),
      Effect.locally(currentWideEventHop, undefined),
    );

    return yield* body;
  }) as Effect.Effect<A, E, Exclude<R, WideEventService> | WideEventResourceService | WideEventSink>;
