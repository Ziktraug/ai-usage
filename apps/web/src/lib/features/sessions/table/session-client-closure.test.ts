import { afterEach, describe, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IMPORT_SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;
const SOURCE_EXTENSIONS = ['.svelte.ts', '.ts', '.svelte', '.tsx', '.mjs', '.js', '.d.ts'] as const;
const FORBIDDEN_SPECIFIERS = [
  '@ai-usage/report-data',
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
  path.join(sourceDirectory, 'lib/features/sessions/table/session-table-query-owner.ts'),
  path.join(sourceDirectory, 'lib/features/report/composition/sessions-destination.svelte'),
  path.join(sourceDirectory, 'lib/features/report/composition/session-destination-refresh.svelte'),
] as const;
const temporaryDirectories: string[] = [];

interface WorkspacePackage {
  readonly directory: string;
  readonly exports: Record<string, unknown>;
  readonly name: string;
}

interface ClosureResult {
  readonly external: ReadonlySet<string>;
  readonly violations: readonly string[];
  readonly visited: ReadonlySet<string>;
}

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const resolveSourcePath = async (unresolved: string): Promise<string | undefined> => {
  const candidates = [
    unresolved,
    ...(path.extname(unresolved) ? [`${unresolved}.ts`] : []),
    ...SOURCE_EXTENSIONS.flatMap((extension) => [
      `${unresolved}${extension}`,
      path.join(unresolved, `index${extension}`),
    ]),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return;
};

const exportTarget = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  const conditions = value as Record<string, unknown>;
  return exportTarget(conditions.import) ?? exportTarget(conditions.types) ?? exportTarget(conditions.default);
};

const packageNameAndSubpath = (specifier: string): { name: string; subpath: string } => {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
  const remainder = parts.slice(specifier.startsWith('@') ? 2 : 1).join('/');
  return { name, subpath: remainder ? `./${remainder}` : '.' };
};

const resolveWorkspacePackage = async (
  specifier: string,
  workspacePackages: ReadonlyMap<string, WorkspacePackage>,
): Promise<string | undefined> => {
  const { name, subpath } = packageNameAndSubpath(specifier);
  const workspacePackage = workspacePackages.get(name);
  if (!workspacePackage) {
    return;
  }
  const target = exportTarget(workspacePackage.exports[subpath]);
  return target ? await resolveSourcePath(path.resolve(workspacePackage.directory, target)) : undefined;
};

const isForbiddenSpecifier = (specifier: string): boolean =>
  specifier.startsWith('@tanstack/solid') ||
  FORBIDDEN_SPECIFIERS.some(
    (forbidden) =>
      specifier === forbidden || specifier.startsWith(forbidden.endsWith(':') ? forbidden : `${forbidden}/`),
  ) ||
  specifier.includes('local-machine') ||
  specifier.includes('.server');

const isForbiddenPath = (filePath: string): boolean =>
  filePath.endsWith('.tsx') || filePath.includes(`${path.sep}server${path.sep}`) || filePath.includes('.server.');

const specifiersFrom = (source: string): readonly string[] =>
  [...source.matchAll(IMPORT_SPECIFIER_PATTERN)].flatMap((match) => (match[1] ? [match[1]] : []));

const inspectClosure = async (options: {
  readonly entries: readonly string[];
  readonly libDirectory: string;
  readonly workspacePackages: ReadonlyMap<string, WorkspacePackage>;
}): Promise<ClosureResult> => {
  const external = new Set<string>();
  const pending = [...options.entries];
  const violations: string[] = [];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const sourcePath = pending.pop();
    if (!(sourcePath && !visited.has(sourcePath))) {
      continue;
    }
    visited.add(sourcePath);
    if (isForbiddenPath(sourcePath)) {
      violations.push(`forbidden source ${sourcePath}`);
      continue;
    }
    const source = await readFile(sourcePath, 'utf8');
    for (const specifier of specifiersFrom(source)) {
      if (isForbiddenSpecifier(specifier)) {
        violations.push(`${sourcePath} imports ${specifier}`);
        continue;
      }
      let resolved: string | undefined;
      if (specifier.startsWith('.')) {
        resolved = await resolveSourcePath(path.resolve(path.dirname(sourcePath), specifier));
      } else if (specifier.startsWith('$lib/')) {
        resolved = await resolveSourcePath(path.join(options.libDirectory, specifier.slice('$lib/'.length)));
      } else {
        resolved = await resolveWorkspacePackage(specifier, options.workspacePackages);
        if (!resolved) {
          external.add(specifier);
          continue;
        }
      }
      if (!resolved) {
        violations.push(`cannot resolve ${specifier} from ${sourcePath}`);
        continue;
      }
      pending.push(resolved);
    }
  }
  return { external, violations, visited };
};

const loadWorkspacePackages = async (packagesDirectory: string): Promise<Map<string, WorkspacePackage>> => {
  const packages = new Map<string, WorkspacePackage>();
  for (const entry of await readdir(packagesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = path.join(packagesDirectory, entry.name);
    const manifestPath = path.join(directory, 'package.json');
    if (!(await exists(manifestPath))) {
      continue;
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      exports?: Record<string, unknown>;
      name?: string;
    };
    if (manifest.name && manifest.exports) {
      packages.set(manifest.name, { directory, exports: manifest.exports, name: manifest.name });
    }
  }
  return packages;
};

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe('recursive Sessions Svelte client closure', () => {
  test('resolves Svelte companions, aliases, workspace exports, and allowed external framework leaves', async () => {
    const workspacePackages = await loadWorkspacePackages(path.join(repositoryDirectory, 'packages'));
    const result = await inspectClosure({
      entries: entryPaths,
      libDirectory: path.join(sourceDirectory, 'lib'),
      workspacePackages,
    });

    expect(result.violations).toEqual([]);
    expect([...result.visited].some((sourcePath) => sourcePath.endsWith('.svelte.ts'))).toBe(true);
    expect([...result.visited].some((sourcePath) => sourcePath.includes('/packages/report-core/'))).toBe(true);
    expect([...result.visited].some((sourcePath) => sourcePath.includes('/packages/web-contract/'))).toBe(true);
    expect([...result.visited].some((sourcePath) => sourcePath.includes('/packages/design-system/'))).toBe(true);
    expect(result.external.has('@tanstack/table-core')).toBe(true);
    expect(result.external.has('@tanstack/svelte-query')).toBe(true);
    expect([...result.visited].some((sourcePath) => sourcePath.endsWith('/lib/rpc/session-client.ts'))).toBe(true);
    expect([...result.visited].some((sourcePath) => sourcePath.endsWith('/lib/query/options/session.ts'))).toBe(true);
    expect([...result.visited].some((sourcePath) => sourcePath.endsWith('/served-report-session.ts'))).toBe(true);
    expect(
      [...result.visited].some((sourcePath) => sourcePath.endsWith('/served-report-session-owner.svelte.ts')),
    ).toBe(true);
    expect([...result.visited].some((sourcePath) => sourcePath.endsWith('/sessions-destination-state.svelte'))).toBe(
      true,
    );
  });

  test('finds hidden Solid, server, Node, and writer leaks behind every supported resolution seam', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-p3-closure-'));
    temporaryDirectories.push(directory);
    const libDirectory = path.join(directory, 'lib');
    const packageDirectory = path.join(directory, 'packages/hidden');
    await mkdir(libDirectory, { recursive: true });
    await mkdir(path.join(packageDirectory, 'src'), { recursive: true });
    await writeFile(
      path.join(directory, 'entry.ts'),
      "import './hidden.svelte'; import '$lib/alias'; import '@fixture/hidden';",
    );
    await writeFile(path.join(directory, 'hidden.svelte.ts'), "import 'solid-js';");
    await writeFile(path.join(libDirectory, 'alias.ts'), "import 'node:path';");
    const writerPackage = ['@ai-usage', 'usage-merge'].join('/');
    await writeFile(path.join(packageDirectory, 'src/index.ts'), `import '${writerPackage}';`);
    const workspacePackages = new Map<string, WorkspacePackage>([
      ['@fixture/hidden', { directory: packageDirectory, exports: { '.': './src/index.ts' }, name: '@fixture/hidden' }],
    ]);

    const result = await inspectClosure({
      entries: [path.join(directory, 'entry.ts')],
      libDirectory,
      workspacePackages,
    });

    expect(result.violations.some((violation) => violation.includes('solid-js'))).toBe(true);
    expect(result.violations.some((violation) => violation.includes('node:path'))).toBe(true);
    expect(result.violations.some((violation) => violation.includes('@ai-usage/usage-merge'))).toBe(true);
  });
});
