import { expect, test } from 'bun:test';
import { defineUsageEngineComposition } from './main';

test('keeps runtime composition in the usage-engine app', () => {
  const factory = async () => ({}) as never;
  expect(defineUsageEngineComposition(factory)).toBe(factory);
});
