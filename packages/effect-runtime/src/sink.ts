import { Context, Effect, Fiber, Layer, Ref } from 'effect';
import type { WideEventSnapshot } from './model';
import { serializeWideEventSnapshot } from './sanitize';

export interface WideEventSinkDiagnostics {
  readonly accepted: number;
  readonly dropped: number;
  readonly failed: number;
}

export interface WideEventSinkShape {
  readonly diagnostics: () => Effect.Effect<WideEventSinkDiagnostics>;
  readonly submit: (event: WideEventSnapshot) => Effect.Effect<void>;
}

export class WideEventSink extends Context.Tag('@ai-usage/effect-runtime/WideEventSink')<
  WideEventSink,
  WideEventSinkShape
>() {}

const SINK_SUBMIT_TIMEOUT_MS = 250;

const emptyDiagnostics = (): WideEventSinkDiagnostics => ({
  accepted: 0,
  dropped: 0,
  failed: 0,
});

export const submitWideEventBestEffort = (sink: WideEventSinkShape, event: WideEventSnapshot): Effect.Effect<void> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.suspend(() => sink.submit(event)).pipe(
      Effect.disconnect,
      Effect.timeout(SINK_SUBMIT_TIMEOUT_MS),
      Effect.catchAllCause(() => Effect.void),
      Effect.interruptible,
      Effect.forkDaemon,
    );
    yield* Fiber.await(fiber);
  });

export const noopWideEventSink: WideEventSinkShape = {
  submit: () => Effect.void,
  diagnostics: () => Effect.succeed(emptyDiagnostics()),
};

export const makeCaptureWideEventSink = (): WideEventSinkShape & {
  readonly events: () => readonly WideEventSnapshot[];
} => {
  const events: WideEventSnapshot[] = [];
  const diagnostics = Ref.unsafeMake(emptyDiagnostics());

  return {
    events: () => events,
    submit: (event) =>
      Effect.gen(function* () {
        // Defensive re-serialize through the canonical sanitizer path.
        const line = serializeWideEventSnapshot(event);
        events.push(JSON.parse(line) as WideEventSnapshot);
        yield* Ref.update(diagnostics, (current) => ({
          ...current,
          accepted: current.accepted + 1,
        }));
      }),
    diagnostics: () => Ref.get(diagnostics),
  };
};

export const combineWideEventSinks = (...sinks: readonly WideEventSinkShape[]): WideEventSinkShape => ({
  submit: (event) =>
    Effect.forEach(sinks, (sink) => submitWideEventBestEffort(sink, event), {
      concurrency: 'unbounded',
      discard: true,
    }),
  diagnostics: () =>
    Effect.gen(function* () {
      const parts = yield* Effect.forEach(sinks, (sink) => sink.diagnostics());
      return parts.reduce(
        (acc, part) => ({
          accepted: acc.accepted + part.accepted,
          dropped: acc.dropped + part.dropped,
          failed: acc.failed + part.failed,
        }),
        emptyDiagnostics(),
      );
    }),
});

export const makeWideEventSinkLayer = (sink: WideEventSinkShape) => Layer.succeed(WideEventSink, sink);
