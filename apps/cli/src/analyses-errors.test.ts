import { expect, test } from 'bun:test';
import { makeTestWideEventSinkLayer, noopWideEventSink } from '@ai-usage/effect-runtime';
import { createMemoryServiceClient, MemoryServiceClientError } from '@ai-usage/memory-service/client';
import { Console, Effect } from 'effect';
import { runnableApp } from './app';
import { CliRuntime } from './runtime';
import { withCliSandbox } from './test-support/run-cli';

for (const code of [
  'worker-busy',
  'lease-expired',
  'conflict',
  'forbidden',
  'source-modified',
  'version-incompatible',
  'cancelled',
  'storage-unavailable',
] as const) {
  test(`analyses CLI preserves ${code} as sanitized JSON without replaying the mutation`, async () => {
    const stderr: unknown[] = [];
    let mutations = 0;
    const memory = createMemoryServiceClient({ resolveRendezvous: () => Promise.reject(new Error('unused')) });
    const runtime: CliRuntime = {
      argv: ['analyses', 'cancel', '--project', 'p', '--job', 'job'],
      paths: {
        configCwd: '/synthetic',
        databasePath: '/synthetic/usage.sqlite',
        homeDirectory: '/synthetic',
        operatorCwd: '/synthetic',
        stateDirectory: '/synthetic/state',
        temporaryRoot: '/synthetic/tmp',
      },
      signal: AbortSignal.timeout(1000),
      stdoutIsTTY: false,
      memory: {
        ...memory,
        distillation: () => {
          mutations += 1;
          return Promise.reject(new MemoryServiceClientError(code, 'Secret body /private/history bearer-token'));
        },
      },
      usageEngine: { execute: () => Promise.reject(new Error('must not start an engine')) },
    };
    const exit = await Effect.runPromise(
      Console.consoleWith((console) =>
        Console.withConsole(runnableApp, {
          ...console,
          error: (message: unknown) =>
            Effect.sync(() => {
              stderr.push(message);
            }),
        }),
      ).pipe(Effect.provideService(CliRuntime, runtime), Effect.provide(makeTestWideEventSinkLayer(noopWideEventSink))),
    );
    expect(exit).toBe(1);
    expect(mutations).toBe(1);
    expect(stderr).toHaveLength(1);
    expect(JSON.parse(String(stderr[0]))).toEqual({ error: { code } });
    expect(String(stderr[0])).not.toContain('private');
    expect(String(stderr[0])).not.toContain('bearer-token');
  });
}

test('actual isolated CLI writes a service error as JSON on stderr with no successful stdout', async () => {
  await withCliSandbox(async ({ runCli }) => {
    const result = await runCli(['analyses', 'projects']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ error: { code: 'service-unavailable' } });
  });
});
