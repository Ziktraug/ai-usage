export interface SessionQueryOperationContext {
  isCurrent: () => boolean;
  owns: () => boolean;
  release: () => boolean;
  readonly signal: AbortSignal;
}

export interface SessionQueryPreparedTicket {
  generation: number;
  requestId: number;
}

export type SessionQueryOperationPolicy = 'coalesce' | 'replace';

export interface SessionQueryRunOptions {
  generation?: number;
  policy?: SessionQueryOperationPolicy;
}

export interface SessionQueryOperationOwner {
  beginGeneration: () => number;
  canCommit: (ticket: SessionQueryPreparedTicket) => boolean;
  close: () => void;
  isClosed: () => boolean;
  prepareTicket: () => SessionQueryPreparedTicket;
  run: <Result>(
    key: string,
    execute: (context: SessionQueryOperationContext) => Promise<Result>,
    options?: SessionQueryRunOptions,
  ) => Promise<Result>;
}

interface OwnedSessionQueryOperation {
  controller: AbortController;
  generation: number;
  id: number;
  promise: Promise<unknown>;
}

export const createSessionQueryOperationOwner = (): SessionQueryOperationOwner => {
  let closed = false;
  let generation = 0;
  let operationId = 0;
  let preparedRequestId = 0;
  const activeOperations = new Map<string, OwnedSessionQueryOperation>();

  const isCurrent = (operation: OwnedSessionQueryOperation): boolean =>
    !(closed || operation.controller.signal.aborted) && operation.generation === generation;

  const owns = (key: string, operation: OwnedSessionQueryOperation): boolean =>
    isCurrent(operation) && activeOperations.get(key)?.id === operation.id;

  const release = (key: string, operation: OwnedSessionQueryOperation): boolean => {
    if (activeOperations.get(key)?.id !== operation.id) {
      return false;
    }
    activeOperations.delete(key);
    return true;
  };

  const cancelAll = (): void => {
    const operations = [...activeOperations.values()];
    activeOperations.clear();
    for (const operation of operations) {
      operation.controller.abort();
    }
  };

  const beginGeneration = (): number => {
    generation += 1;
    preparedRequestId += 1;
    cancelAll();
    return generation;
  };

  const run = <Result>(
    key: string,
    execute: (context: SessionQueryOperationContext) => Promise<Result>,
    options: SessionQueryRunOptions = {},
  ): Promise<Result> => {
    if (closed) {
      return Promise.reject(new DOMException('The session query operation owner is closed', 'AbortError'));
    }
    const existing = activeOperations.get(key);
    if (options.policy === 'coalesce' && existing && owns(key, existing)) {
      return existing.promise as Promise<Result>;
    }

    const controller = new AbortController();
    const deferred = Promise.withResolvers<Result>();
    const operation: OwnedSessionQueryOperation = {
      controller,
      generation: options.generation ?? generation,
      id: ++operationId,
      promise: deferred.promise,
    };
    activeOperations.set(key, operation);
    const context: SessionQueryOperationContext = {
      isCurrent: () => isCurrent(operation),
      owns: () => owns(key, operation),
      release: () => release(key, operation),
      signal: controller.signal,
    };
    const settle = async (): Promise<void> => {
      try {
        deferred.resolve(await execute(context));
      } catch (error) {
        deferred.reject(error);
      } finally {
        context.release();
      }
    };
    settle();
    existing?.controller.abort();
    return deferred.promise;
  };

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    generation += 1;
    preparedRequestId += 1;
    cancelAll();
  };

  return {
    beginGeneration,
    canCommit: (ticket) => !closed && ticket.generation === generation && ticket.requestId === preparedRequestId,
    close,
    isClosed: () => closed,
    prepareTicket: () => ({
      generation,
      requestId: ++preparedRequestId,
    }),
    run,
  };
};
