#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { makeAiUsageWideEventResource } from '@ai-usage/effect-runtime';
import { makeCliWideEventSinkLayer } from '@ai-usage/effect-runtime/node';
import { Effect, Layer } from 'effect';
import { runnableApp } from './app';
import { createCliRuntimeLayer } from './runtime';

if (import.meta.main) {
  const abortController = new AbortController();
  let signalExitCode = 0;
  const forwardSignal = (signal: NodeJS.Signals): void => {
    signalExitCode = signal === 'SIGINT' ? 130 : 143;
    abortController.abort(new DOMException(`CLI received ${signal}`, 'AbortError'));
  };
  process.once('SIGINT', forwardSignal);
  process.once('SIGTERM', forwardSignal);

  const runnable = runnableApp.pipe(
    Effect.provide(
      Layer.mergeAll(
        createCliRuntimeLayer({ signal: abortController.signal }),
        makeCliWideEventSinkLayer({
          resource: makeAiUsageWideEventResource({
            instanceId: randomUUID(),
            nodeEnvironment: process.env.NODE_ENV,
            surface: 'cli',
          }),
        }),
      ),
    ),
  );

  const code = await Effect.runPromise(runnable);
  process.removeListener('SIGINT', forwardSignal);
  process.removeListener('SIGTERM', forwardSignal);
  const finalCode = signalExitCode || code;
  if (finalCode !== 0) {
    process.exit(finalCode);
  }
}
