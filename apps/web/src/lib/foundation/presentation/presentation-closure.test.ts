import { describe, expect, test } from 'bun:test';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IMPORT_SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.svelte'] as const;
const FORBIDDEN_RUNTIME_PREFIXES = [
  'solid-js',
  'svelte',
  '@ark-ui/solid',
  '@ark-ui/svelte',
  '@ai-usage/design-system/solid',
  '@ai-usage/design-system/svelte',
  '@tanstack/solid',
  '@tanstack/svelte',
  '$app',
] as const;
const sourceDirectory = fileURLToPath(new URL('../../../', import.meta.url));
const entryPaths = [
  'dashboard-analytics.ts',
  'dashboard-model.ts',
  'dashboard-sort.ts',
  'overview-model.ts',
  'provider-status-model.ts',
  'campaign-label-overrides.ts',
  'session-analysis-target.ts',
  'lib/foundation/presentation/format.ts',
  'lib/foundation/presentation/report-value.ts',
] as const;

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const resolveLocalImport = async (sourcePath: string, specifier: string): Promise<string> => {
  const unresolvedPath = path.resolve(path.dirname(sourcePath), specifier);
  const hasSourceExtension = SOURCE_EXTENSIONS.some((extension) => unresolvedPath.endsWith(extension));
  const candidates = hasSourceExtension
    ? [unresolvedPath]
    : SOURCE_EXTENSIONS.flatMap((extension) => [
        `${unresolvedPath}${extension}`,
        path.join(unresolvedPath, `index${extension}`),
      ]);
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Cannot resolve presentation import ${specifier} from ${sourcePath}`);
};

const importSpecifiers = (source: string): readonly string[] =>
  [...source.matchAll(IMPORT_SPECIFIER_PATTERN)].flatMap((match) => (match[1] ? [match[1]] : []));

const isForbiddenRuntimeSpecifier = (specifier: string): boolean =>
  specifier.startsWith('node:') ||
  specifier.startsWith('$lib/server') ||
  FORBIDDEN_RUNTIME_PREFIXES.some((forbidden) => specifier.startsWith(forbidden));

const isForbiddenLocalSource = (sourcePath: string): boolean =>
  path.extname(sourcePath) !== '.ts' ||
  sourcePath.includes('.server.') ||
  sourcePath.includes(`${path.sep}server${path.sep}`);

describe('framework-neutral presentation closure', () => {
  test('reusable presentation and dashboard models cannot reach client frameworks or server modules', async () => {
    const pending = entryPaths.map((entryPath) => path.join(sourceDirectory, entryPath));
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
        expect(isForbiddenRuntimeSpecifier(specifier), `${sourcePath} imports ${specifier}`).toBe(false);
        if (specifier.startsWith('.')) {
          pending.push(await resolveLocalImport(sourcePath, specifier));
        }
      }
    }

    expect(visited.has(path.join(sourceDirectory, 'lib/foundation/presentation/report-value.ts'))).toBe(true);
    expect(visited.has(path.join(sourceDirectory, 'lib/foundation/presentation/format.ts'))).toBe(true);
  });

  test('classifies representative framework, TSX, Svelte, Node and server edges', async () => {
    for (const specifier of [
      'solid-js',
      'svelte',
      '@ark-ui/solid/dialog',
      '@ark-ui/svelte/dialog',
      '@ai-usage/design-system/solid',
      '@ai-usage/design-system/svelte',
      '@tanstack/solid-table',
      '@tanstack/svelte-query',
      '$app/state',
      '$lib/server/report',
      'node:path',
    ]) {
      expect(isForbiddenRuntimeSpecifier(specifier), specifier).toBe(true);
    }
    expect(isForbiddenRuntimeSpecifier('@tanstack/table-core')).toBe(false);
    expect(isForbiddenRuntimeSpecifier('@ai-usage/report-core/session-query')).toBe(false);

    const presentationPath = path.join(sourceDirectory, 'lib/foundation/presentation/format.ts');
    expect(isForbiddenLocalSource(await resolveLocalImport(presentationPath, '../../../shared'))).toBe(true);
    expect(isForbiddenLocalSource(await resolveLocalImport(presentationPath, '../../features/shell/app-shell'))).toBe(
      true,
    );
    expect(
      isForbiddenLocalSource(await resolveLocalImport(presentationPath, '../../../server/demo-boundary.server')),
    ).toBe(true);
  });
});
