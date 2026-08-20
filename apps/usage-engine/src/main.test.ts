import { expect, test } from 'bun:test';
import { UsageEngineWriterLockContendedError } from './engine-lock';
import {
  defineUsageEngineComposition,
  usageEngineFailureDiagnostic,
  usageEngineForcedShutdownDiagnostic,
  usageEngineStartupFailureKind,
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

test('classifies startup failures through a closed path-free vocabulary', () => {
  const privateDiagnostic = '/home/operator/usage.sqlite is owned by live PID 4242';

  expect(usageEngineStartupFailureKind(new UsageEngineWriterLockContendedError(privateDiagnostic))).toBe(
    'writer-lock-contended',
  );
  expect(usageEngineStartupFailureKind(new Error(privateDiagnostic))).toBe('startup-failure');
});
