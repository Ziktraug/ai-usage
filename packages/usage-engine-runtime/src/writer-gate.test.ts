import { describe, expect, test } from 'bun:test';
import { Deferred, Effect } from 'effect';
import { createUsageEngineWriterGate } from './writer-gate';

describe('usage engine writer gate', () => {
  test('serializes promise and Effect writers through one permit', async () => {
    const gate = createUsageEngineWriterGate();
    const releaseFirst = await Effect.runPromise(Deferred.make<void>());
    const firstEntered = await Effect.runPromise(Deferred.make<void>());
    let secondEntered = false;

    const first = gate.run(async () => {
      await Effect.runPromise(Deferred.succeed(firstEntered, undefined));
      await Effect.runPromise(Deferred.await(releaseFirst));
    });
    await Effect.runPromise(Deferred.await(firstEntered));
    const second = Effect.runPromise(
      gate.withEffect(
        Effect.sync(() => {
          secondEntered = true;
        }),
      ),
    );

    await Bun.sleep(5);
    expect(secondEntered).toBe(false);
    await Effect.runPromise(Deferred.succeed(releaseFirst, undefined));
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  });

  test('cancels a queued waiter without leaking the permit', async () => {
    const gate = createUsageEngineWriterGate();
    const releaseHolder = await Effect.runPromise(Deferred.make<void>());
    const holderEntered = await Effect.runPromise(Deferred.make<void>());
    const holder = gate.run(async () => {
      await Effect.runPromise(Deferred.succeed(holderEntered, undefined));
      await Effect.runPromise(Deferred.await(releaseHolder));
    });
    await Effect.runPromise(Deferred.await(holderEntered));
    const abortController = new AbortController();
    abortController.abort();

    await expect(gate.run(async () => undefined, abortController.signal)).rejects.toThrow();
    await Effect.runPromise(Deferred.succeed(releaseHolder, undefined));
    await holder;
    await expect(gate.run(async () => 'entered')).resolves.toBe('entered');
  });

  test('terminally rejects queued and future writers after closing under the permit', async () => {
    const gate = createUsageEngineWriterGate();
    const releaseHolder = await Effect.runPromise(Deferred.make<void>());
    const holderEntered = await Effect.runPromise(Deferred.make<void>());
    let queuedEntered = false;

    const holder = gate.run(async () => {
      await Effect.runPromise(Deferred.succeed(holderEntered, undefined));
      await Effect.runPromise(Deferred.await(releaseHolder));
      gate.close();
    });
    await Effect.runPromise(Deferred.await(holderEntered));
    const queued = gate.run(() => {
      queuedEntered = true;
      return Promise.resolve();
    });

    await Effect.runPromise(Deferred.succeed(releaseHolder, undefined));
    await holder;
    await expect(queued).rejects.toThrow('closed');
    await expect(gate.run(async () => undefined)).rejects.toThrow('closed');
    expect(queuedEntered).toBe(false);
  });
});
