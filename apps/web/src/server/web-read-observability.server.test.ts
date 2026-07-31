import { expect, test } from 'bun:test';
import { makeAiUsageWideEventResource, WideEventResourceService, WideEventSink } from '@ai-usage/effect-runtime';
import { Effect, Layer } from 'effect';
import { createWebReadObservabilityRuntime } from './web-read-observability.server';

test('acquires one web event sink for all reads and releases it once at shutdown', async () => {
  let acquisitions = 0;
  let releases = 0;
  const sinkLayer = Layer.scoped(
    WideEventSink,
    Effect.acquireRelease(
      Effect.sync(() => {
        acquisitions += 1;
        return {
          diagnostics: () => Effect.succeed({ accepted: 0, dropped: 0, failed: 0 }),
          submit: () => Effect.void,
        };
      }),
      () =>
        Effect.sync(() => {
          releases += 1;
        }),
    ),
  );
  const resourceLayer = Layer.succeed(
    WideEventResourceService,
    makeAiUsageWideEventResource({ instanceId: 'web-read-test', nodeEnvironment: 'test', surface: 'web' }),
  );
  const runtime = await createWebReadObservabilityRuntime(Layer.merge(sinkLayer, resourceLayer));

  expect(await runtime.runEffect(WideEventSink.pipe(Effect.map(() => 'first')))).toBe('first');
  expect(await runtime.runEffect(WideEventResourceService.pipe(Effect.map(() => 'second')))).toBe('second');
  expect(acquisitions).toBe(1);
  expect(releases).toBe(0);

  await Promise.all([runtime.dispose(), runtime.dispose()]);

  expect(releases).toBe(1);
  await expect(runtime.runEffect(Effect.succeed('late'))).rejects.toThrow(
    'Web read observability has already stopped.',
  );
});
