import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  collectUncoveredTypeScriptFiles,
  filterExistingRepositoryFiles,
  findUncoveredTypeScriptFiles,
  selectSupplementalTypeScriptFiles,
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

  test('ignores tracked TypeScript files deleted in the working tree', () => {
    const root = path.resolve('/repository');
    const existingFile = path.join(root, 'apps/web/src/index.ts');

    expect(
      filterExistingRepositoryFiles(
        root,
        ['apps/web/src/index.ts', 'apps/web/src/deleted.ts'],
        (fileName) => fileName === existingFile,
      ),
    ).toEqual(['apps/web/src/index.ts']);
  });

  test('routes every migration parity module through supplemental root typechecking', () => {
    expect(
      selectSupplementalTypeScriptFiles([
        'apps/web/migration-parity/schema.ts',
        'apps/web/migration-parity/shards/p1.parity.ts',
        'apps/web/src/index.ts',
        'tools/check-web-migration-parity.ts',
      ]),
    ).toEqual(['apps/web/migration-parity/schema.ts', 'apps/web/migration-parity/shards/p1.parity.ts']);
  });

  test('uses only the canonical Web TypeScript projects', () => {
    expect(TYPECHECK_PROJECTS.filter((project) => project.startsWith('apps/web/'))).toEqual([
      'apps/web/tsconfig.json',
      'apps/web/tsconfig.e2e.json',
    ]);
  });

  test(
    'covers every TypeScript file in the current repository',
    () => {
      expect(collectUncoveredTypeScriptFiles(repositoryRoot, TYPECHECK_PROJECTS)).toEqual([]);
    },
    coverageTestTimeoutMs,
  );
});
