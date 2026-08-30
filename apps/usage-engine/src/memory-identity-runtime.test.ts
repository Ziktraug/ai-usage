import { describe, expect, test } from 'bun:test';
import type { LocalIdentityKernel } from '@ai-usage/memory-sqlite/identity';
import type { UsageEngineRuntimeHost } from '@ai-usage/usage-engine-runtime';
import { localMemoryIdentityDatabasePath, withLocalMemoryIdentityKernel } from './memory-identity-runtime';

const emptyChanges = (): AsyncIterable<never> => ({
  [Symbol.asyncIterator]: (): AsyncIterator<never> => ({
    next: () => Promise.resolve({ done: true, value: undefined as never }),
  }),
});

const fakeRuntime = (events: string[]): UsageEngineRuntimeHost => ({
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
});

const fakeKernel = (events: string[]): LocalIdentityKernel =>
  ({
    close: () => {
      events.push('memory-close');
      return Promise.resolve();
    },
  }) as LocalIdentityKernel;

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

  test('uses one dedicated database below the owned engine state directory', () => {
    expect(localMemoryIdentityDatabasePath('/private/state')).toBe('/private/state/memory.sqlite');
  });
});
