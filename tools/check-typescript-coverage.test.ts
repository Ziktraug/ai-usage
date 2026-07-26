import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  collectUncoveredTypeScriptFiles,
  findUncoveredTypeScriptFiles,
  TYPECHECK_PROJECTS,
} from './check-typescript-coverage';

const repositoryRoot = path.resolve(import.meta.dir, '..');
const coverageTestTimeoutMs = 15_000;

describe('TypeScript project coverage guard', () => {
  test('reports files that do not belong to a checked project', () => {
    const repositoryFiles = ['apps/web/src/index.ts', 'apps/web/server/plugin.ts', 'tools/check.ts'];
    const projectFiles = new Set(['apps/web/src/index.ts']);

    expect(findUncoveredTypeScriptFiles(repositoryFiles, projectFiles)).toEqual([
      'apps/web/server/plugin.ts',
      'tools/check.ts',
    ]);
  });

  test('accepts files covered by any checked project', () => {
    const repositoryFiles = ['apps/web/src/index.ts', 'apps/web/server/plugin.ts'];
    const projectFiles = new Set(repositoryFiles);

    expect(findUncoveredTypeScriptFiles(repositoryFiles, projectFiles)).toEqual([]);
  });

  test(
    'covers every TypeScript file in the current repository',
    () => {
      expect(collectUncoveredTypeScriptFiles(repositoryRoot, TYPECHECK_PROJECTS)).toEqual([]);
    },
    coverageTestTimeoutMs,
  );
});
