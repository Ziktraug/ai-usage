import {
  type CollectionSourceId,
  collectionSourceIds,
  type SourceControlView,
} from '@ai-usage/report-core/source-control';

const MAX_SOURCE_SNAPSHOT_QUEUE = 64;

interface SourceSnapshotSubscriber {
  closed: boolean;
  pending: ((result: IteratorResult<SourceControlView>) => void) | undefined;
  readonly queue: SourceControlView[];
}

export interface SourceSnapshotBroker {
  readonly beginDisposal: () => void;
  readonly changes: (signal: AbortSignal) => AsyncIterable<SourceControlView>;
  readonly close: () => void;
  readonly completionGeneration: (sourceId: CollectionSourceId) => number;
  readonly completionGenerations: () => ReadonlyMap<CollectionSourceId, number>;
  readonly failStream: () => void;
  readonly latest: () => SourceControlView | undefined;
  readonly publish: (snapshot: SourceControlView) => void;
  readonly waitForNext: (generation: number, signal?: AbortSignal) => Promise<void>;
}

const abortedOperation = (): Error => {
  const error = new Error('The usage engine operation was aborted.');
  error.name = 'AbortError';
  return error;
};

const sourceEntry = (snapshot: SourceControlView, sourceId: CollectionSourceId) => {
  const source = snapshot.sources.find(({ id }) => id === sourceId);
  if (!source) {
    throw new Error('The source-control snapshot omitted a known source.');
  }
  return source;
};

export const createSourceSnapshotBroker = (): SourceSnapshotBroker => {
  const subscribers = new Set<SourceSnapshotSubscriber>();
  const sourceCompletionGenerations = new Map<CollectionSourceId, number>(
    collectionSourceIds.map((sourceId) => [sourceId, 0]),
  );
  let latestSnapshot: SourceControlView | undefined;
  let disposing = false;
  let streamFailure: Error | undefined;

  const closeSubscriber = (subscriber: SourceSnapshotSubscriber): void => {
    if (subscriber.closed) {
      return;
    }
    subscriber.closed = true;
    subscriber.queue.length = 0;
    subscriber.pending?.({ done: true, value: undefined });
    subscriber.pending = undefined;
    subscribers.delete(subscriber);
  };

  const close = (): void => {
    for (const subscriber of [...subscribers]) {
      closeSubscriber(subscriber);
    }
  };

  const publish = (snapshot: SourceControlView): void => {
    if (latestSnapshot && snapshot.generation <= latestSnapshot.generation) {
      return;
    }
    const previous = latestSnapshot;
    if (previous) {
      for (const source of snapshot.sources) {
        const prior = sourceEntry(previous, source.id);
        const wasRunning = prior.lifecycle === 'running' || prior.lifecycle === 'pausing';
        const isRunning = source.lifecycle === 'running' || source.lifecycle === 'pausing';
        if (wasRunning && !isRunning) {
          sourceCompletionGenerations.set(source.id, (sourceCompletionGenerations.get(source.id) ?? 0) + 1);
        }
      }
    }
    latestSnapshot = snapshot;
    for (const subscriber of subscribers) {
      if (subscriber.pending) {
        const resolve = subscriber.pending;
        subscriber.pending = undefined;
        resolve({ done: false, value: snapshot });
        continue;
      }
      if (subscriber.queue.length >= MAX_SOURCE_SNAPSHOT_QUEUE) {
        subscriber.queue.shift();
      }
      subscriber.queue.push(snapshot);
    }
  };

  const failStream = (): void => {
    if (disposing || streamFailure) {
      return;
    }
    streamFailure = new Error('The usage engine source-control event stream stopped unexpectedly.');
    close();
  };

  const waitForNext = async (generation: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) {
      throw abortedOperation();
    }
    if (latestSnapshot && latestSnapshot.generation > generation) {
      return;
    }
    if (streamFailure) {
      throw streamFailure;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const subscriber: SourceSnapshotSubscriber = { closed: false, pending: undefined, queue: [] };
      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        closeSubscriber(subscriber);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const onAbort = (): void => finish(abortedOperation());
      const receive = ({ done, value }: IteratorResult<SourceControlView>): void => {
        if (done) {
          finish(streamFailure ?? abortedOperation());
          return;
        }
        if (value.generation > generation) {
          finish();
          return;
        }
        subscriber.pending = receive;
      };
      subscriber.pending = receive;
      subscribers.add(subscriber);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (latestSnapshot && latestSnapshot.generation > generation) {
        finish();
      } else if (streamFailure) {
        finish(streamFailure);
      }
    });
  };

  const changes = (signal: AbortSignal): AsyncIterable<SourceControlView> => ({
    [Symbol.asyncIterator]: () => {
      const subscriber: SourceSnapshotSubscriber = {
        closed: false,
        pending: undefined,
        queue: latestSnapshot === undefined ? [] : [latestSnapshot],
      };
      subscribers.add(subscriber);
      const closeSubscription = (): void => closeSubscriber(subscriber);
      signal.addEventListener('abort', closeSubscription, { once: true });
      return {
        next: () => {
          const snapshot = subscriber.queue.shift();
          if (snapshot) {
            return Promise.resolve({ done: false as const, value: snapshot });
          }
          if (subscriber.closed || signal.aborted) {
            return Promise.resolve({ done: true as const, value: undefined });
          }
          return new Promise<IteratorResult<SourceControlView>>((resolve) => {
            subscriber.pending = resolve;
          });
        },
        return: () => {
          signal.removeEventListener('abort', closeSubscription);
          closeSubscription();
          return Promise.resolve({ done: true as const, value: undefined });
        },
      };
    },
  });

  return {
    beginDisposal: () => {
      disposing = true;
    },
    changes,
    close,
    completionGeneration: (sourceId) => sourceCompletionGenerations.get(sourceId) ?? 0,
    completionGenerations: () => new Map(sourceCompletionGenerations),
    failStream,
    latest: () => latestSnapshot,
    publish,
    waitForNext,
  };
};
