export interface RetryFailure {
  readonly cause: unknown;
}

export interface RetryController {
  readonly cancel: () => void;
  readonly dispose: () => void;
  readonly pending: () => boolean;
  readonly run: () => Promise<void>;
}

export const createRetryController = (dependencies: {
  readonly onFailure?: (failure: RetryFailure) => void;
  readonly retry: (signal: AbortSignal) => Promise<void>;
}): RetryController => {
  let active: { readonly abort: AbortController; readonly generation: number; promise: Promise<void> } | undefined;
  let disposed = false;
  let generation = 0;
  const cancel = (): void => {
    generation += 1;
    active?.abort.abort();
    active = undefined;
  };
  const clearActive = (runGeneration: number): void => {
    if (active?.generation === runGeneration) {
      active = undefined;
    }
  };
  const run = (): Promise<void> => {
    if (disposed) {
      return Promise.reject(new Error('Retry controller is disposed.'));
    }
    if (active) {
      return active.promise;
    }
    const abort = new AbortController();
    const runGeneration = ++generation;
    const runState = { abort, generation: runGeneration, promise: Promise.resolve() };
    active = runState;
    runState.promise = (async () => {
      try {
        await dependencies.retry(abort.signal);
      } catch (cause) {
        if (!(disposed || abort.signal.aborted)) {
          dependencies.onFailure?.({ cause });
        }
        throw cause;
      } finally {
        clearActive(runGeneration);
      }
    })();
    return runState.promise;
  };
  return {
    cancel,
    dispose: () => {
      if (!disposed) {
        disposed = true;
        cancel();
      }
    },
    pending: () => active !== undefined,
    run,
  };
};
