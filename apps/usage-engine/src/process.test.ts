import { describe, expect, test } from 'bun:test';
import {
  parseUsageEngineCommandRequest,
  parseUsageEngineForegroundOutcome,
  parseUsageEngineStatus,
  USAGE_ENGINE_PROTOCOL_VERSION,
  type UsageEngineCommandCompletion,
  type UsageEngineEvent,
} from '@ai-usage/usage-engine-control';
import { createUsageEngineBearerToken } from '@ai-usage/usage-engine-control/node';
import type { UsageEngineRuntimeHost } from '@ai-usage/usage-engine-runtime';
import { createInitialUsageEngineSourceControlView } from '@ai-usage/usage-engine-runtime';
import {
  createUsageEngineProcess,
  type UsageEngineCheckReport,
  type UsageEngineProcessDependencies,
  type UsageEngineProcessPaths,
  type UsageEngineTerminationSignal,
} from './process';

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = createUsageEngineBearerToken('a'.repeat(43));
const NOW = '2026-07-29T12:00:00.000Z';
const paths: UsageEngineProcessPaths = {
  configCwd: '/synthetic/config',
  databasePath: '/synthetic/store.sqlite',
  homeDirectory: '/synthetic/home',
  inboxDirectory: '/synthetic/inbox',
  logDirectory: '/synthetic/logs',
  operatorCwd: '/synthetic/operator',
  stateDirectory: '/synthetic/state',
  temporaryRoot: '/synthetic/tmp',
};

const deferred = <Value>() => {
  let resolve: ((value: Value | PromiseLike<Value>) => void) | undefined;
  const promise = new Promise<Value>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve: (value: Value) => resolve?.(value) };
};

const completion: UsageEngineCommandCompletion = {
  command: 'publish',
  commandId: 'command-1' as UsageEngineCommandCompletion['commandId'],
  completedAt: NOW,
  output: { kind: 'none' },
  state: 'succeeded',
};

const createRuntime = (trace: string[], overrides: Partial<UsageEngineRuntimeHost> = {}): UsageEngineRuntimeHost => ({
  changes: () => ({
    [Symbol.asyncIterator]: (): AsyncIterator<UsageEngineEvent> => ({
      next: () => Promise.resolve({ done: true, value: undefined }),
    }),
  }),
  dispose: () => {
    trace.push('runtime-dispose');
    return Promise.resolve();
  },
  disposeRetainingWriterLease: () => {
    trace.push('runtime-retain-dispose');
    return Promise.resolve();
  },
  execute: async (command) => await createRuntime(trace).executeCommand(command, 'generated-command'),
  executeCommand: (_command, commandId) => {
    trace.push(`execute:${commandId}`);
    return Promise.resolve({
      admission: 'accepted' as const,
      commandId: commandId as typeof completion.commandId,
      instanceId: INSTANCE_ID as ReturnType<typeof parseUsageEngineStatus>['instanceId'],
      ok: true as const,
      protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    });
  },
  start: () => {
    trace.push('runtime-start');
    return Promise.resolve();
  },
  status: () =>
    Promise.resolve(
      parseUsageEngineStatus({
        currentPublication: null,
        degradedReason: null,
        generatedAt: NOW,
        generation: 1,
        instanceId: INSTANCE_ID,
        protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
        readiness: 'ready',
        sourceControl: createInitialUsageEngineSourceControlView(INSTANCE_ID, new Date(NOW)),
        storeSchemaVersion: 14,
      }),
    ),
  waitForCommand: (commandId) => {
    trace.push(`wait:${commandId}`);
    return Promise.resolve(completion);
  },
  waitForIdle: () => Promise.resolve(),
  ...overrides,
});

const checkReport: UsageEngineCheckReport = {
  lock: { state: 'absent' },
  ok: true,
  rendezvous: { state: 'absent' },
  store: { machineFleetGeneration: 0, state: 'compatible', usageStoreGeneration: 0 },
};

const createDependencies = (
  trace: string[],
  output: string[],
  overrides: Partial<UsageEngineProcessDependencies> = {},
): UsageEngineProcessDependencies => ({
  check: () => Promise.resolve(checkReport),
  createInstanceId: () => INSTANCE_ID,
  createRuntime: () => createRuntime(trace),
  createToken: () => TOKEN,
  publishRendezvous: ({ port, token }) => {
    trace.push(`rendezvous:${port}:${token === TOKEN}`);
    return Promise.resolve({
      instanceId: INSTANCE_ID as never,
      path: '/synthetic/state/rendezvous.json',
      port,
      remove: () => {
        trace.push('rendezvous-remove');
        return Promise.resolve();
      },
      token,
    });
  },
  startControlServer: ({ hostname, port, token }) => {
    trace.push(`server:${hostname}:${port}:${token === TOKEN}`);
    return Promise.resolve({
      dispose: () => {
        trace.push('server-dispose');
        return Promise.resolve();
      },
      hostname: '127.0.0.1' as const,
      port: 41_052,
    });
  },
  writeOutput: (line) => output.push(line),
  ...overrides,
});

describe('usage engine process lifecycle', () => {
  test('serves after runtime startup and cleans rendezvous, server, then runtime on signal', async () => {
    const trace: string[] = [];
    const output: string[] = [];
    const termination = deferred<UsageEngineTerminationSignal>();
    const ready = deferred<void>();
    const dependencies = createDependencies(trace, output, {
      publishRendezvous: async (input) => {
        const publication = await createDependencies(trace, output).publishRendezvous(input);
        ready.resolve();
        return publication;
      },
    });
    const processHost = createUsageEngineProcess(dependencies);
    const running = processHost.run({ mode: { mode: 'serve', port: 0 }, paths, termination: termination.promise });

    await ready.promise;
    termination.resolve('SIGTERM');

    await expect(running).resolves.toBe(0);
    expect(trace).toEqual([
      'runtime-start',
      'server:127.0.0.1:0:true',
      'rendezvous:41052:true',
      'rendezvous-remove',
      'server-dispose',
      'runtime-dispose',
    ]);
    expect(output).toEqual([]);
  });

  test('does not start later serve phases when termination wins runtime startup', async () => {
    const trace: string[] = [];
    const output: string[] = [];
    const termination = deferred<UsageEngineTerminationSignal>();
    const startup = deferred<void>();
    const runtime = createRuntime(trace, {
      start: async () => {
        trace.push('runtime-start');
        await startup.promise;
      },
    });
    const processHost = createUsageEngineProcess(createDependencies(trace, output, { createRuntime: () => runtime }));
    const running = processHost.run({ mode: { mode: 'serve', port: 0 }, paths, termination: termination.promise });
    await Promise.resolve();
    termination.resolve('SIGINT');
    startup.resolve();

    await expect(running).resolves.toBe(0);
    expect(trace).toEqual(['runtime-start', 'runtime-dispose']);
  });

  test('retains the writer lease when rendezvous removal cannot be proven', async () => {
    const trace: string[] = [];
    const output: string[] = [];
    const termination = deferred<UsageEngineTerminationSignal>();
    const ready = deferred<void>();
    const dependencies = createDependencies(trace, output, {
      publishRendezvous: async (input) => {
        const rendezvous = await createDependencies(trace, output).publishRendezvous(input);
        ready.resolve();
        return {
          ...rendezvous,
          remove: () => {
            trace.push('rendezvous-remove-failed');
            return Promise.reject(new Error('injected rendezvous removal failure'));
          },
        };
      },
    });
    const running = createUsageEngineProcess(dependencies).run({
      mode: { mode: 'serve', port: 0 },
      paths,
      termination: termination.promise,
    });
    await ready.promise;
    termination.resolve('SIGTERM');

    await expect(running).rejects.toThrow('could not clean up every owned resource');
    expect(trace).toContain('runtime-retain-dispose');
    expect(trace).not.toContain('runtime-dispose');
  });

  test('releases the writer lease when control server startup rejects', async () => {
    const trace: string[] = [];
    const output: string[] = [];
    const processHost = createUsageEngineProcess(
      createDependencies(trace, output, {
        startControlServer: () => {
          trace.push('server-start-failed');
          return Promise.reject(new Error('injected server startup failure'));
        },
      }),
    );

    await expect(
      processHost.run({ mode: { mode: 'serve', port: 0 }, paths, termination: new Promise(() => undefined) }),
    ).rejects.toThrow('injected server startup failure');
    expect(trace).toEqual(['runtime-start', 'server-start-failed', 'runtime-dispose']);
  });

  test('releases the writer lease when rendezvous publication rejects', async () => {
    const trace: string[] = [];
    const output: string[] = [];
    const processHost = createUsageEngineProcess(
      createDependencies(trace, output, {
        publishRendezvous: () => {
          trace.push('rendezvous-failed');
          return Promise.reject(new Error('injected rendezvous publication failure'));
        },
      }),
    );

    await expect(
      processHost.run({ mode: { mode: 'serve', port: 0 }, paths, termination: new Promise(() => undefined) }),
    ).rejects.toThrow('injected rendezvous publication failure');
    expect(trace).toEqual([
      'runtime-start',
      'server:127.0.0.1:0:true',
      'rendezvous-failed',
      'server-dispose',
      'runtime-dispose',
    ]);
  });

  test('does not wait forever for a non-cooperative server startup after forced termination', async () => {
    const trace: string[] = [];
    const output: string[] = [];
    const termination = deferred<UsageEngineTerminationSignal>();
    const forcedTermination = deferred<UsageEngineTerminationSignal>();
    const serverStarted = deferred<void>();
    const dependencies = createDependencies(trace, output, {
      startControlServer: () => {
        trace.push('server-start-pending');
        serverStarted.resolve();
        return new Promise(() => undefined);
      },
    });
    const running = createUsageEngineProcess(dependencies).run({
      forcedTermination: forcedTermination.promise,
      mode: { mode: 'serve', port: 0 },
      paths,
      termination: termination.promise,
    });
    await serverStarted.promise;
    termination.resolve('SIGTERM');
    forcedTermination.resolve('SIGTERM');

    await expect(running).resolves.toBe(0);
    expect(trace).toContain('runtime-retain-dispose');
  });

  test('does not wait forever for non-cooperative rendezvous removal after forced termination', async () => {
    const trace: string[] = [];
    const output: string[] = [];
    const termination = deferred<UsageEngineTerminationSignal>();
    const forcedTermination = deferred<UsageEngineTerminationSignal>();
    const ready = deferred<void>();
    const removalStarted = deferred<void>();
    const dependencies = createDependencies(trace, output, {
      publishRendezvous: async (input) => {
        const rendezvous = await createDependencies(trace, output).publishRendezvous(input);
        ready.resolve();
        return {
          ...rendezvous,
          remove: () => {
            trace.push('rendezvous-remove-pending');
            removalStarted.resolve();
            return new Promise(() => undefined);
          },
        };
      },
    });
    const running = createUsageEngineProcess(dependencies).run({
      forcedTermination: forcedTermination.promise,
      mode: { mode: 'serve', port: 0 },
      paths,
      termination: termination.promise,
    });
    await ready.promise;
    termination.resolve('SIGTERM');
    await removalStarted.promise;
    forcedTermination.resolve('SIGTERM');

    const outcome = await Promise.race([
      running.then((exitCode) => ({ exitCode, kind: 'completed' as const })),
      Bun.sleep(50).then(() => ({ kind: 'timed-out' as const })),
    ]);
    expect(outcome).toEqual({ exitCode: 0, kind: 'completed' });
    expect(trace).toContain('runtime-retain-dispose');
  });

  test('does not wait forever for non-cooperative server disposal after forced termination', async () => {
    const trace: string[] = [];
    const output: string[] = [];
    const termination = deferred<UsageEngineTerminationSignal>();
    const forcedTermination = deferred<UsageEngineTerminationSignal>();
    const ready = deferred<void>();
    const serverDisposalStarted = deferred<void>();
    const dependencies = createDependencies(trace, output, {
      publishRendezvous: async (input) => {
        const rendezvous = await createDependencies(trace, output).publishRendezvous(input);
        ready.resolve();
        return rendezvous;
      },
      startControlServer: () =>
        Promise.resolve({
          dispose: () => {
            trace.push('server-dispose-pending');
            serverDisposalStarted.resolve();
            return new Promise(() => undefined);
          },
          hostname: '127.0.0.1' as const,
          port: 41_052,
        }),
    });
    const running = createUsageEngineProcess(dependencies).run({
      forcedTermination: forcedTermination.promise,
      mode: { mode: 'serve', port: 0 },
      paths,
      termination: termination.promise,
    });
    await ready.promise;
    termination.resolve('SIGTERM');
    await serverDisposalStarted.promise;
    forcedTermination.resolve('SIGTERM');

    const outcome = await Promise.race([
      running.then((exitCode) => ({ exitCode, kind: 'completed' as const })),
      Bun.sleep(50).then(() => ({ kind: 'timed-out' as const })),
    ]);
    expect(outcome).toEqual({ exitCode: 0, kind: 'completed' });
    expect(trace).toContain('runtime-retain-dispose');
  });

  test('forces foreground disposal after a second signal', async () => {
    const trace: string[] = [];
    const output: string[] = [];
    const termination = deferred<UsageEngineTerminationSignal>();
    const forcedTermination = deferred<UsageEngineTerminationSignal>();
    const waiting = deferred<void>();
    const disposalStarted = deferred<void>();
    const runtime = createRuntime(trace, {
      dispose: () => {
        trace.push('runtime-dispose-pending');
        disposalStarted.resolve();
        return new Promise(() => undefined);
      },
      disposeRetainingWriterLease: () => {
        trace.push('runtime-retain-dispose');
        return Promise.resolve();
      },
      waitForCommand: () => {
        waiting.resolve();
        return new Promise(() => undefined);
      },
    });
    const request = parseUsageEngineCommandRequest({
      command: { command: 'publish' },
      commandId: 'command-1',
      protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    });
    const running = createUsageEngineProcess(createDependencies(trace, output, { createRuntime: () => runtime })).run({
      forcedTermination: forcedTermination.promise,
      mode: { mode: 'once', request },
      paths,
      termination: termination.promise,
    });
    await waiting.promise;
    termination.resolve('SIGTERM');
    await disposalStarted.promise;
    forcedTermination.resolve('SIGTERM');

    const outcome = await Promise.race([
      running.then((exitCode) => ({ exitCode, kind: 'completed' as const })),
      Bun.sleep(50).then(() => ({ kind: 'timed-out' as const })),
    ]);
    expect(outcome).toEqual({ exitCode: 143, kind: 'completed' });
    expect(trace).toContain('runtime-retain-dispose');
  });

  test('waits for the exact foreground completion and starts no control server or rendezvous', async () => {
    const trace: string[] = [];
    const output: string[] = [];
    const processHost = createUsageEngineProcess(createDependencies(trace, output));
    const request = parseUsageEngineCommandRequest({
      command: { command: 'publish' },
      commandId: 'command-1',
      protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    });

    await expect(
      processHost.run({ mode: { mode: 'once', request }, paths, termination: new Promise(() => undefined) }),
    ).resolves.toBe(0);

    expect(trace).toEqual(['runtime-start', 'execute:command-1', 'wait:command-1', 'runtime-dispose']);
    expect(parseUsageEngineForegroundOutcome(JSON.parse(output[0] ?? 'null'))).toMatchObject({
      completion: { commandId: 'command-1', state: 'succeeded' },
      kind: 'command-completed',
    });
  });

  test('constructs scheduled serve and bounded foreground runtimes explicitly', async () => {
    const trace: string[] = [];
    const output: string[] = [];
    const runtimeModes: string[] = [];
    const dependencies = createDependencies(trace, output, {
      createRuntime: (input) => {
        runtimeModes.push(input.collectionMode);
        return createRuntime(trace);
      },
    });
    const request = parseUsageEngineCommandRequest({
      command: { command: 'publish' },
      commandId: 'command-1',
      protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    });

    await createUsageEngineProcess(dependencies).run({
      mode: { mode: 'once', request },
      paths,
      termination: new Promise(() => undefined),
    });
    await createUsageEngineProcess(dependencies).run({
      mode: { mode: 'serve', port: 0 },
      paths,
      termination: Promise.resolve('SIGTERM'),
    });

    expect(runtimeModes).toEqual(['foreground', 'scheduled']);
  });

  test('runs check without constructing runtime, server, token, or rendezvous', async () => {
    const trace: string[] = [];
    const output: string[] = [];
    const processHost = createUsageEngineProcess(
      createDependencies(trace, output, {
        check: (actualPaths) => {
          expect(actualPaths).toEqual(paths);
          trace.push('check');
          return Promise.resolve(checkReport);
        },
        createRuntime: () => {
          throw new Error('check constructed the runtime');
        },
        createToken: () => {
          throw new Error('check created a token');
        },
      }),
    );

    await expect(
      processHost.run({ mode: { mode: 'check' }, paths, termination: new Promise(() => undefined) }),
    ).resolves.toBe(0);
    expect(trace).toEqual(['check']);
    expect(JSON.parse(output[0] ?? 'null')).toEqual(checkReport);
  });
});
