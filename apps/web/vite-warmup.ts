export const createRetryableWarmup = (warmup: () => Promise<void>): (() => Promise<void>) => {
  let warmupPromise: Promise<void> | undefined;

  return () => {
    warmupPromise ??= Promise.resolve()
      .then(warmup)
      .catch((error: unknown) => {
        warmupPromise = undefined;
        throw error;
      });
    return warmupPromise;
  };
};
