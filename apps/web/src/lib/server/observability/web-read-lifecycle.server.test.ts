import { describe, expect, it } from 'bun:test';
import { makeCaptureWideEventSink, makeTestWideEventSinkLayer } from '@ai-usage/effect-runtime';
import { Effect } from 'effect';
import { runWebReadEffect, type WebReadObservabilityRuntime } from '../../../server/web-read-observability.server';
import { createWebReadObservabilityLifecycle } from './web-read-lifecycle.server';
import { createWebReadObservabilityRuntimeRegistry } from './web-read-runtime-registry.server';

const runtimeFixture = (dispose: () => void): WebReadObservabilityRuntime => {
  const layer = makeTestWideEventSinkLayer(makeCaptureWideEventSink());
  return {
    dispose: () => {
      dispose();
      return Promise.resolve();
    },
    runEffect: (effect, options) =>
      Effect.runPromise(
        effect.pipe(Effect.provide(layer)),
        options?.signal === undefined ? undefined : { signal: options.signal },
      ),
  };
};

describe('SvelteKit web read observability lifecycle', () => {
  it('shares one initialization and tears the runtime down once', async () => {
    let acquisitions = 0;
    let disposals = 0;
    const lifecycle = createWebReadObservabilityLifecycle(() => {
      acquisitions += 1;
      return Promise.resolve(runtimeFixture(() => (disposals += 1)));
    }, createWebReadObservabilityRuntimeRegistry());

    const [first, second] = await Promise.all([lifecycle.initialize(), lifecycle.initialize()]);
    expect(first).toBe(second);
    expect(acquisitions).toBe(1);
    await Promise.all([lifecycle.dispose(), lifecycle.dispose()]);
    expect(disposals).toBe(1);
    await expect(lifecycle.initialize()).rejects.toThrow('has stopped');
  });

  it('disposes an initialization that succeeds after shutdown', async () => {
    const pending = Promise.withResolvers<WebReadObservabilityRuntime>();
    let disposals = 0;
    const lifecycle = createWebReadObservabilityLifecycle(
      () => pending.promise,
      createWebReadObservabilityRuntimeRegistry(),
    );
    const initialization = lifecycle.initialize();
    const shutdown = lifecycle.dispose();

    pending.resolve(runtimeFixture(() => (disposals += 1)));
    await expect(initialization).rejects.toThrow('stopped during initialization');
    await shutdown;
    expect(disposals).toBe(1);
  });

  it('registers the initialized runtime for revision effects and removes it on teardown', async () => {
    const lifecycle = createWebReadObservabilityLifecycle(() => Promise.resolve(runtimeFixture(() => undefined)));

    await lifecycle.initialize();
    expect(await runWebReadEffect(Effect.succeed('registered'))).toBe('registered');
    await lifecycle.dispose();
    await expect(runWebReadEffect(Effect.succeed('late'))).rejects.toThrow('has not started');
  });
});
