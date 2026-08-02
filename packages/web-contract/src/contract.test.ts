import { expect, test } from 'bun:test';

test('keeps the F0 contract composition entrypoint empty', async () => {
  expect(Object.keys(await import('./contract'))).toEqual([]);
});
