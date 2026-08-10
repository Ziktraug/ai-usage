import {
  parseUsageEngineEvent,
  parseUsageEngineEventSequence,
  parseUsageEngineReplayCursor,
  parseUsageEngineStatus,
  type UsageEngineEvent,
  type UsageEngineStatus,
  usageEngineEventIdFor,
} from '@ai-usage/usage-engine-control';

const SSE_HEARTBEAT_MS = 5000;
const encoder = new TextEncoder();

interface EventSubscriber {
  readonly close: () => void;
  readonly emit: (event: UsageEngineEvent) => void;
}

interface ControlEventRuntime {
  readonly changes: () => AsyncIterable<UsageEngineEvent>;
}

export interface UsageEngineControlEventHub {
  readonly createResponse: (request: Request, loadStatus: () => Promise<UsageEngineStatus>) => Promise<Response>;
  readonly dispose: () => Promise<void>;
  readonly state: () => 'disposed' | 'failed' | 'running';
}

interface UsageEngineControlEventHubOptions {
  readonly capacityResponse: () => Response;
  readonly clearHeartbeat: (heartbeat: ReturnType<typeof setInterval>) => void;
  readonly maxReplayEvents: number;
  readonly maxSubscriberFrames: number;
  readonly maxSubscribers: number;
  readonly reportFailure: (boundary: 'event-stream' | 'event-stream-cleanup') => void;
  readonly runtime: ControlEventRuntime;
  readonly scheduleHeartbeat: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>;
}

const sseFrame = (event: UsageEngineEvent): Uint8Array =>
  encoder.encode(`id: ${event.eventId}\nevent: usage-engine\ndata: ${JSON.stringify(event)}\n\n`);

const lastSeenSequence = (
  lastEventId: string | null,
  snapshotBoundarySequence: number,
  eventBuffer: readonly UsageEngineEvent[],
): number => {
  if (lastEventId === null) {
    return 0;
  }
  const exact = eventBuffer.find((event) => event.eventId === lastEventId);
  if (exact) {
    return Math.min(exact.sequence, snapshotBoundarySequence);
  }
  try {
    const cursor = parseUsageEngineReplayCursor(lastEventId);
    return cursor.replaySequence <= snapshotBoundarySequence ? cursor.replaySequence : snapshotBoundarySequence;
  } catch {
    return snapshotBoundarySequence;
  }
};

export const createUsageEngineControlEventHub = ({
  capacityResponse,
  clearHeartbeat,
  maxReplayEvents,
  maxSubscriberFrames,
  maxSubscribers,
  reportFailure,
  runtime,
  scheduleHeartbeat,
}: UsageEngineControlEventHubOptions): UsageEngineControlEventHub => {
  const eventBuffer: UsageEngineEvent[] = [];
  const subscribers = new Set<EventSubscriber>();
  const runtimeIterator = runtime.changes()[Symbol.asyncIterator]();
  let disposed = false;
  let disposalPromise: Promise<void> | undefined;
  let eventPumpState: 'disposed' | 'failed' | 'running' = 'running';

  const publish = (eventValue: UsageEngineEvent): void => {
    const event = parseUsageEngineEvent(eventValue);
    eventBuffer.push(event);
    if (eventBuffer.length > maxReplayEvents) {
      eventBuffer.shift();
    }
    for (const subscriber of subscribers) {
      subscriber.emit(event);
    }
  };

  const failEventPump = (): void => {
    if (eventPumpState !== 'running') {
      return;
    }
    eventPumpState = 'failed';
    eventBuffer.length = 0;
    for (const subscriber of [...subscribers]) {
      subscriber.close();
    }
    reportFailure('event-stream');
  };

  const eventPump = (async () => {
    try {
      while (!disposed) {
        const next = await runtimeIterator.next();
        if (next.done) {
          if (!disposed) {
            failEventPump();
          }
          return;
        }
        publish(next.value);
      }
    } catch {
      if (!disposed) {
        failEventPump();
      }
    }
  })();

  const createResponse = async (request: Request, loadStatus: () => Promise<UsageEngineStatus>): Promise<Response> => {
    if (subscribers.size >= maxSubscribers) {
      return capacityResponse();
    }
    const replayEvents = eventBuffer.slice();
    const snapshotBoundarySequence = replayEvents.at(-1)?.sequence ?? 0;
    const pending: UsageEngineEvent[] = [];
    let pendingOverflow = false;
    let deliver = (event: UsageEngineEvent): void => {
      if (pending.length >= maxSubscriberFrames) {
        pendingOverflow = true;
        return;
      }
      pending.push(event);
    };
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let closed = false;
    const subscriber: EventSubscriber = {
      close: () => {
        if (closed) {
          return;
        }
        closed = true;
        if (heartbeat !== undefined) {
          clearHeartbeat(heartbeat);
        }
        subscribers.delete(subscriber);
        try {
          controller?.close();
        } catch {
          // The transport may have already cancelled the stream.
        }
      },
      emit: (event) => deliver(event),
    };
    subscribers.add(subscriber);
    let status: UsageEngineStatus;
    try {
      status = parseUsageEngineStatus(await loadStatus());
    } catch (cause) {
      subscribers.delete(subscriber);
      closed = true;
      throw cause;
    }
    const statusEvent = parseUsageEngineEvent({
      event: 'status',
      eventId: usageEngineEventIdFor('snapshot', parseUsageEngineEventSequence(snapshotBoundarySequence)),
      instanceId: status.instanceId,
      sequence: 0,
      status,
    });
    const stream = new ReadableStream<Uint8Array>(
      {
        cancel: () => subscriber.close(),
        start: (streamController) => {
          controller = streamController;
          let latestSequence = -1;
          const enqueueFrame = (frame: Uint8Array): boolean => {
            if (closed || (streamController.desiredSize ?? 0) <= 0) {
              subscriber.close();
              return false;
            }
            try {
              streamController.enqueue(frame);
              return true;
            } catch {
              subscriber.close();
              return false;
            }
          };
          const enqueueEvent = (event: UsageEngineEvent): void => {
            if (event.sequence <= latestSequence) {
              return;
            }
            if (enqueueFrame(sseFrame(event))) {
              latestSequence = event.sequence;
            }
          };
          if (!enqueueFrame(sseFrame(statusEvent))) {
            return;
          }
          const seenSequence = lastSeenSequence(
            request.headers.get('last-event-id'),
            snapshotBoundarySequence,
            replayEvents,
          );
          for (const event of replayEvents) {
            if (
              event.event === 'command-completed' &&
              event.sequence > seenSequence &&
              event.sequence <= snapshotBoundarySequence
            ) {
              enqueueEvent(event);
            }
          }
          deliver = enqueueEvent;
          for (const event of pending) {
            if (event.sequence > snapshotBoundarySequence) {
              enqueueEvent(event);
            }
          }
          pending.length = 0;
          if (pendingOverflow) {
            subscriber.close();
            return;
          }
          if (!closed) {
            heartbeat = scheduleHeartbeat(() => {
              enqueueFrame(encoder.encode(': heartbeat\n\n'));
            }, SSE_HEARTBEAT_MS);
          }
        },
      },
      { highWaterMark: maxSubscriberFrames, size: () => 1 },
    );
    return new Response(stream, {
      headers: {
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
        'content-type': 'text/event-stream',
        'x-accel-buffering': 'no',
      },
    });
  };

  const dispose = (): Promise<void> => {
    disposalPromise ??= (async () => {
      disposed = true;
      eventPumpState = eventPumpState === 'failed' ? 'failed' : 'disposed';
      try {
        await runtimeIterator.return?.();
      } catch (error) {
        reportFailure('event-stream-cleanup');
        if (eventPumpState !== 'failed') {
          for (const subscriber of [...subscribers]) {
            subscriber.close();
          }
          throw error;
        }
      }
      await eventPump;
      for (const subscriber of [...subscribers]) {
        subscriber.close();
      }
    })();
    return disposalPromise;
  };

  return { createResponse, dispose, state: () => eventPumpState };
};
