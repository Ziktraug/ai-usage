import { describe, expect, test } from 'bun:test';
import { createSessionQueryOperationOwner } from './session-query-operation-owner';

describe('session query operation ownership', () => {
  test('abandons every owned task when a new generation begins', async () => {
    const owner = createSessionQueryOperationOwner();
    const firstResult = Promise.withResolvers<string>();
    const secondResult = Promise.withResolvers<string>();
    let firstSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;
    const first = owner.run('first', async ({ signal }) => {
      firstSignal = signal;
      return await firstResult.promise;
    });
    const second = owner.run('second', async ({ signal }) => {
      secondSignal = signal;
      return await secondResult.promise;
    });

    owner.beginGeneration();

    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal?.aborted).toBe(true);
    const replacement = owner.run('first', () => Promise.resolve('replacement'), { policy: 'coalesce' });
    expect(replacement).not.toBe(first);

    firstResult.resolve('stale-first');
    secondResult.resolve('stale-second');
    await expect(first).resolves.toBe('stale-first');
    await expect(second).resolves.toBe('stale-second');
    await expect(replacement).resolves.toBe('replacement');
  });

  test('does not let stale completion release a replacement task', async () => {
    const owner = createSessionQueryOperationOwner();
    const staleResult = Promise.withResolvers<string>();
    const currentResult = Promise.withResolvers<string>();
    const stale = owner.run('shared', async () => await staleResult.promise);
    const current = owner.run('shared', async () => await currentResult.promise);

    staleResult.resolve('stale');
    await expect(stale).resolves.toBe('stale');

    const coalesced = owner.run('shared', () => Promise.resolve('unexpected'), { policy: 'coalesce' });
    expect(coalesced).toBe(current);

    currentResult.resolve('current');
    await expect(coalesced).resolves.toBe('current');
  });

  test('allows a released task to start the next task synchronously', async () => {
    const owner = createSessionQueryOperationOwner();
    let next: Promise<string> | undefined;
    const first = owner.run('shared', (operation) => {
      expect(operation.release()).toBe(true);
      next = owner.run('shared', () => Promise.resolve('next'), { policy: 'coalesce' });
      return Promise.resolve('first');
    });

    await expect(first).resolves.toBe('first');
    if (!next) {
      throw new Error('The released task did not start its successor');
    }
    await expect(next).resolves.toBe('next');
  });

  test('preserves a task created synchronously by an abort handler', async () => {
    const owner = createSessionQueryOperationOwner();
    const staleResult = Promise.withResolvers<string>();
    let reentrant: Promise<string> | undefined;
    const stale = owner.run('shared', async ({ signal }) => {
      signal.addEventListener(
        'abort',
        () => {
          reentrant = owner.run('shared', () => Promise.resolve('reentrant'), { policy: 'coalesce' });
        },
        { once: true },
      );
      return await staleResult.promise;
    });

    owner.beginGeneration();

    const coalesced = owner.run('shared', () => Promise.resolve('unexpected'), { policy: 'coalesce' });
    if (!reentrant) {
      throw new Error('The abort handler did not create its replacement task');
    }
    expect(coalesced).toBe(reentrant);
    staleResult.resolve('stale');
    await expect(stale).resolves.toBe('stale');
    await expect(coalesced).resolves.toBe('reentrant');
  });

  test('lets a task created by a replaced task abort handler win ownership', async () => {
    const owner = createSessionQueryOperationOwner();
    const staleResult = Promise.withResolvers<string>();
    const replacementResult = Promise.withResolvers<string>();
    let replacementSignal: AbortSignal | undefined;
    let reentrant: Promise<string> | undefined;
    const stale = owner.run('shared', async ({ signal }) => {
      signal.addEventListener(
        'abort',
        () => {
          reentrant = owner.run('shared', () => Promise.resolve('reentrant'));
        },
        { once: true },
      );
      return await staleResult.promise;
    });

    const replacement = owner.run('shared', async ({ signal }) => {
      replacementSignal = signal;
      return await replacementResult.promise;
    });
    const coalesced = owner.run('shared', () => Promise.resolve('unexpected'), { policy: 'coalesce' });

    if (!reentrant) {
      throw new Error('The abort handler did not create the winning task');
    }
    expect(replacementSignal?.aborted).toBe(true);
    expect(coalesced).toBe(reentrant);
    staleResult.resolve('stale');
    replacementResult.resolve('replacement');
    await expect(stale).resolves.toBe('stale');
    await expect(replacement).resolves.toBe('replacement');
    await expect(coalesced).resolves.toBe('reentrant');
  });
});
