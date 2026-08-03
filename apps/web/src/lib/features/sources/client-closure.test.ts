import { describe, expect, test } from 'bun:test';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IMPORT_SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;
const SOURCE_SUFFIXES = ['.svelte.ts', '.svelte', '.ts', '.tsx'] as const;
const SVELTE_RUNTIME_PREFIXES = [
  '@ai-usage/design-system/svelte',
  '@ark-ui/svelte',
  '@tanstack/svelte',
  'svelte',
] as const;
const FORBIDDEN_PACKAGE_PREFIXES = [
  '$app',
  '$lib/server',
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
const featureDirectory = fileURLToPath(new URL('.', import.meta.url));
const entryPaths = ['source-control-provider.svelte', 'source-control-summary.svelte', 'sources-page.svelte'] as const;

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const hasSourceSuffix = (filePath: string): boolean => SOURCE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));

const localImportCandidates = (unresolvedPath: string): readonly string[] => {
  if (unresolvedPath.endsWith('.svelte')) {
    return [`${unresolvedPath}.ts`, unresolvedPath];
  }
  if (hasSourceSuffix(unresolvedPath)) {
    return [unresolvedPath];
  }
  return SOURCE_SUFFIXES.flatMap((suffix) => [
    `${unresolvedPath}${suffix}`,
    path.join(unresolvedPath, `index${suffix}`),
  ]);
};
const resolveLocalImport = async (sourcePath: string, specifier: string): Promise<string> => {
  const unresolvedPath = path.resolve(path.dirname(sourcePath), specifier);
  const candidates = localImportCandidates(unresolvedPath);
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  throw new Error(['Cannot resolve Sources client import', specifier, 'from', sourcePath].join(' '));
};

const importSpecifiers = (source: string): readonly string[] =>
  [...source.matchAll(IMPORT_SPECIFIER_PATTERN)].flatMap((match) => (match[1] ? [match[1]] : []));

const isSvelteRuntimeLeaf = (sourcePath: string): boolean =>
  sourcePath.endsWith('.svelte') || sourcePath.endsWith('.svelte.ts');

const importsSvelteRuntime = (specifier: string): boolean =>
  SVELTE_RUNTIME_PREFIXES.some((runtime) => specifier === runtime || specifier.startsWith(`${runtime}/`));

const importsForbiddenPackage = (specifier: string): boolean =>
  FORBIDDEN_PACKAGE_PREFIXES.some((forbidden) => specifier.startsWith(forbidden));

const isForbiddenLocalSource = (sourcePath: string): boolean =>
  sourcePath.endsWith('.tsx') || sourcePath.includes('.server.') || sourcePath.includes(`${path.sep}server${path.sep}`);

describe('Sources client dependency closure', () => {
  test('recursively stays browser-safe and confines Svelte runtimes to Svelte leaves', async () => {
    const pending = entryPaths.map((entryPath) => path.join(featureDirectory, entryPath));
    const visited = new Set<string>();

    while (pending.length > 0) {
      const sourcePath = pending.pop();
      if (!sourcePath || visited.has(sourcePath)) {
        continue;
      }
      visited.add(sourcePath);
      expect(isForbiddenLocalSource(sourcePath), sourcePath).toBe(false);

      const source = await readFile(sourcePath, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        const importLabel = [sourcePath, 'imports', specifier].join(' ');
        expect(importsForbiddenPackage(specifier), importLabel).toBe(false);
        if (importsSvelteRuntime(specifier)) {
          expect(isSvelteRuntimeLeaf(sourcePath), importLabel).toBe(true);
        }
        if (specifier.startsWith('.')) {
          const resolved = await resolveLocalImport(sourcePath, specifier);
          if (resolved.endsWith('.svelte')) {
            expect(isSvelteRuntimeLeaf(sourcePath), [sourcePath, 'imports', resolved].join(' ')).toBe(true);
          }
          pending.push(resolved);
        }
      }
    }

    expect(visited.has(path.join(featureDirectory, 'context.svelte.ts'))).toBe(true);
    expect(visited.has(path.resolve(featureDirectory, '../../../source-control-client.ts'))).toBe(true);
    expect(visited.has(path.resolve(featureDirectory, '../../foundation/presentation/format.ts'))).toBe(true);
    expect([...visited].every((sourcePath) => !sourcePath.endsWith('.tsx'))).toBe(true);
  });

  test('classifies representative TSX, Solid, Svelte, server, Node and Bun crossings', () => {
    for (const specifier of [
      'solid-js',
      '@ark-ui/solid/dialog',
      '@ai-usage/design-system/solid',
      '@tanstack/solid-query',
      '@orpc/server',
      '@ai-usage/usage-store/reader',
      '@ai-usage/usage-merge',
      '@ai-usage/usage-engine-runtime',
      '$lib/server/source-control',
      'node:path',
      'bun:sqlite',
    ]) {
      expect(importsForbiddenPackage(specifier), specifier).toBe(true);
    }
    expect(importsSvelteRuntime('svelte')).toBe(true);
    expect(importsSvelteRuntime('@ai-usage/design-system/svelte')).toBe(true);
    expect(isSvelteRuntimeLeaf(path.join(featureDirectory, 'model.ts'))).toBe(false);
    expect(isSvelteRuntimeLeaf(path.join(featureDirectory, 'context.svelte.ts'))).toBe(true);
    expect(isForbiddenLocalSource(path.join(featureDirectory, 'legacy.tsx'))).toBe(true);
    expect(isForbiddenLocalSource(path.join(featureDirectory, 'endpoint.server.ts'))).toBe(true);
  });
});
