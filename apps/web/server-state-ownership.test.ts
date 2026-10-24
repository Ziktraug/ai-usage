import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = fileURLToPath(new URL('./src', import.meta.url));
const SOURCE_FILE_PATTERN = /\.(?:svelte|ts)$/;
const TEST_FILE_PATTERN = /(?:\.test|\.fixture|\.ssr\.test)\.(?:svelte|ts)$/;
// TanStack Query 5.102 folds fetch/prefetch/ensure into `query()` and `infiniteQuery()`; the deprecated
// names stay listed so a call written against either API is caught.
const IMPERATIVE_QUERY_METHODS: ReadonlySet<string> = new Set([
  'ensureInfiniteQueryData',
  'ensureQueryData',
  'fetchInfiniteQuery',
  'fetchNextPage',
  'fetchQuery',
  'getQueryData',
  'getQueryState',
  'infiniteQuery',
  'prefetchInfiniteQuery',
  'prefetchQuery',
  'query',
]);
const IMPERATIVE_QUERY_NAMES = [...IMPERATIVE_QUERY_METHODS].join('|');
// A member call, named with a dot (`.query(`) or computed in any quote style (`['query'](`), also
// with type arguments (`.query<Report>(`), optional (`.query?.(`), with whitespace or a line break
// before the call, or through `.call`/`.apply`/`.bind`.
const IMPERATIVE_QUERY_PATTERN = new RegExp(
  `(?:\\.(${IMPERATIVE_QUERY_NAMES})|\\[\\s*(['"\`])(${IMPERATIVE_QUERY_NAMES})\\2\\s*\\])` +
    '\\s*(?:\\?\\.\\s*)?(?:<[^()]*>)?\\s*(?:\\??\\.\\s*(?:apply|bind|call)\\s*)?(?:\\?\\.\\s*)?\\(',
  'g',
);
// A method destructured off a client (`const { fetchQuery } = queryClient`) leaves no member call
// for the pattern above, so the names destructured from a `…Client`/`…client` binding are read.
const CLIENT_DESTRUCTURING_PATTERN = /\{([^{}]*)\}\s*=\s*(?:await\s+)?[\w$.]*[Cc]lient\b/g;
const DESTRUCTURED_NAME_PATTERN = /(?:^|,)\s*(?:\.\.\.)?([\w$]+)/g;
// Line, block and markup comments are blanked before either pattern runs, so prose such as
// `// runtime.query (once)` is not read as a call. String and template literals are matched first
// and kept, so a `//` or `/*` inside one does not start a comment.
const COMMENT_OR_LITERAL_PATTERN =
  /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|\/\/[^\n]*/g;
// Known limits of this text scan, accepted rather than growing it into a parser: a method aliased
// without a call (`const fetch = queryClient.fetchQuery;`), a method destructured from a binding
// not named `…client` (`const { fetchQuery } = runtime;`), a method destructured in a parameter
// (`({ fetchQuery }) => …`), a computed member built from a template with substitutions, and a
// regular-expression literal holding a quote or a comment marker, which can throw the comment
// blanking off for the rest of its line.

const withoutComments = (source: string): string =>
  source.replace(COMMENT_OR_LITERAL_PATTERN, (token) => (token.startsWith('/') || token.startsWith('<') ? ' ' : token));

const SERVER_PREFETCH_HELPERS = new Set([
  'lib/features/campaigns/campaigns-load.ts',
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

/** Imperative Query acquisitions in one source file, as `path:method`; Query modules and SSR prefetch own theirs. */
const imperativeQueryFindings = (relativePath: string, source: string): string[] => {
  if (relativePath.startsWith('lib/query/') || SERVER_PREFETCH_HELPERS.has(relativePath)) {
    return [];
  }
  const code = withoutComments(source);
  const calls = [...code.matchAll(IMPERATIVE_QUERY_PATTERN)].flatMap((match) => {
    const method = match[1] ?? match[3];
    return method ? [method] : [];
  });
  const destructured = [...code.matchAll(CLIENT_DESTRUCTURING_PATTERN)].flatMap((match) =>
    [...(match[1] ?? '').matchAll(DESTRUCTURED_NAME_PATTERN)].flatMap((name) =>
      name[1] && IMPERATIVE_QUERY_METHODS.has(name[1]) ? [name[1]] : [],
    ),
  );
  return [...calls, ...destructured].map((method) => `${relativePath}:${method}`);
};

describe('browser server-state ownership boundary', () => {
  test('keeps imperative acquisition in Query modules, SSR prefetch, or the frozen migration allowlist', async () => {
    const legacyFindings = new Set<string>();
    const unexpectedFindings: string[] = [];

    for (const path of await sourceFilesUnder(SOURCE_ROOT)) {
      const relativePath = normalizedRelativePath(path);
      for (const finding of imperativeQueryFindings(relativePath, await readFile(path, 'utf8'))) {
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

  test('flags the query() and infiniteQuery() acquisitions outside their owners', () => {
    const source = [
      'const report = await queryClient.query(reportOptions);',
      'const sessions = await queryClient.infiniteQuery(sessionOptions);',
      'await queryClient.fetchQuery(legacyOptions);',
      'const options = queryOptions({ queryKey, queryFn });',
    ].join('\n');

    expect(imperativeQueryFindings('lib/features/report/report-page.svelte', source)).toEqual([
      'lib/features/report/report-page.svelte:query',
      'lib/features/report/report-page.svelte:infiniteQuery',
      'lib/features/report/report-page.svelte:fetchQuery',
    ]);
    expect(imperativeQueryFindings('lib/query/options/report.ts', source)).toEqual([]);
    expect(imperativeQueryFindings('lib/features/campaigns/campaigns-load.ts', source)).toEqual([]);
  });

  test('flags acquisitions written with type arguments, across lines, bound or destructured', () => {
    const source = [
      'const report = await queryClient.query<Report>(reportOptions);',
      'const pages = await queryClient.infiniteQuery<Page, Error, Data, Key, Cursor>(pageOptions);',
      'const cached = queryClient.getQueryData<Map<string, Report>>(reportKey);',
      'await queryClient',
      '  .fetchQuery <Report> (legacyOptions);',
      'await queryClient.prefetchQuery.call(queryClient, prefetchOptions);',
      'const { ensureQueryData, setQueryData: write } = queryClient;',
      'const typed = queryOptions<Report>({ queryKey, queryFn });',
      'const { query, text } = $props();',
    ].join('\n');

    expect(imperativeQueryFindings('lib/features/report/report-page.svelte', source)).toEqual([
      'lib/features/report/report-page.svelte:query',
      'lib/features/report/report-page.svelte:infiniteQuery',
      'lib/features/report/report-page.svelte:getQueryData',
      'lib/features/report/report-page.svelte:fetchQuery',
      'lib/features/report/report-page.svelte:prefetchQuery',
      'lib/features/report/report-page.svelte:ensureQueryData',
    ]);
  });

  test('flags optional calls and computed members in any quote style', () => {
    const source = [
      'await queryClient.fetchQuery?.(legacyOptions);',
      "const report = await queryClient['query'](reportOptions);",
      'const pages = await queryClient?.["infiniteQuery"]<Page>(pageOptions);',
      'const cached = queryClient[`getQueryData`]?.(reportKey);',
      "await queryClient[ 'prefetchQuery' ]?.call(queryClient, prefetchOptions);",
      "const key = queryClient['queryKey'](reportKey);",
    ].join('\n');

    expect(imperativeQueryFindings('lib/features/report/report-page.svelte', source)).toEqual([
      'lib/features/report/report-page.svelte:fetchQuery',
      'lib/features/report/report-page.svelte:query',
      'lib/features/report/report-page.svelte:infiniteQuery',
      'lib/features/report/report-page.svelte:getQueryData',
      'lib/features/report/report-page.svelte:prefetchQuery',
    ]);
  });

  test('ignores calls named in comments but not calls next to a string holding a comment marker', () => {
    const source = [
      '// The report is read through runtime.query (once) per navigation.',
      '/* queryClient.fetchQuery(legacyOptions) moved to the Query module. */',
      '/**',
      ' * Prefetch with queryClient.prefetchQuery(options) in the load, never here;',
      ' * const { ensureQueryData } = queryClient;',
      ' */',
      '<!-- queryClient.infiniteQuery(sessionOptions) -->',
      "const endpoint = 'http://127.0.0.1/rpc'; const cached = queryClient.getQueryData(reportKey);",
      'const marker = "/* not a comment */"; await queryClient.ensureQueryData(reportOptions);',
    ].join('\n');

    expect(imperativeQueryFindings('lib/features/report/report-page.svelte', source)).toEqual([
      'lib/features/report/report-page.svelte:getQueryData',
      'lib/features/report/report-page.svelte:ensureQueryData',
    ]);
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
