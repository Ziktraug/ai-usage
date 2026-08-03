import type { WebReadObservabilityRuntime } from '../../../server/web-read-observability.server';

export type WebReadRuntimeFactory = () => Promise<WebReadObservabilityRuntime>;

export interface WebReadObservabilityLifecycle {
  dispose(): Promise<void>;
  initialize(): Promise<WebReadObservabilityRuntime>;
}

const defaultFactory: WebReadRuntimeFactory = async () => {
  const { createWebReadObservabilityRuntime } = await import('../../../server/web-read-observability.server');
  return await createWebReadObservabilityRuntime();
};

/**
 * SvelteKit lifecycle owner. The Effect scope, sink and bounded projection stay
 * in the existing observability runtime; this leaf only serializes acquisition
 * and makes shutdown idempotent, including initialization that settles late.
 */
export const createWebReadObservabilityLifecycle = (
  createRuntime: WebReadRuntimeFactory = defaultFactory,
): WebReadObservabilityLifecycle => {
  let runtimePromise: Promise<WebReadObservabilityRuntime> | undefined;
  let disposal: Promise<void> | undefined;
  let stopped = false;

  const initialize = (): Promise<WebReadObservabilityRuntime> => {
    if (stopped) {
      return Promise.reject(new Error('Web read observability lifecycle has stopped.'));
    }
    runtimePromise ??= createRuntime().then(async (runtime) => {
      if (stopped) {
        await runtime.dispose();
        throw new Error('Web read observability lifecycle stopped during initialization.');
      }
      return runtime;
    });
    return runtimePromise;
  };

  const dispose = (): Promise<void> => {
    stopped = true;
    disposal ??= runtimePromise
      ? runtimePromise.then(
          async (runtime) => await runtime.dispose(),
          () => undefined,
        )
      : Promise.resolve();
    return disposal;
  };

  return { dispose, initialize };
};

/** Process-wide SvelteKit owner. hooks.server is the only integration caller. */
export const webReadObservabilityLifecycle = createWebReadObservabilityLifecycle();
