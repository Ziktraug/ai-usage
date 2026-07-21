import { Context, Effect, FiberRef, Layer, Ref } from 'effect';
import type { BoundaryOutcome, LogValue, SanitizedTaggedError, ServiceHop, WideEventSnapshot } from './model';
import { sanitizeWideEventSnapshot } from './sanitize';

interface HopEnrichment {
  readonly annotations: Readonly<Record<string, LogValue>>;
}

interface CompletedHop extends HopEnrichment {
  readonly durationMs: number;
  readonly id: string;
  readonly name: string;
  readonly outcome: BoundaryOutcome;
  readonly parentId?: string;
  readonly sequence: number;
  readonly spanId: string;
  readonly traceId: string;
}

interface WideEventState {
  readonly completedHops: readonly CompletedHop[];
  readonly emitted: boolean;
  readonly enrichments: Readonly<Record<string, HopEnrichment>>;
  readonly finalAnnotations: Readonly<Record<string, LogValue>>;
  readonly finalError: SanitizedTaggedError | null;
  readonly finalOutcome: BoundaryOutcome | undefined;
  readonly rootAnnotations: Readonly<Record<string, LogValue>>;
  readonly rootSpanId: string | undefined;
  readonly rootTraceId: string | undefined;
  readonly sequence: number;
}

export interface OpenHopHandle {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;
  readonly sequence: number;
  readonly spanId: string;
  readonly traceId: string;
}

export interface WideEventShape {
  readonly annotate: (fields: Readonly<Record<string, LogValue>>) => Effect.Effect<void>;
  readonly completeHop: (handle: OpenHopHandle, durationMs: number, outcome: BoundaryOutcome) => Effect.Effect<void>;
  readonly openHop: (options: {
    readonly name: string;
    readonly parentId?: string;
    readonly spanId: string;
    readonly traceId: string;
  }) => Effect.Effect<OpenHopHandle>;
  readonly setRootTrace: (fields: { readonly spanId: string; readonly traceId: string }) => Effect.Effect<void>;
}

export interface WideEventController extends WideEventShape {
  readonly emit: (fields: {
    readonly durationMs: number;
    readonly emittedAt: string;
    readonly error?: SanitizedTaggedError | null;
    readonly outcome: BoundaryOutcome;
    readonly annotations?: Readonly<Record<string, LogValue>>;
  }) => Effect.Effect<WideEventSnapshot>;
}

export class WideEventService extends Context.Tag('@ai-usage/effect-runtime/WideEventService')<
  WideEventService,
  WideEventShape
>() {}

export const currentWideEventHop = FiberRef.unsafeMake<string | undefined>(undefined);

const buildServices = (completed: readonly CompletedHop[]): ServiceHop[] => {
  type MutableHop = Omit<ServiceHop, 'annotations' | 'children'> & {
    annotations?: Readonly<Record<string, LogValue>>;
    children: MutableHop[];
  };

  const byId = new Map<string, MutableHop>();
  const roots: MutableHop[] = [];
  const ordered = [...completed].sort((left, right) => left.sequence - right.sequence);

  for (const hop of ordered) {
    const mutable: MutableHop = {
      children: [],
      durationMs: hop.durationMs,
      name: hop.name,
      outcome: hop.outcome,
      spanId: hop.spanId,
      traceId: hop.traceId,
    };
    if (Object.keys(hop.annotations).length > 0) {
      mutable.annotations = hop.annotations;
    }
    byId.set(hop.id, mutable);
  }

  for (const hop of ordered) {
    const rendered = byId.get(hop.id);
    if (!rendered) {
      continue;
    }
    const parent = hop.parentId === undefined ? undefined : byId.get(hop.parentId);
    if (parent) {
      parent.children.push(rendered);
    } else {
      roots.push(rendered);
    }
  }

  const freezeHop = (hop: MutableHop): ServiceHop => ({
    name: hop.name,
    traceId: hop.traceId,
    spanId: hop.spanId,
    outcome: hop.outcome,
    durationMs: hop.durationMs,
    ...(hop.annotations === undefined ? {} : { annotations: hop.annotations }),
    ...(hop.children.length > 0 ? { children: hop.children.map(freezeHop) } : {}),
  });

  return roots.map(freezeHop);
};

export const createWideEventController = ({
  boundary,
  eventId,
  startedAt,
  annotations = {},
}: {
  readonly annotations?: Readonly<Record<string, LogValue>>;
  readonly boundary: string;
  readonly eventId: string;
  readonly startedAt: string;
}): WideEventController => {
  const state = Ref.unsafeMake<WideEventState>({
    completedHops: [],
    emitted: false,
    enrichments: {},
    finalAnnotations: {},
    finalError: null,
    finalOutcome: undefined,
    rootAnnotations: annotations,
    rootSpanId: undefined,
    rootTraceId: undefined,
    sequence: 0,
  });

  const buildSnapshot = (durationMs: number, emittedAt: string): Effect.Effect<WideEventSnapshot> =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const services = buildServices(current.completedHops);
      const raw: WideEventSnapshot = {
        schemaVersion: 1,
        event: 'wide-event',
        eventId,
        boundary,
        startedAt,
        emittedAt,
        traceId: current.rootTraceId ?? current.completedHops[0]?.traceId ?? 'untraced',
        spanId: current.rootSpanId ?? current.completedHops[0]?.spanId ?? 'untraced',
        outcome: current.finalOutcome ?? 'failure',
        durationMs,
        error: current.finalError,
        annotations: {
          ...current.rootAnnotations,
          ...current.finalAnnotations,
        },
        services,
      };
      return sanitizeWideEventSnapshot(raw).value;
    }).pipe(
      Effect.catchAllCause(() =>
        Effect.succeed({
          schemaVersion: 1 as const,
          event: 'wide-event' as const,
          eventId,
          boundary,
          startedAt,
          emittedAt,
          traceId: 'untraced',
          spanId: 'untraced',
          outcome: 'failure' as const,
          durationMs,
          error: null,
          annotations: { observabilityTruncated: true },
          services: [],
        }),
      ),
    );

  return {
    annotate: (fields) =>
      FiberRef.get(currentWideEventHop).pipe(
        Effect.flatMap((hopId) =>
          Ref.update(state, (current) => {
            if (current.emitted) {
              return current;
            }
            if (hopId === undefined) {
              return {
                ...current,
                rootAnnotations: {
                  ...current.rootAnnotations,
                  ...fields,
                },
              };
            }
            const enrichment = current.enrichments[hopId] ?? { annotations: {} };
            return {
              ...current,
              enrichments: {
                ...current.enrichments,
                [hopId]: {
                  annotations: {
                    ...enrichment.annotations,
                    ...fields,
                  },
                },
              },
            };
          }),
        ),
      ),
    completeHop: (handle, durationMs, outcome) =>
      Ref.update(state, (current) => {
        if (current.emitted) {
          return current;
        }
        const enrichment = current.enrichments[handle.id] ?? { annotations: {} };
        return {
          ...current,
          completedHops: [
            ...current.completedHops,
            {
              ...enrichment,
              durationMs,
              id: handle.id,
              name: handle.name,
              outcome,
              ...(handle.parentId === undefined ? {} : { parentId: handle.parentId }),
              sequence: handle.sequence,
              spanId: handle.spanId,
              traceId: handle.traceId,
            },
          ],
        };
      }),
    emit: (fields) =>
      Effect.gen(function* () {
        const shouldEmit = yield* Ref.modify(state, (current) => {
          if (current.emitted) {
            return [false, current] as const;
          }
          return [
            true,
            {
              ...current,
              emitted: true,
              finalAnnotations: fields.annotations ?? {},
              finalError: fields.error ?? null,
              finalOutcome: fields.outcome,
            },
          ] as const;
        });
        const event = yield* buildSnapshot(fields.durationMs, fields.emittedAt);
        if (!shouldEmit) {
          return event;
        }
        return event;
      }),
    openHop: ({ name, parentId, spanId, traceId }) =>
      Ref.modify(state, (current) => {
        const handle: OpenHopHandle = {
          id: current.emitted ? 'closed' : `hop-${current.sequence}`,
          name,
          ...(parentId === undefined ? {} : { parentId }),
          sequence: current.sequence,
          spanId,
          traceId,
        };
        return [handle, current.emitted ? current : { ...current, sequence: current.sequence + 1 }] as const;
      }),
    setRootTrace: (fields) =>
      Ref.update(state, (current) =>
        current.emitted || current.rootTraceId !== undefined
          ? current
          : {
              ...current,
              rootSpanId: fields.spanId,
              rootTraceId: fields.traceId,
            },
      ),
  };
};

export const makeWideEventLayer = (wideEvent: WideEventShape) => Layer.succeed(WideEventService, wideEvent);

export const annotateWideEvent = (fields: Readonly<Record<string, LogValue>>) =>
  WideEventService.pipe(Effect.flatMap((wideEvent) => wideEvent.annotate(fields)));
