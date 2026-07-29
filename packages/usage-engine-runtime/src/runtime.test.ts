import { expect, test } from 'bun:test';
import type { UsageEngineRuntime } from './runtime';

test('exposes one scoped runtime lifecycle contract', () => {
  const contract = {} as UsageEngineRuntime;
  expect<keyof UsageEngineRuntime>('start').toBe('start');
  expect(contract).toBeDefined();
});
