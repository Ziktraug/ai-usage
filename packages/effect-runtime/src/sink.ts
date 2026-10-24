import { Context, Effect, Fiber, Layer, Option, Ref } from 'effect';
import type { WideEventSnapshot } from './model';
import { testWideEventResourceLayer, type WideEventResourceService } from './resource';
import { serializeWideEventSnapshot } from './sanitize';

export interface WideEventSinkDiagnostics {
  readonly accepted: number;
  readonly dropped: number;
  readonly failed: number;
  readonly submitted?: number;
  readonly transports?: Readonly<Record<string, WideEventTransportDiagnostics>>;
}

export type WideEventTransportDiagnostics = Pick<WideEventSinkDiagnostics, 'accepted' | 'dropped' | 'failed'>;

export interface WideEventSinkShape {
  readonly diagnostics: () => Effect.Effect<WideEventSinkDiagnostics>;
  readonly submit: (event: WideEventSnapshot) => Effect.Effect<void>;
}

export class WideEventSink extends Context.Service<WideEventSink, WideEventSinkShape>()(
  '@ai-usage/effect-runtime/WideEventSink',
) {}

const SINK_SUBMIT_TIMEOUT_MS = 250;

export const makeEmptyWideEventSinkDiagnostics = (): WideEventSinkDiagnostics => ({
  accepted: 0,
  dropped: 0,
  failed: 0,
});

/**
 * Submits one event and returns within the submit budget whatever the transport does.
 *
 * The submission runs in a detached fiber so that the caller (usually an
 * uninterruptible boundary finalizer) only waits for its exit with a timeout.
 * When the budget is spent the submission is abandoned: it is signalled to
 * interrupt but never awaited, so an uninterruptible transport cannot hold the
 * caller beyond the budget.
 */
export const submitWideEventBestEffort = (sink: WideEventSinkShape, event: WideEventSnapshot): Effect.Effect<void> =>
  Effect.gen(function* () {
    const submission = yield* Effect.forkDetach(
      Effect.suspend(() => sink.submit(event)),
      { startImmediately: true },
    );
    const exit = yield* Fiber.await(submission).pipe(Effect.timeoutOption(SINK_SUBMIT_TIMEOUT_MS));
    if (Option.isNone(exit)) {
      submission.interruptUnsafe();
    }
  });

export const noopWideEventSink: WideEventSinkShape = {
  submit: () => Effect.void,
  diagnostics: () => Effect.succeed(makeEmptyWideEventSinkDiagnostics()),
};

export const makeCaptureWideEventSink = (): WideEventSinkShape & {
  readonly events: () => readonly WideEventSnapshot[];
} => {
  const events: WideEventSnapshot[] = [];
  const diagnostics = Ref.makeUnsafe(makeEmptyWideEventSinkDiagnostics());

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

export interface NamedWideEventSink {
  readonly name: string;
  readonly sink: WideEventSinkShape;
}

export const combineWideEventSinks = (...sinks: readonly NamedWideEventSink[]): WideEventSinkShape => {
  const submitted = Ref.makeUnsafe(0);
  return {
    submit: (event) =>
      Effect.gen(function* () {
        yield* Ref.update(submitted, (count) => count + 1);
        yield* Effect.forEach(sinks, ({ sink }) => submitWideEventBestEffort(sink, event), {
          concurrency: 'unbounded',
          discard: true,
        });
      }),
    diagnostics: () =>
      Effect.gen(function* () {
        const logicalSubmissions = yield* Ref.get(submitted);
        const parts = yield* Effect.forEach(sinks, ({ name, sink }) =>
          sink.diagnostics().pipe(Effect.map((diagnostics) => [name, diagnostics] as const)),
        );
        return {
          accepted: logicalSubmissions,
          dropped: 0,
          failed: 0,
          submitted: logicalSubmissions,
          transports: Object.fromEntries(parts),
        };
      }),
  };
};

export const makeWideEventSinkLayer = (sink: WideEventSinkShape): Layer.Layer<WideEventSink> =>
  Layer.succeed(WideEventSink, sink);

export const makeTestWideEventSinkLayer = (
  sink: WideEventSinkShape,
): Layer.Layer<WideEventResourceService | WideEventSink> =>
  Layer.merge(makeWideEventSinkLayer(sink), testWideEventResourceLayer);
