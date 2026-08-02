import { expect, test } from 'bun:test';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessFillFor } from './harness-fill';

const PASSIVE_MODULES = [
  '../../components/button.ts',
  '../../components/chart.ts',
  '../../components/empty-state.ts',
  '../../components/field.ts',
  '../../components/layout.ts',
  '../../components/overview.ts',
  '../../components/panel.ts',
  '../../components/refresh.ts',
  '../../components/skills.ts',
  '../../components/status.ts',
  '../../components/table.ts',
  '../../components/time-slider.ts',
] as const;
const IMPORT_SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;
const FORBIDDEN_RUNTIME_PREFIXES = ['@ark-ui/solid', '@ark-ui/svelte', 'solid-js', 'svelte'] as const;
const ALLOWED_EXTERNAL_IMPORTS = new Set(['@ai-usage/design-system/css']);
const SOURCE_EXTENSIONS = ['.ts', '.tsx'] as const;
const passiveDirectory = fileURLToPath(new URL('.', import.meta.url));

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

test('passive design closure imports no component or framework runtime', async () => {
  const pending = PASSIVE_MODULES.map((modulePath) => path.resolve(passiveDirectory, modulePath));
  const visited = new Set<string>();

  while (pending.length > 0) {
    const sourcePath = pending.pop();
    if (!sourcePath || visited.has(sourcePath)) {
      continue;
    }
    visited.add(sourcePath);
    expect(path.extname(sourcePath), sourcePath).toBe('.ts');

    const source = await Bun.file(sourcePath).text();
    for (const specifier of importSpecifiers(source)) {
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

  expect([...visited].some((sourcePath) => sourcePath.endsWith('/svelte/passive/harness-fill.ts'))).toBe(true);
  expect([...visited].every((sourcePath) => !sourcePath.endsWith('.tsx'))).toBe(true);
});

test('neutral harness fills preserve known family and fallback semantics', () => {
  expect(harnessFillFor('Claude Code')).toBe(harnessFillFor('claude'));
  expect(harnessFillFor('codex-cli')).toBe(harnessFillFor('codex'));
  expect(harnessFillFor('Cursor')).toBe(harnessFillFor('cursor'));
  expect(harnessFillFor('OpenCode')).toBe(harnessFillFor('opencode'));
  expect(harnessFillFor('Gemini CLI')).toBe(harnessFillFor('gemini'));
  expect(harnessFillFor('unknown')).toBeUndefined();
});
