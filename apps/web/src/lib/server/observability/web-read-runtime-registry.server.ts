import type { WideEventResourceService, WideEventSink } from '@ai-usage/effect-runtime';
import type { Effect } from 'effect';

type WebReadServices = WideEventResourceService | WideEventSink;

export interface WebReadObservabilityRuntime {
  readonly dispose: () => Promise<void>;
  readonly runEffect: <Value, Failure>(
    effect: Effect.Effect<Value, Failure, WebReadServices>,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<Value>;
}

export interface WebReadObservabilityRuntimeRegistry {
  readonly install: (runtime: WebReadObservabilityRuntime) => WebReadObservabilityRuntime;
  readonly remove: (runtime: WebReadObservabilityRuntime) => void;
  readonly runEffect: WebReadObservabilityRuntime['runEffect'];
}

export const createWebReadObservabilityRuntimeRegistry = (): WebReadObservabilityRuntimeRegistry => {
  let activeRuntime: WebReadObservabilityRuntime | undefined;

  return {
    install: (runtime) => {
      activeRuntime ??= runtime;
      return activeRuntime;
    },
    remove: (runtime) => {
      if (activeRuntime === runtime) {
        activeRuntime = undefined;
      }
    },
    runEffect: (effect, options) => {
      if (!activeRuntime) {
        return Promise.reject(new Error('Web read observability has not started.'));
      }
      return activeRuntime.runEffect(effect, options);
    },
  };
};

/** One framework-neutral runtime slot owned by the SvelteKit server lifecycle. */
export const webReadObservabilityRuntimeRegistry = createWebReadObservabilityRuntimeRegistry();
