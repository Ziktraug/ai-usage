import { expect, test } from 'bun:test';
import { createLazyModuleLoader } from './lazy-module-loader';

test('deduplicates an active module load and permits an explicit retry after failure', async () => {
  let attempts = 0;
  let release: ((value: { readonly name: string }) => void) | undefined;
  const failures: boolean[] = [];
  const loaded: string[] = [];
  const loader = createLazyModuleLoader({
    importModule: () => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new Error('synthetic chunk failure'));
      }
      return new Promise<{ readonly name: string }>((resolve) => {
        release = resolve;
      });
    },
    onFailureChange: (failed) => failures.push(failed),
    onLoaded: (module) => loaded.push(module.name),
  });

  expect(await loader.load()).toBe('failed');
  const retry = loader.retry();
  const duplicate = loader.load();
  expect(duplicate).toBe(retry);
  expect(attempts).toBe(2);
  release?.({ name: 'recovered' });
  expect(await retry).toBe('loaded');
  expect(loaded).toEqual(['recovered']);
  expect(failures).toEqual([false, true, false]);
});
