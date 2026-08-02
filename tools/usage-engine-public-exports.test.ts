import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
import { createUsageStore, importLocalRows } from '@ai-usage/usage-store/testing';

const repositoryRoot = path.resolve(import.meta.dir, '..');

const readPackageJson = async (relativePath: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(repositoryRoot, relativePath), 'utf8')) as Record<string, unknown>;

describe('usage engine public package exports', () => {
  test('exposes only the explicit control, runtime, and store seams', async () => {
    const [controlPackage, runtimePackage, storePackage, appPackage] = await Promise.all([
      readPackageJson('packages/usage-engine-control/package.json'),
      readPackageJson('packages/usage-engine-runtime/package.json'),
      readPackageJson('packages/usage-store/package.json'),
      readPackageJson('apps/usage-engine/package.json'),
    ]);

    expect(controlPackage.exports).toEqual({
      '.': './src/contracts.ts',
      './client': './src/client.ts',
      './completion': './src/completion.ts',
      './handoff': './src/handoff.ts',
      './node': './src/rendezvous.ts',
      './testing': './src/testing.ts',
    });
    expect(runtimePackage.exports).toEqual({
      '.': './src/runtime.ts',
      './live': './src/live.ts',
      './recovery': './src/recovery.ts',
      './source-adapters': './src/source-adapters.ts',
      './source-control': './src/source-control.ts',
    });
    expect(storePackage.exports).toEqual({
      './reader': './src/reader.ts',
      './testing': './src/testing.ts',
      './writer': './src/writer.ts',
    });
    expect(appPackage.exports).toEqual({ './main': './src/main.ts' });
  });

  test('resolves every declared TypeScript seam through its package specifier', () => {
    expect(Number(USAGE_ENGINE_PROTOCOL_VERSION)).toBe(1);
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
    expect(createUsageStore).toBeFunction();
    expect(importLocalRows).toBeFunction();
    expect(import.meta.resolve('@ai-usage/usage-engine/main')).toContain('/apps/usage-engine/src/main.ts');
  });
});
