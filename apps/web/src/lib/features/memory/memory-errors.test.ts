import { expect, test } from 'bun:test';
import { memoryAnalysisError } from './memory-errors';

test('analysis errors distinguish unsupported modes, denied access and an unreachable service without displaying diagnostics', () => {
  expect(memoryAnalysisError({ code: 'ForbiddenDemo' }, 'fallback')).toContain('demo mode');
  expect(memoryAnalysisError({ data: { reason: 'unsupported-mode' } }, 'fallback')).toContain('connected mode');
  expect(memoryAnalysisError({ data: { reason: 'service-unavailable' } }, 'fallback')).toContain(
    'stopped or unreachable',
  );
  expect(memoryAnalysisError({ code: 'Forbidden' }, 'fallback')).toContain('denied');
  expect(memoryAnalysisError(new Error('/private/native-history'), 'fallback')).toBe('fallback');
  for (const [reason, recovery] of [
    ['mapping-required', 'Projects'],
    ['selection-stale', 'Refresh'],
    ['version-incompatible', 'Update'],
    ['storage-unavailable', 'storage status'],
    ['not-found', 'removed or withdrawn'],
    ['source-modified', 'Preview sessions again'],
  ]) {
    expect(memoryAnalysisError({ data: { reason } }, 'fallback')).toContain(recovery!);
  }
});
