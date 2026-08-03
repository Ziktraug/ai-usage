import { describe, expect, test } from 'bun:test';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IMPORT_SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;
const SOURCE_EXTENSIONS = ['.ts', '.svelte', '.tsx'] as const;
const FORBIDDEN_SPECIFIERS = [
  '@ai-usage/design-system/report',
  '@ai-usage/design-system/solid',
  '@ai-usage/usage-merge',
  '@ai-usage/usage-engine-runtime',
  '@ark-ui/solid',
  '@orpc/server',
  '@tanstack/solid',
  'bun:',
  'lucide-solid',
  'node:',
  'solid-js',
  '$app/server',
  '$lib/server',
] as const;
const sourceDirectory = fileURLToPath(new URL('../../../../', import.meta.url));
const repositoryDirectory = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const entryPaths = [
  path.join(sourceDirectory, 'lib/features/sessions/table/session-table.svelte'),
  path.join(sourceDirectory, 'lib/features/sessions/table/session-table-owner.svelte'),
  path.join(sourceDirectory, 'lib/features/sessions/table/session-table-query-owner.ts'),
] as const;

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const resolveLocal = async (sourcePath: string, specifier: string): Promise<string> => {
  const unresolved = path.resolve(path.dirname(sourcePath), specifier);
  const candidates = path.extname(unresolved)
    ? [unresolved, `${unresolved}.ts`]
    : SOURCE_EXTENSIONS.flatMap((extension) => [
        `${unresolved}${extension}`,
        path.join(unresolved, `index${extension}`),
      ]);
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Cannot resolve Sessions client import ${specifier} from ${sourcePath}`);
};

const packageEntry = (specifier: string): string | undefined => {
  if (specifier === '@ai-usage/design-system/svelte') {
    return path.join(repositoryDirectory, 'packages/design-system/src/svelte.ts');
  }
  return;
};

const specifiersFrom = (source: string): readonly string[] =>
  [...source.matchAll(IMPORT_SPECIFIER_PATTERN)].flatMap((match) => (match[1] ? [match[1]] : []));

const isForbidden = (specifier: string): boolean =>
  specifier.startsWith('@tanstack/solid') ||
  FORBIDDEN_SPECIFIERS.some(
    (forbidden) =>
      specifier === forbidden || specifier.startsWith(forbidden.endsWith(':') ? forbidden : `${forbidden}/`),
  ) ||
  specifier.includes('report-data') ||
  specifier.includes('local-machine') ||
  specifier.includes('.server');

describe('recursive Sessions Svelte client closure', () => {
  test('reaches only Svelte, contract, query, Table Core, and framework-neutral local modules', async () => {
    const pending = [...entryPaths];
    const visited = new Set<string>();
    const external = new Set<string>();

    while (pending.length > 0) {
      const sourcePath = pending.pop();
      if (!sourcePath || visited.has(sourcePath)) {
        continue;
      }
      visited.add(sourcePath);
      expect(sourcePath.endsWith('.tsx'), sourcePath).toBe(false);
      expect(sourcePath.includes(`${path.sep}server${path.sep}`), sourcePath).toBe(false);
      expect(sourcePath.includes('.server.'), sourcePath).toBe(false);

      const source = await readFile(sourcePath, 'utf8');
      for (const specifier of specifiersFrom(source)) {
        expect(isForbidden(specifier), `${sourcePath} imports ${specifier}`).toBe(false);
        if (specifier.startsWith('.')) {
          pending.push(await resolveLocal(sourcePath, specifier));
          continue;
        }
        const mappedEntry = packageEntry(specifier);
        if (mappedEntry) {
          pending.push(mappedEntry);
        } else {
          external.add(specifier);
        }
      }
    }

    expect(external.has('@tanstack/table-core')).toBe(true);
    expect(external.has('@tanstack/svelte-query')).toBe(true);
    expect(
      [...visited].some((sourcePath) => sourcePath.endsWith('/lib/rpc/session-client.ts')),
      'V2 session client adapter must stay reachable',
    ).toBe(true);
    expect(
      [...visited].some((sourcePath) => sourcePath.endsWith('/lib/query/options/session.ts')),
      'Q1 exact session options must stay reachable',
    ).toBe(true);
    expect(
      [...visited].some((sourcePath) => sourcePath.endsWith('/served-report-session.ts')),
      'P1 ServedReportSession adapter seam must stay reachable',
    ).toBe(true);
    expect(
      [...visited].some((sourcePath) => sourcePath.endsWith('/report-lifecycle-owner.svelte')),
      'P1 lifecycle component must own the client-created ServedReportSession',
    ).toBe(true);
  });

  test('classifies the denied server, Solid, writer, and broad design barrel edges', () => {
    for (const specifier of [
      'solid-js',
      '@ark-ui/solid/drawer',
      '@tanstack/solid-table',
      '@ai-usage/design-system/solid',
      '@ai-usage/design-system/report',
      '@ai-usage/usage-merge',
      '@ai-usage/usage-engine-runtime',
      '@orpc/server',
      '$lib/server/rpc',
      'node:path',
      'bun:sqlite',
      './server/report-data.server',
    ]) {
      expect(isForbidden(specifier), specifier).toBe(true);
    }
  });
});
