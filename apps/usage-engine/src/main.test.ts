import { expect, test } from 'bun:test';
import {
  defineUsageEngineComposition,
  usageEngineFailureDiagnostic,
  usageEngineForcedShutdownDiagnostic,
} from './main';

test('keeps runtime composition in the usage-engine app', () => {
  const factory = async () => ({}) as never;
  expect(defineUsageEngineComposition(factory)).toBe(factory);
});

test('production failure diagnostics remain bounded and path-free', () => {
  expect(usageEngineFailureDiagnostic).toBe('Usage engine failed to start or complete its command.');
  expect(usageEngineForcedShutdownDiagnostic).toBe('Usage engine forced shutdown before cleanup was confirmed.');
  expect(usageEngineFailureDiagnostic).not.toContain('/');
  expect(usageEngineForcedShutdownDiagnostic).not.toContain('/');
});
