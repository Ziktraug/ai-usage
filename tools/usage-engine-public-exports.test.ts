import { describe, expect, test } from 'bun:test';
import {
  parseUsageEngineCommand,
  parseUsageEngineCommandCancellationResult,
  parseUsageEngineCommandCompletion,
  USAGE_ENGINE_PROTOCOL_VERSION,
} from '@ai-usage/usage-engine-control';
import { createUsageEngineControlClient } from '@ai-usage/usage-engine-control/client';
import { executeUsageEngineCommandToCompletion } from '@ai-usage/usage-engine-control/completion';
import { stageUsageEngineHandoff } from '@ai-usage/usage-engine-control/handoff';
import {
  assertUsageEngineRendezvousTarget,
  parseUsageEngineRendezvous,
  parseUsageEngineTargetId,
  readOpenedFileBounded,
  resolveUsageRuntimePaths,
  usageEngineTargetIdFor,
} from '@ai-usage/usage-engine-control/node';
import { createInMemoryUsageEngineControlClient } from '@ai-usage/usage-engine-control/testing';
import { defineUsageEngineRuntimeFactory } from '@ai-usage/usage-engine-runtime';
import { queryReportRows } from '@ai-usage/usage-store/reader';
import { importLocalRows } from '@ai-usage/usage-store/testing';

// The exact exports maps are enforced by tools/check-package-boundaries.ts (reviewedPackageExports).
describe('usage engine public package exports', () => {
  test('resolves every declared TypeScript seam through its package specifier', () => {
    expect(Number(USAGE_ENGINE_PROTOCOL_VERSION)).toBe(4);
    expect(parseUsageEngineCommand).toBeFunction();
    expect(parseUsageEngineCommandCancellationResult).toBeFunction();
    expect(parseUsageEngineCommandCompletion).toBeFunction();
    expect(createUsageEngineControlClient).toBeFunction();
    expect(executeUsageEngineCommandToCompletion).toBeFunction();
    expect(stageUsageEngineHandoff).toBeFunction();
    expect(parseUsageEngineRendezvous).toBeFunction();
    expect(parseUsageEngineTargetId).toBeFunction();
    expect(usageEngineTargetIdFor).toBeFunction();
    expect(assertUsageEngineRendezvousTarget).toBeFunction();
    expect(readOpenedFileBounded).toBeFunction();
    expect(resolveUsageRuntimePaths).toBeFunction();
    expect(createInMemoryUsageEngineControlClient).toBeFunction();
    expect(defineUsageEngineRuntimeFactory).toBeFunction();
    expect(queryReportRows).toBeFunction();
    expect(importLocalRows).toBeFunction();
    expect(import.meta.resolve('@ai-usage/usage-engine/main')).toContain('/apps/usage-engine/src/main.ts');
  });
});
