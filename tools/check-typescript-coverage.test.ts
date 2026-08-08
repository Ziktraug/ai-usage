import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  collectUncoveredTypeScriptFiles,
  filterExistingRepositoryFiles,
  findUncoveredTypeScriptFiles,
  needsTransitiveProjectDiscovery,
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

  test('falls back to transitive project discovery only for unresolved repository files', () => {
    const projectFiles = new Set(['apps/web/src/root.ts']);

    expect(needsTransitiveProjectDiscovery(['apps/web/src/root.ts'], projectFiles)).toBe(false);
    expect(needsTransitiveProjectDiscovery(['apps/web/src/root.ts', 'apps/web/src/imported.ts'], projectFiles)).toBe(
      true,
    );
    expect(needsTransitiveProjectDiscovery(undefined, projectFiles)).toBe(true);
  });

  test('uses only the canonical Web TypeScript projects', () => {
    expect(TYPECHECK_PROJECTS.filter((project) => project.startsWith('apps/web/'))).toEqual([
      'apps/web/tsconfig.json',
      'apps/web/tsconfig.e2e.json',
    ]);
  });

  test('generates workspace TypeScript projects before checking repository coverage', () => {
    const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')) as {
      scripts: { typecheck: string };
    };

    expect(packageJson.scripts.typecheck.split(' && ')).toEqual([
      'turbo run check',
      'bun tools/check-typescript-coverage.ts',
      'tsc -p tsconfig.tools.json --noEmit',
    ]);
  });

  test('prepares generated Web sources before running the Web typecheck', () => {
    const webPackageJson = JSON.parse(readFileSync(path.join(repositoryRoot, 'apps/web/package.json'), 'utf8')) as {
      scripts: { check: string };
    };

    expect(webPackageJson.scripts.check.split(' && ')).toEqual([
      'bun --filter @ai-usage/design-system build',
      'bun run dev:prepare',
      'bun run typecheck',
    ]);
  });

  test('restores the generated SvelteKit check project from the Web check cache', () => {
    const turboConfig = JSON.parse(readFileSync(path.join(repositoryRoot, 'turbo.json'), 'utf8')) as {
      tasks: Record<string, { outputs?: string[] }>;
    };

    expect(turboConfig.tasks['@ai-usage/web#check']?.outputs).toContain('.svelte-kit/check/**');
  });

  test(
    'covers every TypeScript file in the current repository',
    () => {
      expect(collectUncoveredTypeScriptFiles(repositoryRoot, TYPECHECK_PROJECTS)).toEqual([]);
    },
    coverageTestTimeoutMs,
  );
});
