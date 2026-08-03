import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';

const IMPORT_SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;
const SOURCE_SUFFIXES = ['', '.svelte.ts', '.svelte', '.ts', '.tsx', '.mjs', '.js'] as const;
const SVELTE_RUNTIME_PREFIXES = [
  '@ai-usage/design-system/svelte',
  '@ark-ui/svelte',
  '@tanstack/svelte',
  'svelte',
] as const;
const FORBIDDEN_PACKAGE_PREFIXES = [
  '$app/server',
  '$lib/server',
  '@ai-usage/design-system/report',
  '@ai-usage/design-system/solid',
  '@ai-usage/local-machine',
  '@ai-usage/report-data',
  '@ai-usage/usage-engine-runtime',
  '@ai-usage/usage-merge',
  '@ai-usage/usage-store',
  '@ark-ui/solid',
  '@orpc/server',
  '@sveltejs/kit',
  '@tanstack/solid',
  'bun:',
  'node:',
  'solid-js',
] as const;

interface FileAccess {
  readonly isFile: (filePath: string) => boolean;
  readonly read: (filePath: string) => string;
}

interface ClosureOptions {
  readonly access: FileAccess;
  readonly appLibRoot: string;
  readonly repositoryRoot: string;
  readonly workspacePackages: ReadonlyMap<string, string>;
}

interface ClientClosure {
  readonly files: ReadonlySet<string>;
  readonly imports: ReadonlyMap<string, readonly string[]>;
}

const realFileAccess: FileAccess = {
  isFile: (filePath) => {
    try {
      return statSync(filePath).isFile();
    } catch {
      return false;
    }
  },
  read: (filePath) => readFileSync(filePath, 'utf8'),
};

const importSpecifiers = (source: string): readonly string[] =>
  [...source.matchAll(IMPORT_SPECIFIER_PATTERN)].flatMap((match) => (match[1] ? [match[1]] : []));

const resolveFile = (candidate: string, access: FileAccess): string | undefined => {
  const directCandidates = candidate.endsWith('.svelte')
    ? [`${candidate}.ts`, candidate]
    : SOURCE_SUFFIXES.map((suffix) => `${candidate}${suffix}`);
  for (const directCandidate of directCandidates) {
    const filePath = normalize(directCandidate);
    if (access.isFile(filePath)) {
      return filePath;
    }
  }
  for (const suffix of SOURCE_SUFFIXES.slice(1)) {
    const filePath = normalize(join(candidate, `index${suffix}`));
    if (access.isFile(filePath)) {
      return filePath;
    }
  }
  return;
};

const exportTarget = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  if (!(typeof value === 'object' && value !== null && !Array.isArray(value))) {
    return;
  }
  const conditions = value as Record<string, unknown>;
  for (const key of ['browser', 'svelte', 'import', 'types', 'default']) {
    const target = exportTarget(conditions[key]);
    if (target) {
      return target;
    }
  }
  return;
};

const workspacePackageFor = (
  specifier: string,
  workspacePackages: ReadonlyMap<string, string>,
): readonly [string, string] | undefined =>
  [...workspacePackages.entries()]
    .sort(([left], [right]) => right.length - left.length)
    .find(([packageName]) => specifier === packageName || specifier.startsWith(`${packageName}/`));

const resolveWorkspaceImport = (specifier: string, options: ClosureOptions): string | undefined => {
  const workspacePackage = workspacePackageFor(specifier, options.workspacePackages);
  if (!workspacePackage) {
    return;
  }
  const [packageName, packageRoot] = workspacePackage;
  const packageJsonPath = join(packageRoot, 'package.json');
  if (!options.access.isFile(packageJsonPath)) {
    throw new Error(`Workspace package manifest is missing for ${specifier}`);
  }
  const packageJson = JSON.parse(options.access.read(packageJsonPath)) as {
    readonly exports?: Readonly<Record<string, unknown>>;
  };
  const suffix = specifier.slice(packageName.length);
  const exportKey = suffix.length === 0 ? '.' : `.${suffix}`;
  const target = exportTarget(packageJson.exports?.[exportKey]);
  if (!target) {
    throw new Error(`Workspace export ${exportKey} is missing for ${specifier}`);
  }
  const resolved = resolveFile(resolve(packageRoot, target), options.access);
  if (!resolved) {
    throw new Error(`Workspace export target ${target} is missing for ${specifier}`);
  }
  return resolved;
};

const resolveSpecifier = (sourcePath: string, specifier: string, options: ClosureOptions): string | undefined => {
  if (specifier.startsWith('.')) {
    const resolved = resolveFile(resolve(dirname(sourcePath), specifier), options.access);
    if (!resolved) {
      throw new Error(`Cannot resolve local client import ${specifier} from ${sourcePath}`);
    }
    return resolved;
  }
  if (specifier === '$lib' || specifier.startsWith('$lib/')) {
    const suffix = specifier === '$lib' ? '' : specifier.slice('$lib/'.length);
    const resolved = resolveFile(join(options.appLibRoot, suffix), options.access);
    if (!resolved) {
      throw new Error(`Cannot resolve client alias ${specifier} from ${sourcePath}`);
    }
    return resolved;
  }
  return resolveWorkspaceImport(specifier, options);
};

const closureFrom = (entryPaths: readonly string[], options: ClosureOptions): ClientClosure => {
  const files = new Set<string>();
  const imports = new Map<string, readonly string[]>();
  const pending = [...entryPaths];

  while (pending.length > 0) {
    const sourcePath = normalize(pending.pop() ?? '');
    if (files.has(sourcePath)) {
      continue;
    }
    files.add(sourcePath);
    const specifiers = importSpecifiers(options.access.read(sourcePath));
    imports.set(sourcePath, specifiers);
    for (const specifier of specifiers) {
      const resolved = resolveSpecifier(sourcePath, specifier, options);
      if (resolved && !files.has(resolved)) {
        pending.push(resolved);
      }
    }
  }

  return { files, imports };
};

const importsSvelteRuntime = (specifier: string): boolean =>
  SVELTE_RUNTIME_PREFIXES.some((runtime) => specifier === runtime || specifier.startsWith(`${runtime}/`));

const importsForbiddenPackage = (specifier: string): boolean =>
  FORBIDDEN_PACKAGE_PREFIXES.some((forbidden) =>
    forbidden.endsWith(':')
      ? specifier.startsWith(forbidden)
      : specifier === forbidden || specifier.startsWith(`${forbidden}/`),
  );

const isSvelteRuntimeLeaf = (sourcePath: string): boolean =>
  sourcePath.endsWith('.svelte') || sourcePath.endsWith('.svelte.ts');

const isForbiddenSourcePath = (sourcePath: string): boolean =>
  sourcePath.endsWith('.tsx') ||
  sourcePath.includes('.server.') ||
  sourcePath.includes(`${join('apps', 'web', 'src', 'server')}/`) ||
  sourcePath.includes(`${join('packages', 'usage-store')}/`) ||
  sourcePath.includes(`${join('packages', 'usage-engine-runtime')}/`) ||
  sourcePath.includes(`${join('packages', 'usage-merge')}/`);

const closureViolations = (closure: ClientClosure, repositoryRoot: string): readonly string[] => {
  const violations: string[] = [];
  for (const [sourcePath, specifiers] of closure.imports) {
    const sourceLabel = relative(repositoryRoot, sourcePath) || sourcePath;
    if (isForbiddenSourcePath(sourcePath)) {
      violations.push(`${sourceLabel} is a forbidden client source`);
    }
    for (const specifier of specifiers) {
      const importLabel = `${sourceLabel} -> ${specifier}`;
      if (importsForbiddenPackage(specifier)) {
        violations.push(importLabel);
      }
      if (importsSvelteRuntime(specifier) && !isSvelteRuntimeLeaf(sourcePath)) {
        violations.push(`${importLabel} imports Svelte runtime outside a Svelte leaf`);
      }
    }
  }
  return violations;
};

const discoverWorkspacePackages = (repositoryRoot: string): ReadonlyMap<string, string> => {
  const packagesRoot = join(repositoryRoot, 'packages');
  const workspacePackages = new Map<string, string>();
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageRoot = join(packagesRoot, entry.name);
    const packageJsonPath = join(packageRoot, 'package.json');
    if (!realFileAccess.isFile(packageJsonPath)) {
      continue;
    }
    const packageJson = JSON.parse(realFileAccess.read(packageJsonPath)) as { readonly name?: unknown };
    if (typeof packageJson.name === 'string') {
      workspacePackages.set(packageJson.name, packageRoot);
    }
  }
  return workspacePackages;
};

const repositoryRoot = resolve(import.meta.dir, '../../../../../../');
const appLibRoot = join(repositoryRoot, 'apps/web/src/lib');
const featureDirectory = import.meta.dir;
const entryPaths = ['source-control-provider.svelte', 'source-control-summary.svelte', 'sources-page.svelte'].map(
  (entryPath) => join(featureDirectory, entryPath),
);
const realOptions: ClosureOptions = {
  access: realFileAccess,
  appLibRoot,
  repositoryRoot,
  workspacePackages: discoverWorkspacePackages(repositoryRoot),
};

describe('Sources client dependency closure', () => {
  test('traverses aliases and workspace exports while staying outside Solid, server, Node, and writers', () => {
    const closure = closureFrom(entryPaths, realOptions);

    expect(closureViolations(closure, repositoryRoot)).toEqual([]);
    expect(closure.files.has(join(featureDirectory, 'context.svelte.ts'))).toBe(true);
    expect(closure.files.has(join(repositoryRoot, 'apps/web/src/source-control-client.ts'))).toBe(true);
    expect(closure.files.has(join(repositoryRoot, 'packages/report-core/src/source-control.ts'))).toBe(true);
    expect(closure.files.has(join(repositoryRoot, 'packages/web-contract/src/control.ts'))).toBe(true);
    expect(closure.files.has(join(repositoryRoot, 'packages/design-system/src/svelte.ts'))).toBe(true);
    expect([...closure.files].some((sourcePath) => sourcePath.endsWith('packages/design-system/src/solid.ts'))).toBe(
      false,
    );
  });

  test('detects hidden package-barrel and $lib alias leaks in a synthetic closure', () => {
    const syntheticRoot = normalize('/synthetic/repository');
    const syntheticLib = join(syntheticRoot, 'apps/web/src/lib');
    const hiddenPackage = join(syntheticRoot, 'packages/hidden');
    const writerSpecifier = ['@ai-usage/usage-store', 'writer'].join('/');
    const files = new Map<string, string>([
      [
        join(syntheticLib, 'entry.ts'),
        "import '$lib/browser'; import '@fixture/hidden'; import '@fixture/hidden/legacy';",
      ],
      [join(syntheticLib, 'browser/index.ts'), "export * from './nested.svelte'; export * from './hidden.server';"],
      [join(syntheticLib, 'browser/nested.svelte.ts'), "import path from 'node:path';"],
      [join(syntheticLib, 'browser/hidden.server.ts'), 'export const hidden = true;'],
      [
        join(hiddenPackage, 'package.json'),
        JSON.stringify({
          exports: { '.': './src/index.ts', './legacy': './src/legacy.tsx' },
          name: '@fixture/hidden',
        }),
      ],
      [join(hiddenPackage, 'src/index.ts'), "export * from './writer'; export * from './solid';"],
      [join(hiddenPackage, 'src/writer.ts'), `import '${writerSpecifier}';`],
      [join(hiddenPackage, 'src/solid.ts'), "import 'solid-js';"],
      [join(hiddenPackage, 'src/legacy.tsx'), 'export const Legacy = () => null;'],
    ]);
    const access: FileAccess = {
      isFile: (filePath) => files.has(normalize(filePath)),
      read: (filePath) => {
        const source = files.get(normalize(filePath));
        if (source === undefined) {
          throw new Error(`Synthetic source is missing: ${filePath}`);
        }
        return source;
      },
    };
    const closure = closureFrom([join(syntheticLib, 'entry.ts')], {
      access,
      appLibRoot: syntheticLib,
      repositoryRoot: syntheticRoot,
      workspacePackages: new Map([['@fixture/hidden', hiddenPackage]]),
    });
    const violations = closureViolations(closure, syntheticRoot);

    expect(violations.some((violation) => violation.includes('node:path'))).toBe(true);
    expect(violations.some((violation) => violation.includes('solid-js'))).toBe(true);
    expect(violations.some((violation) => violation.includes(writerSpecifier))).toBe(true);
    expect(violations.some((violation) => violation.includes('hidden.server.ts is a forbidden client source'))).toBe(
      true,
    );
    expect(violations.some((violation) => violation.includes('legacy.tsx is a forbidden client source'))).toBe(true);
  });
});
