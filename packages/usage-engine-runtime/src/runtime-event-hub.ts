import {
  parseUsageEngineEvent,
  type UsageEngineEvent,
  type UsageEngineInstanceId,
} from '@ai-usage/usage-engine-control';

type RuntimeEventPayload = UsageEngineEvent extends infer Event
  ? Event extends UsageEngineEvent
    ? Omit<Event, 'eventId' | 'instanceId' | 'sequence'>
    : never
  : never;

interface EventSubscriber {
  closed: boolean;
  pending: ((result: IteratorResult<UsageEngineEvent>) => void) | undefined;
  readonly queue: UsageEngineEvent[];
}

export interface RuntimeEventHub {
  readonly changes: () => AsyncIterable<UsageEngineEvent>;
  readonly close: () => void;
  readonly publish: (event: RuntimeEventPayload) => void;
}

const MAX_RUNTIME_EVENT_QUEUE = 64;

export const createRuntimeEventHub = (instanceId: UsageEngineInstanceId): RuntimeEventHub => {
  let eventSequence = 0;
  const subscribers = new Set<EventSubscriber>();

  const closeSubscriber = (subscriber: EventSubscriber): void => {
    if (subscriber.closed) {
      return;
    }
    subscriber.closed = true;
    subscriber.queue.length = 0;
    subscriber.pending?.({ done: true, value: undefined });
    subscriber.pending = undefined;
    subscribers.delete(subscriber);
  };

  const changes = (): AsyncIterable<UsageEngineEvent> => ({
    [Symbol.asyncIterator]: () => {
      const subscriber: EventSubscriber = { closed: false, pending: undefined, queue: [] };
      subscribers.add(subscriber);
      return {
        next: () => {
          const event = subscriber.queue.shift();
          if (event) {
            return Promise.resolve({ done: false as const, value: event });
          }
          if (subscriber.closed) {
            return Promise.resolve({ done: true as const, value: undefined });
          }
          return new Promise<IteratorResult<UsageEngineEvent>>((resolve) => {
            subscriber.pending = resolve;
          });
        },
        return: () => {
          closeSubscriber(subscriber);
          return Promise.resolve({ done: true as const, value: undefined });
        },
      };
    },
  });

  const publish = (eventValue: RuntimeEventPayload): void => {
    eventSequence += 1;
    const event = parseUsageEngineEvent({
      ...eventValue,
      eventId: `engine:${eventSequence}`,
      instanceId,
      sequence: eventSequence,
    });
    for (const subscriber of subscribers) {
      if (subscriber.pending) {
        const resolve = subscriber.pending;
        subscriber.pending = undefined;
        resolve({ done: false, value: event });
        continue;
      }
      if (subscriber.queue.length >= MAX_RUNTIME_EVENT_QUEUE) {
        subscriber.queue.shift();
      }
      subscriber.queue.push(event);
    }
  };

  const close = (): void => {
    for (const subscriber of [...subscribers]) {
      closeSubscriber(subscriber);
    }
  };

  return { changes, close, publish };
};
