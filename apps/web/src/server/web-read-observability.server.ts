import { randomUUID } from 'node:crypto';
import {
  makeAiUsageWideEventResource,
  type WideEventResourceService,
  type WideEventSink,
} from '@ai-usage/effect-runtime';
import { makeSilentWideEventSinkLayer, makeWebWideEventSinkLayer } from '@ai-usage/effect-runtime/node';
import { Effect, Exit, Layer, Scope } from 'effect';
import {
  type WebReadObservabilityRuntime,
  webReadObservabilityRuntimeRegistry,
} from '../lib/server/observability/web-read-runtime-registry.server';
import { getServerRuntimeMode } from './runtime-mode.server';
import { projectWebWideEvent } from './wide-event-presentation.server';

type WebReadServices = WideEventResourceService | WideEventSink;

export type { WebReadObservabilityRuntime } from '../lib/server/observability/web-read-runtime-registry.server';

const makeWebReadSinkLayer = (): Layer.Layer<WebReadServices> => {
  const testRuntime = getServerRuntimeMode() === 'e2e';
  const resource = makeAiUsageWideEventResource({
    instanceId: randomUUID(),
    nodeEnvironment: process.env.NODE_ENV,
    surface: 'web',
    testRuntime,
  });
  return testRuntime
    ? makeSilentWideEventSinkLayer(resource)
    : makeWebWideEventSinkLayer({ projector: projectWebWideEvent, resource });
};

export const createWebReadObservabilityRuntime = async (
  layer: Layer.Layer<WebReadServices> = makeWebReadSinkLayer(),
): Promise<WebReadObservabilityRuntime> => {
  const scope = Effect.runSync(Scope.make());
  const context = await Effect.runPromise(Layer.buildWithScope(layer, scope)).catch(async (error: unknown) => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  });
  let disposal: Promise<void> | undefined;
  return {
    dispose: () => {
      disposal ??= Effect.runPromise(Scope.close(scope, Exit.void));
      return disposal;
    },
    runEffect: (effect, options) => {
      if (disposal) {
        return Promise.reject(new Error('Web read observability has already stopped.'));
      }
      return Effect.runPromise(
        effect.pipe(Effect.provide(context)),
        options?.signal === undefined ? undefined : { signal: options.signal },
      );
    },
  };
};

export const runWebReadEffect = <Value, Failure>(
  effect: Effect.Effect<Value, Failure, WebReadServices>,
  options?: { readonly signal?: AbortSignal },
): Promise<Value> => webReadObservabilityRuntimeRegistry.runEffect(effect, options);
