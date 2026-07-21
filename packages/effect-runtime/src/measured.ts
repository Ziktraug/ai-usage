import { Clock, Effect, type Exit, FiberRef, Option } from 'effect';
import { safeClassifyHop } from './classifier';
import type { BoundaryOutcome } from './model';
import { currentWideEventHop, WideEventService } from './wide-event';

export interface MeasuredOptions<A, E> {
  readonly classify?: (exit: Exit.Exit<A, E>) => BoundaryOutcome;
}

const nanosToMillis = (value: bigint): number => Number(value) / 1_000_000;

const openMeasuredHop = (
  name: string,
): Effect.Effect<
  {
    readonly id: string;
    readonly name: string;
    readonly parentId?: string;
    readonly sequence: number;
    readonly spanId: string;
    readonly traceId: string;
  },
  never,
  WideEventService
> =>
  Effect.gen(function* () {
    const wideEvent = yield* WideEventService;
    const parentId = yield* FiberRef.get(currentWideEventHop);
    const span = yield* Effect.currentSpan.pipe(Effect.option);
    return yield* wideEvent.openHop({
      name,
      ...(parentId === undefined ? {} : { parentId }),
      spanId: Option.isSome(span) ? span.value.spanId : 'untraced',
      traceId: Option.isSome(span) ? span.value.traceId : 'untraced',
    });
  });

export const withMeasured =
  <A, E>(name: string, options: MeasuredOptions<A, E> = {}) =>
  <R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | WideEventService> => {
    const measured = Effect.gen(function* () {
      const wideEvent = yield* WideEventService;
      const handle = yield* openMeasuredHop(name);
      const startedAt = yield* Clock.currentTimeNanos;
      return yield* Effect.locally(
        effect.pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const completedAt = yield* Clock.currentTimeNanos;
              yield* wideEvent.completeHop(
                handle,
                nanosToMillis(completedAt - startedAt),
                safeClassifyHop(exit, options.classify),
              );
            }),
          ),
        ),
        currentWideEventHop,
        handle.id,
      );
    });

    return measured.pipe(Effect.withSpan(name), Effect.withTracerEnabled(true));
  };

export const withMeasuredIfAvailable =
  <A, E>(name: string, options: MeasuredOptions<A, E> = {}) =>
  <R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.serviceOption(WideEventService).pipe(
      Effect.flatMap((service) => {
        if (Option.isNone(service)) {
          return effect;
        }
        return withMeasured(name, options)(effect) as Effect.Effect<A, E, R>;
      }),
    );
