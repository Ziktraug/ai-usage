import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LocalIdentityKernel } from '@ai-usage/memory-sqlite/identity';
import type { UsageEngineRuntimeHost } from '@ai-usage/usage-engine-runtime';
import { acquireUsageEngineLock, UsageEngineWriterLockContendedError } from './engine-lock';
import {
  LocalMemoryRuntimeStartCancelledError,
  localMemoryIdentityDatabasePath,
  localMemoryIdentityLockPath,
  withLocalMemoryIdentityKernel,
} from './memory-identity-runtime';

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })));
});

const createStateDirectory = async (): Promise<string> => {
  // mkdtemp creates the directory owner-only (0700), which is what the lock requires.
  const fixture = await mkdtemp(path.join(tmpdir(), 'ai-usage-memory-lease-'));
  fixtures.push(fixture);
  return fixture;
};

const emptyChanges = (): AsyncIterable<never> => ({
  [Symbol.asyncIterator]: (): AsyncIterator<never> => ({
    next: () => Promise.resolve({ done: true, value: undefined as never }),
  }),
});

const deferred = <Value>() => {
  let resolve: ((value: Value | PromiseLike<Value>) => void) | undefined;
  const promise = new Promise<Value>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve: (value: Value) => resolve?.(value) };
};

/** Lets every already-runnable continuation run without advancing any gated promise. */
const settle = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

const fakeRuntime = (events: string[], overrides: Partial<UsageEngineRuntimeHost> = {}): UsageEngineRuntimeHost => ({
  cancelCommand: () => Promise.reject(new Error('unused')),
  changes: emptyChanges,
  dispose: () => {
    events.push('runtime-dispose');
    return Promise.resolve();
  },
  disposeRetainingWriterLease: () => {
    events.push('runtime-dispose-retaining-lease');
    return Promise.resolve();
  },
  execute: () => Promise.reject(new Error('unused')),
  executeCommand: () => Promise.reject(new Error('unused')),
  start: () => {
    events.push('runtime-start');
    return Promise.resolve();
  },
  status: () => Promise.reject(new Error('unused')),
  waitForCommand: () => Promise.reject(new Error('unused')),
  waitForIdle: () => Promise.reject(new Error('unused')),
  ...overrides,
});

const fakeKernel = (events: string[]): LocalIdentityKernel =>
  ({
    close: () => {
      events.push('memory-close');
      return Promise.resolve();
    },
  }) as LocalIdentityKernel;

const fakeLease = (events: string[]) => () => {
  events.push('memory-lease-acquire');
  return Promise.resolve({
    release: () => {
      events.push('memory-lease-release');
      return Promise.resolve();
    },
  });
};

describe('usage-engine local Memory identity ownership', () => {
  test('opens only after the Usage writer lease is established and closes before releasing it', async () => {
    const events: string[] = [];
    const runtime = withLocalMemoryIdentityKernel(fakeRuntime(events), '/state/memory.sqlite', {
      openKernel: (options) => {
        events.push(`memory-open:${options.databasePath}`);
        return Promise.resolve(fakeKernel(events));
      },
      startService: () => {
        events.push('memory-service-start');
        return Promise.resolve({
          dispose: () => {
            events.push('memory-service-dispose');
            return Promise.resolve();
          },
        });
      },
      startReplication: () => {
        events.push('replication-start');
        return Promise.resolve({
          dispose: () => {
            events.push('replication-dispose');
            return Promise.resolve();
          },
        });
      },
    });

    await runtime.start();
    await runtime.dispose();
    expect(events).toEqual([
      'runtime-start',
      'memory-open:/state/memory.sqlite',
      'memory-service-start',
      'replication-start',
      'replication-dispose',
      'memory-service-dispose',
      'memory-close',
      'runtime-dispose',
    ]);
  });

  test('holds the Memory writer lease from after Usage start until after the kernel closes', async () => {
    const events: string[] = [];
    const runtime = withLocalMemoryIdentityKernel(fakeRuntime(events), '/state/memory.sqlite', {
      acquireLease: fakeLease(events),
      openKernel: (options) => {
        events.push(`memory-open:${options.databasePath}`);
        return Promise.resolve(fakeKernel(events));
      },
      startService: () => {
        events.push('memory-service-start');
        return Promise.resolve({
          dispose: () => {
            events.push('memory-service-dispose');
            return Promise.resolve();
          },
        });
      },
    });

    await runtime.start();
    await runtime.dispose();
    expect(events).toEqual([
      'runtime-start',
      'memory-lease-acquire',
      'memory-open:/state/memory.sqlite',
      'memory-service-start',
      'memory-service-dispose',
      'memory-close',
      'memory-lease-release',
      'runtime-dispose',
    ]);
  });

  test('retains the Memory writer lease alongside the Usage lease on a retaining disposal', async () => {
    const events: string[] = [];
    const runtime = withLocalMemoryIdentityKernel(fakeRuntime(events), '/state/memory.sqlite', {
      acquireLease: fakeLease(events),
      openKernel: () => Promise.resolve(fakeKernel(events)),
    });

    await runtime.start();
    await runtime.disposeRetainingWriterLease();
    expect(events).toEqual([
      'runtime-start',
      'memory-lease-acquire',
      'memory-close',
      'runtime-dispose-retaining-lease',
    ]);
  });

  test('releases the Memory lease and the Usage writer when the Memory kernel fails to open', async () => {
    const events: string[] = [];
    const runtime = withLocalMemoryIdentityKernel(fakeRuntime(events), '/state/memory.sqlite', {
      acquireLease: fakeLease(events),
      openKernel: () => Promise.reject(new Error('memory failed')),
    });

    await expect(runtime.start()).rejects.toThrow('memory failed');
    expect(events).toEqual(['runtime-start', 'memory-lease-acquire', 'memory-lease-release', 'runtime-dispose']);
  });

  test('releases the Usage writer when the Memory lease is contended', async () => {
    const events: string[] = [];
    const runtime = withLocalMemoryIdentityKernel(fakeRuntime(events), '/state/memory.sqlite', {
      acquireLease: () => Promise.reject(new UsageEngineWriterLockContendedError('memory lock held')),
      openKernel: () => {
        events.push('memory-open');
        return Promise.resolve(fakeKernel(events));
      },
    });

    await expect(runtime.start()).rejects.toBeInstanceOf(UsageEngineWriterLockContendedError);
    expect(events).toEqual(['runtime-start', 'runtime-dispose']);
  });

  test('releases the Usage writer when Memory bootstrap fails', async () => {
    const events: string[] = [];
    const runtime = withLocalMemoryIdentityKernel(fakeRuntime(events), '/state/memory.sqlite', {
      openKernel: () => Promise.reject(new Error('memory failed')),
    });

    await expect(runtime.start()).rejects.toThrow('memory failed');
    expect(events).toEqual(['runtime-start', 'runtime-dispose']);
  });

  test('closes the Memory kernel and Usage writer when the Memory service fails to start', async () => {
    const events: string[] = [];
    const runtime = withLocalMemoryIdentityKernel(fakeRuntime(events), '/state/memory.sqlite', {
      openKernel: () => Promise.resolve(fakeKernel(events)),
      startService: () => Promise.reject(new Error('service failed')),
    });

    await expect(runtime.start()).rejects.toThrow('service failed');
    expect(events).toEqual(['runtime-start', 'memory-close', 'runtime-dispose']);
  });

  test('closes the local service and kernel when replication composition fails', async () => {
    const events: string[] = [];
    const runtime = withLocalMemoryIdentityKernel(fakeRuntime(events), '/state/memory.sqlite', {
      openKernel: () => Promise.resolve(fakeKernel(events)),
      startReplication: () => Promise.reject(new Error('replication failed')),
      startService: () =>
        Promise.resolve({
          dispose: () => {
            events.push('memory-service-dispose');
            return Promise.resolve();
          },
        }),
    });

    await expect(runtime.start()).rejects.toThrow('replication failed');
    expect(events).toEqual(['runtime-start', 'memory-service-dispose', 'memory-close', 'runtime-dispose']);
  });

  test('dispose during a pending Memory lease releases the lease it later receives and starts nothing', async () => {
    const events: string[] = [];
    const leaseGate = deferred<{ readonly release: () => Promise<void> }>();
    const runtime = withLocalMemoryIdentityKernel(fakeRuntime(events), '/state/memory.sqlite', {
      acquireLease: () => {
        events.push('memory-lease-acquire');
        return leaseGate.promise;
      },
      openKernel: () => {
        events.push('memory-open');
        return Promise.resolve(fakeKernel(events));
      },
      startReplication: () => {
        events.push('replication-start');
        return Promise.resolve({ dispose: () => Promise.resolve() });
      },
      startService: () => {
        events.push('memory-service-start');
        return Promise.resolve({ dispose: () => Promise.resolve() });
      },
    });

    const started = runtime.start();
    await settle();
    expect(events).toEqual(['runtime-start', 'memory-lease-acquire']);

    const disposed = runtime.dispose();
    await settle();
    // The Usage writer is not released while a Memory stage is still in flight.
    expect(events).toEqual(['runtime-start', 'memory-lease-acquire']);

    leaseGate.resolve({
      release: () => {
        events.push('memory-lease-release');
        return Promise.resolve();
      },
    });
    await expect(started).rejects.toBeInstanceOf(LocalMemoryRuntimeStartCancelledError);
    await disposed;
    expect(events).toEqual(['runtime-start', 'memory-lease-acquire', 'memory-lease-release', 'runtime-dispose']);
  });

  test('dispose during a pending Memory kernel open closes the kernel and releases the lease', async () => {
    const events: string[] = [];
    const kernelGate = deferred<LocalIdentityKernel>();
    const runtime = withLocalMemoryIdentityKernel(fakeRuntime(events), '/state/memory.sqlite', {
      acquireLease: fakeLease(events),
      openKernel: () => {
        events.push('memory-open');
        return kernelGate.promise;
      },
      startService: () => {
        events.push('memory-service-start');
        return Promise.resolve({ dispose: () => Promise.resolve() });
      },
    });

    const started = runtime.start();
    await settle();
    expect(events).toEqual(['runtime-start', 'memory-lease-acquire', 'memory-open']);

    const disposed = runtime.dispose();
    await settle();
    expect(events).toEqual(['runtime-start', 'memory-lease-acquire', 'memory-open']);

    kernelGate.resolve(fakeKernel(events));
    await expect(started).rejects.toBeInstanceOf(LocalMemoryRuntimeStartCancelledError);
    await disposed;
    expect(events).toEqual([
      'runtime-start',
      'memory-lease-acquire',
      'memory-open',
      'memory-close',
      'memory-lease-release',
      'runtime-dispose',
    ]);
  });

  test('dispose during a pending Memory service publication tears the service, kernel, and lease down', async () => {
    const events: string[] = [];
    const serviceGate = deferred<{ readonly dispose: () => Promise<void> }>();
    const runtime = withLocalMemoryIdentityKernel(fakeRuntime(events), '/state/memory.sqlite', {
      acquireLease: fakeLease(events),
      openKernel: () => Promise.resolve(fakeKernel(events)),
      startReplication: () => {
        events.push('replication-start');
        return Promise.resolve({ dispose: () => Promise.resolve() });
      },
      startService: () => {
        events.push('memory-service-start');
        return serviceGate.promise;
      },
    });

    const started = runtime.start();
    await settle();
    expect(events).toEqual(['runtime-start', 'memory-lease-acquire', 'memory-service-start']);

    const disposed = runtime.dispose();
    await settle();
    expect(events).toEqual(['runtime-start', 'memory-lease-acquire', 'memory-service-start']);

    serviceGate.resolve({
      dispose: () => {
        events.push('memory-service-dispose');
        return Promise.resolve();
      },
    });
    await expect(started).rejects.toBeInstanceOf(LocalMemoryRuntimeStartCancelledError);
    await disposed;
    expect(events).toEqual([
      'runtime-start',
      'memory-lease-acquire',
      'memory-service-start',
      'memory-service-dispose',
      'memory-close',
      'memory-lease-release',
      'runtime-dispose',
    ]);
  });

  test('a retaining disposal during a pending Memory lease keeps that lease on disk once it arrives', async () => {
    const events: string[] = [];
    const leaseGate = deferred<{ readonly release: () => Promise<void> }>();
    const runtime = withLocalMemoryIdentityKernel(fakeRuntime(events), '/state/memory.sqlite', {
      acquireLease: () => {
        events.push('memory-lease-acquire');
        return leaseGate.promise;
      },
      openKernel: () => {
        events.push('memory-open');
        return Promise.resolve(fakeKernel(events));
      },
      startService: () => {
        events.push('memory-service-start');
        return Promise.resolve({ dispose: () => Promise.resolve() });
      },
    });

    const started = runtime.start();
    await settle();
    const disposed = runtime.disposeRetainingWriterLease();
    await settle();
    expect(events).toEqual(['runtime-start', 'memory-lease-acquire']);

    leaseGate.resolve({
      release: () => {
        events.push('memory-lease-release');
        return Promise.resolve();
      },
    });
    await expect(started).rejects.toBeInstanceOf(LocalMemoryRuntimeStartCancelledError);
    await disposed;
    // Mirrors the Usage lease: both stay on disk for the next engine's stale-owner recovery.
    expect(events).toEqual(['runtime-start', 'memory-lease-acquire', 'runtime-dispose-retaining-lease']);
  });

  test('dispose during the Usage startup lets the Usage runtime abort at once and acquires nothing', async () => {
    const events: string[] = [];
    const usageStartGate = deferred<void>();
    const runtime = withLocalMemoryIdentityKernel(
      fakeRuntime(events, {
        start: () => {
          events.push('runtime-start');
          return usageStartGate.promise;
        },
      }),
      '/state/memory.sqlite',
      {
        acquireLease: fakeLease(events),
        openKernel: () => {
          events.push('memory-open');
          return Promise.resolve(fakeKernel(events));
        },
      },
    );

    const started = runtime.start();
    await settle();
    const disposed = runtime.dispose();
    await settle();
    // Nothing of the Memory runtime exists yet, so the Usage runtime may abort its own startup now.
    expect(events).toEqual(['runtime-start', 'runtime-dispose']);

    usageStartGate.resolve();
    await expect(started).rejects.toBeInstanceOf(LocalMemoryRuntimeStartCancelledError);
    await disposed;
    expect(events).toEqual(['runtime-start', 'runtime-dispose']);
  });

  test('uses one dedicated database and lock below the owned engine state directory', () => {
    expect(localMemoryIdentityDatabasePath('/private/state')).toBe('/private/state/memory.sqlite');
    expect(localMemoryIdentityLockPath('/private/state')).toBe('/private/state/memory.sqlite.engine.lock');
  });

  test('excludes a second Memory writer through a lock keyed to the Memory database path', async () => {
    const stateDirectory = await createStateDirectory();
    const memoryDatabasePath = localMemoryIdentityDatabasePath(stateDirectory);
    const lockPath = localMemoryIdentityLockPath(stateDirectory);
    const acquire = (instanceId: string) =>
      acquireUsageEngineLock({ databasePath: memoryDatabasePath, instanceId, stateDirectory });

    const first = await acquire('11111111-1111-4111-8111-111111111111');
    expect(first.path).toBe(lockPath);
    expect(path.dirname(lockPath)).toBe(stateDirectory);
    await expect(Bun.file(lockPath).exists()).resolves.toBe(true);

    // A second engine with a different usage database but the same state
    // directory holds a distinct usage lock; the Memory lock is what stops it.
    const contender = acquire('33333333-3333-4333-8333-333333333333');
    await expect(contender).rejects.toBeInstanceOf(UsageEngineWriterLockContendedError);
    await expect(contender).rejects.toThrow(`Usage engine lock ${lockPath} is owned by live PID ${process.pid}`);

    await first.release();
    await expect(Bun.file(lockPath).exists()).resolves.toBe(false);
  });
});
