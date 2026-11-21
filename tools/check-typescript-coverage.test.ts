import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

// Two installed packages publish a `tsc` binary: `typescript` (6.x, kept for svelte-check, `svelte-kit sync`
// and the compiler-API coverage tool) and `@typescript/native` (TypeScript 7). `node_modules/.bin/tsc` is
// whichever of the two the installer linked last, so a script must name the package it means (ADR 0093).
const TSC_PACKAGES = new Set(['@typescript/native', 'typescript']);
const explicitTypeScript7 = 'bun x --no-install --package @typescript/native tsc';
const SEGMENT_SEPARATOR = /&&|\|\||[;|]/;
const WHITESPACE = /\s+/;
const WORKSPACE_GLOB_SUFFIX = /\/\*$/;

const SHELL_WRAPPING = /^["'(]+|["')]+$/g;

const scriptSegments = (script: string): string[][] =>
  script.split(SEGMENT_SEPARATOR).map((segment) =>
    segment
      .trim()
      .split(WHITESPACE)
      .map((token) => token.replace(SHELL_WRAPPING, '')),
  );

const isTscToken = (token: string): boolean => token === 'tsc' || token.endsWith('/tsc') || token.startsWith('tsc@');

// `effect-tsgo tsc@7.0.2 …` runs the compiler bundled with `@effect/tsgo`; `tsc@…` is its argument.
const invokesTsc = (tokens: readonly string[]): boolean => !tokens.includes('effect-tsgo') && tokens.some(isTscToken);

// Only `bun x --no-install --package <pkg> tsc` qualifies: without `--no-install` a missing alias would be
// fetched from the registry by name, and a versioned `tsc@…` never resolves the installed package.
const selectsTscPackage = (tokens: readonly string[]): boolean => {
  const tsc = tokens.indexOf('tsc');
  const noInstall = tokens.indexOf('--no-install');
  const packageFlag = tokens.indexOf('--package');
  return (
    tokens[0] === 'bun' &&
    tokens[1] === 'x' &&
    noInstall !== -1 &&
    noInstall < tsc &&
    packageFlag !== -1 &&
    packageFlag < tsc &&
    TSC_PACKAGES.has(tokens[packageFlag + 1] ?? '')
  );
};

const ambiguousTscSegments = (script: string): string[] =>
  scriptSegments(script)
    .filter((tokens) => invokesTsc(tokens) && !selectsTscPackage(tokens))
    .map((tokens) => tokens.join(' '));

interface PackageManifest {
  readonly scripts?: Record<string, string>;
  readonly workspaces?: string[];
}

const readManifest = (manifestPath: string): PackageManifest =>
  JSON.parse(readFileSync(path.join(repositoryRoot, manifestPath), 'utf8')) as PackageManifest;

const manifestPaths = (): string[] => {
  const workspaceManifests = (readManifest('package.json').workspaces ?? []).flatMap((pattern) => {
    const workspaceRoot = pattern.replace(WORKSPACE_GLOB_SUFFIX, '');
    return readdirSync(path.join(repositoryRoot, workspaceRoot))
      .map((directory) => path.posix.join(workspaceRoot, directory, 'package.json'))
      .filter((manifestPath) => existsSync(path.join(repositoryRoot, manifestPath)));
  });
  return ['package.json', ...workspaceManifests.sort()];
};

const repositoryScripts = (): { manifestPath: string; name: string; script: string }[] =>
  manifestPaths().flatMap((manifestPath) =>
    Object.entries(readManifest(manifestPath).scripts ?? {}).map(([name, script]) => ({ manifestPath, name, script })),
  );

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
      `${explicitTypeScript7} -p tsconfig.tools.json --noEmit`,
    ]);
  });

  test('recognises a tsc invocation that does not select its package', () => {
    expect(ambiguousTscSegments('tsc --noEmit')).toEqual(['tsc --noEmit']);
    expect(ambiguousTscSegments('bun run lib && bun --bun tsc --noEmit')).toEqual(['bun --bun tsc --noEmit']);
    expect(ambiguousTscSegments('node_modules/.bin/tsc -p tsconfig.tools.json')).toEqual([
      'node_modules/.bin/tsc -p tsconfig.tools.json',
    ]);
    expect(ambiguousTscSegments('bun x --no-install --package left-pad tsc --noEmit')).toEqual([
      'bun x --no-install --package left-pad tsc --noEmit',
    ]);
    for (const unselected of [
      'bunx tsc@latest --noEmit',
      "sh -c 'tsc --noEmit'",
      '(tsc --noEmit)',
      'bun x --package @typescript/native tsc --noEmit',
      'npx --no-install --package typescript tsc --noEmit',
    ]) {
      expect(ambiguousTscSegments(unselected)).toHaveLength(1);
    }
    expect(ambiguousTscSegments(`${explicitTypeScript7} --noEmit`)).toEqual([]);
    expect(ambiguousTscSegments('bun x --no-install --package typescript tsc --noEmit')).toEqual([]);
    // `effect-tsgo` is another binary; `tsc@7.0.2` is its argument, not the `tsc` binary.
    expect(
      ambiguousTscSegments('bun --bun x --no-install effect-tsgo tsc@7.0.2 --project tsconfig.effect.json --noEmit'),
    ).toEqual([]);
  });

  test('every script that runs tsc selects its package, because two installed packages publish tsc', () => {
    const scripts = repositoryScripts();
    const ambiguous = scripts.flatMap(({ manifestPath, name, script }) =>
      ambiguousTscSegments(script).map((segment) => `${manifestPath} ${name}: ${segment}`),
    );

    expect(scripts.filter(({ script }) => scriptSegments(script).some(invokesTsc)).length).toBeGreaterThan(0);
    expect(ambiguous).toEqual([]);
  });

  test('no build script invokes tsc: type-checking belongs to check', () => {
    const typeCheckingBuilds = repositoryScripts()
      .filter(({ name, script }) => name === 'build' && scriptSegments(script).some(invokesTsc))
      .map(({ manifestPath, script }) => `${manifestPath} build: ${script}`);

    expect(typeCheckingBuilds).toEqual([]);
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
