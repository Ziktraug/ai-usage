import { expect, test } from 'bun:test';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IMPORT_SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;
const SOURCE_EXTENSIONS = ['.svelte', '.ts'] as const;
const ALLOWED_SVELTE_PACKAGES = ['@ai-usage/design-system/css', '@ark-ui/svelte', 'svelte'] as const;
const FORBIDDEN_SVELTE_PACKAGES = ['@ark-ui/solid', 'solid-js'] as const;
const packageSourceDirectory = fileURLToPath(new URL('.', import.meta.url));
const packageDirectory = path.resolve(packageSourceDirectory, '..');

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const resolveRelativeImport = async (sourcePath: string, specifier: string): Promise<string> => {
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
  throw new Error(`Cannot resolve design-system import ${specifier} from ${sourcePath}.`);
};

const importSpecifiers = (source: string): string[] => {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
};

test('public design entrypoints keep framework runtimes explicit', async () => {
  const manifest = await Bun.file(path.join(packageDirectory, 'package.json')).json();

  expect(manifest.exports['.']).toEqual({ import: './src/index.ts', types: './src/index.ts' });
  expect(manifest.exports['./solid']).toBeUndefined();
  expect(manifest.exports['./svelte']).toEqual({ import: './src/svelte.ts', types: './src/svelte.ts' });

  const rootSource = await Bun.file(path.join(packageSourceDirectory, 'index.ts')).text();
  expect(rootSource).toBe("export { aiUsagePreset } from './preset';\n");
  expect(await Bun.file(path.join(packageSourceDirectory, 'svelte.ts')).text()).toContain(
    "from './svelte/controls/toggle.svelte'",
  );
  // The chart module is framework-neutral, so `/svelte` re-exports it directly.
  // Assert the source and the series-colour surface rather than one exact export
  // list, which changes whenever a consumer needs another neutral helper.
  const svelteSource = await Bun.file(path.join(packageSourceDirectory, 'svelte.ts')).text();
  expect(svelteSource).toContain("from './components/chart'");
  for (const name of ['accentFill', 'dimensionSwatch', 'stableSeriesColor']) {
    expect(svelteSource, name).toContain(name);
  }
});

test('the public Svelte dependency closure cannot reach Solid or Ark Solid', async () => {
  const pending = [path.join(packageSourceDirectory, 'svelte.ts')];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const sourcePath = pending.pop();
    if (!sourcePath || visited.has(sourcePath)) {
      continue;
    }
    visited.add(sourcePath);
    expect(path.extname(sourcePath), sourcePath).not.toBe('.tsx');

    const source = await Bun.file(sourcePath).text();
    for (const specifier of importSpecifiers(source)) {
      const importsForbiddenRuntime = FORBIDDEN_SVELTE_PACKAGES.some(
        (runtime) => specifier === runtime || specifier.startsWith(`${runtime}/`),
      );
      expect(importsForbiddenRuntime, `${sourcePath} imports forbidden runtime ${specifier}`).toBe(false);
      if (specifier.startsWith('.')) {
        pending.push(await resolveRelativeImport(sourcePath, specifier));
        continue;
      }
      const importsAllowedRuntime = ALLOWED_SVELTE_PACKAGES.some(
        (runtime) => specifier === runtime || specifier.startsWith(`${runtime}/`),
      );
      expect(importsAllowedRuntime, `${sourcePath} imports unexpected package ${specifier}`).toBe(true);
    }
  }

  const visitedPaths = [...visited];
  expect(visitedPaths.some((sourcePath) => sourcePath.endsWith('/svelte/controls/toggle.svelte'))).toBe(true);
  expect(visitedPaths.some((sourcePath) => sourcePath.endsWith('/svelte/overlays/drawer.svelte'))).toBe(true);
  expect(visitedPaths.some((sourcePath) => sourcePath.endsWith('/svelte/compound/tabs.svelte'))).toBe(true);
  expect(
    visitedPaths
      .filter((sourcePath) => sourcePath.includes('/components/'))
      .every((sourcePath) => sourcePath.endsWith('.ts')),
  ).toBe(true);
});

test('Panda scans the aggregate TypeScript and Svelte source surface', async () => {
  const pandaConfig = await Bun.file(path.join(packageDirectory, 'panda.config.ts')).text();
  expect(pandaConfig).toContain("include: ['./src/**/*.{ts,svelte}']");
});
