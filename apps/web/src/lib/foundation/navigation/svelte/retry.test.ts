import { expect, test } from 'bun:test';
import { createRetryController } from './retry';

test('deduplicates a pending route retry and permits retry after success or failure', async () => {
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

  const error = new Error('retry failed');
  const failing = createRetryController({
    onFailure: ({ cause }) => failures.push(cause),
    retry: () => Promise.reject(error),
  });
  await expect(failing.run()).rejects.toBe(error);
  await expect(failing.run()).rejects.toBe(error);
  expect(failures).toEqual([error, error]);
});
