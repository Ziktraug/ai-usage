import { Effect } from 'effect';

export interface UsageEngineWriterGate {
  readonly close: () => void;
  readonly isClosed: () => boolean;
  readonly run: <Value>(operation: () => Promise<Value>, signal?: AbortSignal) => Promise<Value>;
  readonly withEffect: <Value, Error, Requirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
  ) => Effect.Effect<Value, Error, Requirements>;
  readonly withPermit: <Value, Error, Requirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
  ) => Effect.Effect<Value, Error, Requirements>;
}

export class UsageEngineWriterGateClosedError extends Error {
  override readonly name = 'UsageEngineWriterGateClosedError';
}

export const createUsageEngineWriterGate = (): UsageEngineWriterGate => {
  const semaphore = Effect.runSync(Effect.makeSemaphore(1));
  let closed = false;
  const withPermit: UsageEngineWriterGate['withPermit'] = (effect) => semaphore.withPermits(1)(effect);
  const withEffect: UsageEngineWriterGate['withEffect'] = (effect) =>
    withPermit(
      Effect.suspend(() =>
        closed ? Effect.die(new UsageEngineWriterGateClosedError('Usage engine writer gate is closed.')) : effect,
      ),
    );

  return {
    close: () => {
      closed = true;
    },
    isClosed: () => closed,
    run: async <Value>(operation: () => Promise<Value>, signal?: AbortSignal): Promise<Value> =>
      await Effect.runPromise(
        withEffect(
          Effect.uninterruptible(
            Effect.tryPromise({
              catch: (cause) => cause,
              try: operation,
            }),
          ),
        ),
        signal === undefined ? undefined : { signal },
      ),
    withEffect,
    withPermit,
  };
};
