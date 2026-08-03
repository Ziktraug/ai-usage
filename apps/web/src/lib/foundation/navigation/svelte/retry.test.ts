import { expect, test } from 'bun:test';
import { createRetryController } from './retry';

test('[url:history.replace-push-back-forward] retry deduplicates and permits a later run', async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const failures: unknown[] = [];
  const controller = createRetryController({
    onFailure: ({ cause }) => failures.push(cause),
    retry: async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  const first = controller.run();
  const duplicate = controller.run();
  expect(duplicate).toBe(first);
  expect(controller.pending()).toBe(true);
  release?.();
  await first;
  expect(controller.pending()).toBe(false);
  expect(calls).toBe(1);
  const second = controller.run();
  release?.();
  await second;
  expect(calls).toBe(2);

  controller.dispose();
  controller.dispose();
  await expect(controller.run()).rejects.toThrow('disposed');
});

test('[url:history.replace-push-back-forward] retry cancellation aborts and suppresses late failure callbacks', async () => {
  const error = new Error('late retry failure');
  const failures: unknown[] = [];
  let rejectRetry: ((cause: unknown) => void) | undefined;
  let observedSignal: AbortSignal | undefined;
  const failing = createRetryController({
    onFailure: ({ cause }) => failures.push(cause),
    retry: (signal) => {
      observedSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        rejectRetry = reject;
      });
    },
  });
  const pending = failing.run();
  failing.cancel();
  expect(observedSignal?.aborted).toBe(true);
  expect(failing.pending()).toBe(false);
  rejectRetry?.(error);
  await expect(pending).rejects.toBe(error);
  expect(failures).toEqual([]);
  failing.dispose();
});

test('[url:history.replace-push-back-forward] retry reports owned failures and clears synchronous throws', async () => {
  const error = new Error('retry failed');
  const failures: unknown[] = [];
  const controller = createRetryController({
    onFailure: ({ cause }) => failures.push(cause),
    retry: () => {
      throw error;
    },
  });
  await expect(controller.run()).rejects.toBe(error);
  expect(controller.pending()).toBe(false);
  expect(failures).toEqual([error]);
});
