import { expect, test } from 'bun:test';
import { startSourceControlPluginOutsideDemo } from './source-control-plugin-boundary.server';

test('demo mode does not load or construct the source-control runtime', async () => {
  let runtimeConstructions = 0;
  const started = await startSourceControlPluginOutsideDemo(() => {
    runtimeConstructions += 1;
    return Promise.resolve();
  }, 'demo');

  expect(started).toBe(false);
  expect(runtimeConstructions).toBe(0);
});
