import { expect, test } from 'bun:test';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.svelte'] as const;
const IMPORT_SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;
const SCRIPT_BLOCK_PATTERN = /<script[^>]*>([\s\S]*?)<\/script>/gu;
const FORBIDDEN_RUNTIME_PREFIXES = ['@ark-ui/solid', '@ark-ui/svelte'] as const;
const ALLOWED_EXTERNAL_IMPORTS = new Set(['@ai-usage/design-system/css', 'svelte']);
const packageSourceDirectory = fileURLToPath(new URL('.', import.meta.url));
const sveltePassivePath = path.resolve(packageSourceDirectory, 'svelte-passive.ts');

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
  throw new Error(`Cannot resolve passive import ${specifier} from ${sourcePath}.`);
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

const collectScriptSpecifiers = (source: string): string[] => {
  const specifiers: string[] = [];
  for (const block of source.matchAll(SCRIPT_BLOCK_PATTERN)) {
    if (block[1]) {
      specifiers.push(...importSpecifiers(block[1]));
    }
  }
  return specifiers;
};

const collectSvelteSource = async (sourcePath: string): Promise<string> => {
  const text = await Bun.file(sourcePath).text();
  const importSpec = importSpecifiers(text);
  const scriptSpec = collectScriptSpecifiers(text);
  return [...importSpec, ...scriptSpec].join('\n');
};

test('svelte-passive closure never reaches Ark UI', async () => {
  const pending = [sveltePassivePath];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const sourcePath = pending.pop();
    if (!sourcePath || visited.has(sourcePath)) {
      continue;
    }
    visited.add(sourcePath);
    expect(
      SOURCE_EXTENSIONS.some((extension) => sourcePath.endsWith(extension)),
      sourcePath,
    ).toBe(true);

    const extension = path.extname(sourcePath);
    const specifiers =
      extension === '.svelte'
        ? (await collectSvelteSource(sourcePath)).split('\n').filter((entry) => entry.length > 0)
        : importSpecifiers(await Bun.file(sourcePath).text());
    for (const specifier of specifiers) {
      if (!specifier) {
        continue;
      }
      expect(
        FORBIDDEN_RUNTIME_PREFIXES.some(
          (runtimePrefix) => specifier === runtimePrefix || specifier.startsWith(`${runtimePrefix}/`),
        ),
        `${sourcePath} imports forbidden runtime ${specifier}`,
      ).toBe(false);
      if (specifier.startsWith('.')) {
        pending.push(await resolveRelativeImport(sourcePath, specifier));
      } else {
        expect(ALLOWED_EXTERNAL_IMPORTS.has(specifier), `${sourcePath} imports unexpected package ${specifier}`).toBe(
          true,
        );
      }
    }
  }

  expect(visited.has(sveltePassivePath)).toBe(true);
  expect([...visited].some((sourcePath) => sourcePath.endsWith('/svelte/controls/segment-bar.svelte'))).toBe(true);
  expect([...visited].some((sourcePath) => sourcePath.endsWith('/svelte/controls/metric-tile.svelte'))).toBe(true);
  expect([...visited].every((sourcePath) => !sourcePath.includes('@ark-ui/svelte'))).toBe(true);
});
