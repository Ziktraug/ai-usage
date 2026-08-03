import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '../../../../../../../');
const ownedRoots = [resolve(import.meta.dir), resolve(import.meta.dir, '../range')] as const;
const entrypoints = ownedRoots.flatMap((root) =>
  Array.from(new Bun.Glob('**/*.{svelte,ts}').scanSync({ cwd: root, onlyFiles: true }))
    .filter((path) => !(path.endsWith('.test.ts') || path.endsWith('.fixture.svelte')))
    .map((path) => join(root, path)),
);
const importPattern = /(?:from\s+|import\s*\(|import\s+)["']([^"']+)["']/g;
const sourceExtensions = ['', '.ts', '.svelte', '.svelte.ts', '.tsx'] as const;
const workspacePackages = new Map([
  ['@ai-usage/design-system', 'packages/design-system'],
  ['@ai-usage/report-core', 'packages/report-core'],
]);

const moduleSpecifiers = (source: string): string[] =>
  Array.from(source.matchAll(importPattern), (match) => match[1]).filter(
    (value): value is string => value !== undefined,
  );

const resolveFile = (candidate: string): string | null => {
  for (const extension of sourceExtensions) {
    const path = `${candidate}${extension}`;
    if (existsSync(path)) {
      return path;
    }
  }
  for (const extension of sourceExtensions.slice(1)) {
    const path = join(candidate, `index${extension}`);
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
};

const workspaceExport = (specifier: string): string | null => {
  const packageName = [...workspacePackages.keys()].find(
    (candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`),
  );
  if (!packageName) {
    return null;
  }
  const packageDirectory = workspacePackages.get(packageName);
  if (!packageDirectory) {
    return null;
  }
  const packageRoot = join(repositoryRoot, packageDirectory);
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    exports?: Record<string, string | { import?: string; types?: string }>;
  };
  const suffix = specifier.slice(packageName.length);
  const key = suffix.length === 0 ? '.' : `.${suffix}`;
  const entry = packageJson.exports?.[key];
  const target = typeof entry === 'string' ? entry : (entry?.import ?? entry?.types);
  return target ? resolveFile(join(packageRoot, target)) : null;
};

const resolveSpecifier = (from: string, specifier: string): string | null => {
  if (specifier.startsWith('.')) {
    return resolveFile(resolve(dirname(from), specifier));
  }
  if (specifier.startsWith('$lib/')) {
    return resolveFile(join(repositoryRoot, 'apps/web/src/lib', specifier.slice(5)));
  }
  return workspaceExport(specifier);
};

const closureFrom = (roots: readonly string[]): { files: Set<string>; imports: Map<string, string[]> } => {
  const files = new Set<string>();
  const imports = new Map<string, string[]>();
  const pending = [...roots];
  while (pending.length > 0) {
    const path = normalize(pending.pop() ?? '');
    if (files.has(path)) {
      continue;
    }
    files.add(path);
    const specifiers = moduleSpecifiers(readFileSync(path, 'utf8'));
    imports.set(path, specifiers);
    for (const specifier of specifiers) {
      const resolved = resolveSpecifier(path, specifier);
      if (resolved && !files.has(resolved)) {
        pending.push(resolved);
      }
    }
  }
  return { files, imports };
};

describe('P2 client dependency closure', () => {
  test('stays on the explicit Svelte design entrypoint and outside Solid/server runtimes', () => {
    const closure = closureFrom(entrypoints);
    const violations: string[] = [];
    for (const [path, specifiers] of closure.imports) {
      for (const specifier of specifiers) {
        if (
          specifier.includes('solid-js') ||
          specifier.includes('@ark-ui/solid') ||
          specifier.includes('@tanstack/solid') ||
          specifier === '@ai-usage/design-system/report' ||
          specifier === '@ai-usage/design-system/solid' ||
          specifier.startsWith('node:') ||
          specifier.startsWith('bun:')
        ) {
          violations.push(`${relative(repositoryRoot, path)} -> ${specifier}`);
        }
      }
      if (extname(path) === '.tsx') {
        violations.push(`${relative(repositoryRoot, path)} is TSX`);
      }
    }
    expect(violations).toEqual([]);
    expect([...closure.files].some((path) => path.endsWith('packages/design-system/src/svelte.ts'))).toBe(true);
    expect([...closure.files].some((path) => path.endsWith('packages/design-system/src/solid.ts'))).toBe(false);
  });
});
