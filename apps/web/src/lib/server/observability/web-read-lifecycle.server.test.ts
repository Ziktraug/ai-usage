import { describe, expect, it } from 'bun:test';
import type { WebReadObservabilityRuntime } from '../../../server/web-read-observability.server';
import { createWebReadObservabilityLifecycle } from './web-read-lifecycle.server';

const runtimeFixture = (dispose: () => void): WebReadObservabilityRuntime => ({
  dispose: () => {
    dispose();
    return Promise.resolve();
  },
  runEffect: () => Promise.reject(new Error('not used by lifecycle fixture')),
});

describe('SvelteKit web read observability lifecycle', () => {
  it('shares one initialization and tears the runtime down once', async () => {
    let acquisitions = 0;
    let disposals = 0;
    const lifecycle = createWebReadObservabilityLifecycle(() => {
      acquisitions += 1;
      return Promise.resolve(runtimeFixture(() => (disposals += 1)));
    });

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
    const lifecycle = createWebReadObservabilityLifecycle(() => pending.promise);
    const initialization = lifecycle.initialize();
    const shutdown = lifecycle.dispose();

    pending.resolve(runtimeFixture(() => (disposals += 1)));
    await expect(initialization).rejects.toThrow('stopped during initialization');
    await shutdown;
    expect(disposals).toBe(1);
  });
});
