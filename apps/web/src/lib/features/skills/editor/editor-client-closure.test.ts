import { describe, expect, test } from 'bun:test';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IMPORT_SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;
const TYPE_ONLY_IMPORT_PATTERN = /\bimport\s+type\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?/g;
const SOURCE_EXTENSIONS = ['.ts', '.svelte'] as const;
const FORBIDDEN_SPECIFIER_PREFIXES = [
  'solid-js',
  '@ark-ui/solid',
  '@ai-usage/design-system/solid',
  '@ai-usage/design-system/report',
  '@tanstack/solid',
  '$lib/server',
  'node:',
] as const;
const editorDirectory = fileURLToPath(new URL('./', import.meta.url));
const entryPaths = [
  'controller.ts',
  'discard-dialog-controller.ts',
  'skill-markdown-editor.svelte',
  'skills-editor-slot.svelte',
  'slot-controller.ts',
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
  const candidates = SOURCE_EXTENSIONS.some((extension) => unresolvedPath.endsWith(extension))
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
  throw new Error(`Cannot resolve P9 client import ${specifier} from ${sourcePath}`);
};
const importSpecifiers = (source: string): readonly string[] =>
  [...source.replace(TYPE_ONLY_IMPORT_PATTERN, '').matchAll(IMPORT_SPECIFIER_PATTERN)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
const isForbiddenSpecifier = (specifier: string): boolean =>
  FORBIDDEN_SPECIFIER_PREFIXES.some((forbidden) => specifier.startsWith(forbidden));
const isForbiddenLocalSource = (sourcePath: string): boolean =>
  sourcePath.endsWith('.tsx') || sourcePath.includes('.server.') || sourcePath.includes(`${path.sep}server${path.sep}`);

describe('P9 recursive Skills editor client closure', () => {
  test('cannot reach Solid, TSX, Node, or server implementation modules', async () => {
    const pending = entryPaths.map((entryPath) => path.join(editorDirectory, entryPath));
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
        expect(isForbiddenSpecifier(specifier), `${sourcePath} imports ${specifier}`).toBe(false);
        if (specifier.startsWith('.')) {
          pending.push(await resolveLocalImport(sourcePath, specifier));
        }
      }
    }
    for (const entryPath of entryPaths) {
      expect(visited.has(path.join(editorDirectory, entryPath)), entryPath).toBe(true);
    }
  });

  test('classifies representative forbidden client edges', () => {
    for (const specifier of [
      'solid-js',
      '@ark-ui/solid/dialog',
      '@ai-usage/design-system/solid',
      '@ai-usage/design-system/report',
      '@tanstack/solid-query',
      '$lib/server/skills',
      'node:path',
    ]) {
      expect(isForbiddenSpecifier(specifier), specifier).toBe(true);
    }
    expect(isForbiddenSpecifier('svelte')).toBe(false);
    expect(isForbiddenSpecifier('@tanstack/svelte-query')).toBe(false);
    expect(isForbiddenSpecifier('@ai-usage/design-system/svelte')).toBe(false);
  });
});
