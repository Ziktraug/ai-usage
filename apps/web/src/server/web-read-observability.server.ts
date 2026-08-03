import { randomUUID } from 'node:crypto';
import {
  makeAiUsageWideEventResource,
  type WideEventResourceService,
  type WideEventSink,
} from '@ai-usage/effect-runtime';
import { makeSilentWideEventSinkLayer, makeWebWideEventSinkLayer } from '@ai-usage/effect-runtime/node';
import { Effect, Exit, Layer, Scope } from 'effect';
import { useNitroApp } from 'nitro/app';
import { getServerRuntimeMode } from './runtime-mode.server';
import { projectWebWideEvent } from './wide-event-presentation.server';

type WebReadServices = WideEventResourceService | WideEventSink;

export interface WebReadObservabilityRuntime {
  readonly dispose: () => Promise<void>;
  readonly runEffect: <Value, Failure>(
    effect: Effect.Effect<Value, Failure, WebReadServices>,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<Value>;
}

const webReadRuntimeProperty = '__aiUsageWebReadObservabilityRuntime' as const;

type WebReadNitroApp = ReturnType<typeof useNitroApp> & {
  [webReadRuntimeProperty]?: WebReadObservabilityRuntime;
};

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

export const installWebReadObservabilityRuntime = (
  nitroAppValue: ReturnType<typeof useNitroApp>,
  runtime: WebReadObservabilityRuntime,
): WebReadObservabilityRuntime => {
  const nitroApp = nitroAppValue as WebReadNitroApp;
  const existing = nitroApp[webReadRuntimeProperty];
  if (existing) {
    return existing;
  }
  if (!nitroApp.hooks) {
    throw new Error('Nitro hooks are unavailable for web read observability.');
  }
  nitroApp[webReadRuntimeProperty] = runtime;
  nitroApp.hooks.hook('close', async () => {
    await runtime.dispose();
    if (nitroApp[webReadRuntimeProperty] === runtime) {
      delete nitroApp[webReadRuntimeProperty];
    }
  });
  return runtime;
};

export const initializeWebReadObservabilityRuntime = async (
  nitroAppValue: ReturnType<typeof useNitroApp>,
): Promise<WebReadObservabilityRuntime> => {
  const nitroApp = nitroAppValue as WebReadNitroApp;
  const existing = nitroApp[webReadRuntimeProperty];
  if (existing) {
    return existing;
  }
  const runtime = await createWebReadObservabilityRuntime();
  const installed = installWebReadObservabilityRuntime(nitroAppValue, runtime);
  if (installed !== runtime) {
    await runtime.dispose();
  }
  return installed;
};

export const runWebReadEffect = <Value, Failure>(
  effect: Effect.Effect<Value, Failure, WebReadServices>,
  options?: { readonly signal?: AbortSignal },
): Promise<Value> => {
  const runtime = (useNitroApp() as WebReadNitroApp)[webReadRuntimeProperty];
  if (!runtime) {
    return Promise.reject(new Error('Web read observability has not started.'));
  }
  return runtime.runEffect(effect, options);
};
