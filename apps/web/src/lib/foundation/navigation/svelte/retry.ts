export interface RetryFailure {
  readonly cause: unknown;
}

export interface RetryController {
  readonly pending: () => boolean;
  readonly run: () => Promise<void>;
}

export const createRetryController = (dependencies: {
  readonly onFailure?: (failure: RetryFailure) => void;
  readonly retry: () => Promise<void>;
}): RetryController => {
  let pending: Promise<void> | undefined;
  const run = (): Promise<void> => {
    if (pending) {
      return pending;
    }
    pending = (async () => {
      try {
        await dependencies.retry();
      } catch (cause) {
        dependencies.onFailure?.({ cause });
        throw cause;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
  return { pending: () => pending !== undefined, run };
};
