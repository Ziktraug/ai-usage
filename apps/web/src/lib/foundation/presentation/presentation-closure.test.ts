import { describe, expect, test } from 'bun:test';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IMPORT_SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.svelte'] as const;
const FORBIDDEN_PACKAGES = ['solid-js', '@ai-usage/design-system/solid'] as const;
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
  const candidates = path.extname(unresolvedPath)
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
      expect(path.extname(sourcePath), sourcePath).toBe('.ts');
      expect(sourcePath.includes('.server.'), sourcePath).toBe(false);
      expect(sourcePath.includes(`${path.sep}server${path.sep}`), sourcePath).toBe(false);

      const source = await readFile(sourcePath, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        expect(specifier.startsWith('node:'), `${sourcePath} imports ${specifier}`).toBe(false);
        expect(specifier.startsWith('$lib/server'), `${sourcePath} imports ${specifier}`).toBe(false);
        expect(
          FORBIDDEN_PACKAGES.some((forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`)),
          `${sourcePath} imports ${specifier}`,
        ).toBe(false);
        if (specifier.startsWith('.')) {
          pending.push(await resolveLocalImport(sourcePath, specifier));
        }
      }
    }

    expect(visited.has(path.join(sourceDirectory, 'lib/foundation/presentation/report-value.ts'))).toBe(true);
    expect(visited.has(path.join(sourceDirectory, 'lib/foundation/presentation/format.ts'))).toBe(true);
  });
});
