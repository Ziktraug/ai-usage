import { describe, expect, test } from 'bun:test';
import { createDiscardDialogController } from './discard-dialog-controller';

describe('P9 discard confirmation controller', () => {
  test('ignores Escape/Keep and duplicate discard while asynchronous discard is pending', async () => {
    const pendingDiscard = Promise.withResolvers<void>();
    const calls: string[] = [];
    const controller = createDiscardDialogController({
      onDiscard: async () => {
        calls.push('discard');
        await pendingDiscard.promise;
      },
      onKeep: () => calls.push('keep'),
    });
    const pendingStates: boolean[] = [];
    const stop = controller.pending.subscribe((pending) => pendingStates.push(pending));

    const discard = controller.discard();
    const duplicateDiscard = controller.discard();
    expect(controller.pending.getState()).toBe(true);
    expect(controller.keep()).toBe(false);
    expect(calls).toEqual(['discard']);

    pendingDiscard.resolve();
    await Promise.all([discard, duplicateDiscard]);
    expect(controller.pending.getState()).toBe(false);
    expect(controller.keep()).toBe(true);
    expect(calls).toEqual(['discard', 'keep']);
    expect(pendingStates).toEqual([true, false]);
    stop();
  });

  test('always clears pending when discard rejects', async () => {
    const controller = createDiscardDialogController({
      onDiscard: () => Promise.reject(new Error('synthetic discard failure')),
      onKeep: () => undefined,
    });
    await expect(controller.discard()).rejects.toThrow('synthetic discard failure');
    expect(controller.pending.getState()).toBe(false);
  });
});
