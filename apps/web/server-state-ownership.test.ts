import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = fileURLToPath(new URL('./src', import.meta.url));
const SOURCE_FILE_PATTERN = /\.(?:svelte|ts)$/;
const TEST_FILE_PATTERN = /(?:\.test|\.fixture|\.ssr\.test)\.(?:svelte|ts)$/;
const IMPERATIVE_QUERY_PATTERN =
  /\.(fetchInfiniteQuery|fetchNextPage|fetchQuery|ensureQueryData|getQueryData|getQueryState)\(/g;

const SERVER_PREFETCH_HELPERS = new Set([
  'lib/features/memory/memory-load.ts',
  'lib/features/projects/projects-load.ts',
  'lib/features/report/core/report-bootstrap.ts',
  'lib/features/skills/shell/data.ts',
  'lib/features/sync/sync-load.ts',
]);

const LEGACY_MIGRATION_EXCEPTIONS: readonly string[] = [];

const sourceFilesUnder = async (directory: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFilesUnder(path)));
    } else if (entry.isFile() && SOURCE_FILE_PATTERN.test(entry.name) && !TEST_FILE_PATTERN.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
};

const normalizedRelativePath = (path: string): string => relative(SOURCE_ROOT, path).replaceAll('\\', '/');

describe('browser server-state ownership boundary', () => {
  test('keeps imperative acquisition in Query modules, SSR prefetch, or the frozen migration allowlist', async () => {
    const legacyFindings = new Set<string>();
    const unexpectedFindings: string[] = [];

    for (const path of await sourceFilesUnder(SOURCE_ROOT)) {
      const relativePath = normalizedRelativePath(path);
      if (relativePath.startsWith('lib/query/') || SERVER_PREFETCH_HELPERS.has(relativePath)) {
        continue;
      }
      const source = await readFile(path, 'utf8');
      for (const match of source.matchAll(IMPERATIVE_QUERY_PATTERN)) {
        const finding = `${relativePath}:${match[1]}`;
        if (LEGACY_MIGRATION_EXCEPTIONS.includes(finding)) {
          legacyFindings.add(finding);
        } else {
          unexpectedFindings.push(finding);
        }
      }
    }

    expect(unexpectedFindings.sort()).toEqual([]);
    expect([...legacyFindings].sort()).toEqual([...LEGACY_MIGRATION_EXCEPTIONS].sort());
  });

  test('constructs TanStack QueryClient only inside the document/request-scoped client factory', async () => {
    const constructors: string[] = [];
    for (const path of await sourceFilesUnder(SOURCE_ROOT)) {
      const source = await readFile(path, 'utf8');
      if (source.includes('new TanStackQueryClient(') || source.includes('new QueryClient(')) {
        constructors.push(normalizedRelativePath(path));
      }
    }

    expect(constructors).toEqual(['lib/query/client.ts']);
  });

  test('does not construct a Query runtime in the root universal load', async () => {
    const rootLayoutLoad = await readFile(join(SOURCE_ROOT, 'routes/+layout.ts'), 'utf8');

    expect(rootLayoutLoad).not.toContain('createWebQueryClient');
    expect(rootLayoutLoad).not.toContain('createWebQueryRuntime');
    expect(rootLayoutLoad).not.toContain('createWebQueryLoadState');
  });
});
