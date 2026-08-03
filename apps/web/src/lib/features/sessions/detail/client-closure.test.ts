import { describe, expect, test } from 'bun:test';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;
const SOURCE_EXTENSIONS = ['.svelte.ts', '.ts', '.svelte', '.tsx', '.mjs', '.js', '.d.ts'] as const;
const FORBIDDEN_SPECIFIERS = [
  '@ai-usage/design-system/report',
  '@ai-usage/design-system/solid',
  '@ai-usage/report-data',
  '@ai-usage/usage-engine-runtime',
  '@ai-usage/usage-merge',
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
const entries = [
  path.join(sourceDirectory, 'lib/features/sessions/detail/controller.ts'),
  path.join(sourceDirectory, 'lib/features/sessions/detail/query-owner.ts'),
  path.join(sourceDirectory, 'lib/features/sessions/detail/session-detail-slot.svelte'),
  path.join(sourceDirectory, 'lib/features/sessions/detail/session-drawer.svelte'),
  path.join(sourceDirectory, 'lib/features/sessions/detail/session-analysis.svelte'),
  path.join(sourceDirectory, 'lib/features/sessions/detail/session-vcs-summary.svelte'),
] as const;

interface WorkspacePackage {
  readonly directory: string;
  readonly exports: Record<string, unknown>;
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

const packageIdentity = (specifier: string): { readonly name: string; readonly subpath: string } => {
  const parts = specifier.split('/');
  const scoped = specifier.startsWith('@');
  const name = scoped ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
  const remainder = parts.slice(scoped ? 2 : 1).join('/');
  return { name, subpath: remainder ? `./${remainder}` : '.' };
};

const workspacePackages = async (): Promise<Map<string, WorkspacePackage>> => {
  const result = new Map<string, WorkspacePackage>();
  const packagesDirectory = path.join(repositoryDirectory, 'packages');
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
      readonly exports?: Record<string, unknown>;
      readonly name?: string;
    };
    if (manifest.name && manifest.exports) {
      result.set(manifest.name, { directory, exports: manifest.exports });
    }
  }
  return result;
};

const resolveWorkspaceImport = async (
  specifier: string,
  packages: ReadonlyMap<string, WorkspacePackage>,
): Promise<string | undefined> => {
  const identity = packageIdentity(specifier);
  const workspacePackage = packages.get(identity.name);
  const target = workspacePackage ? exportTarget(workspacePackage.exports[identity.subpath]) : undefined;
  return workspacePackage && target
    ? await resolveSourcePath(path.resolve(workspacePackage.directory, target))
    : undefined;
};

const isForbiddenSpecifier = (specifier: string): boolean =>
  FORBIDDEN_SPECIFIERS.some(
    (forbidden) =>
      specifier === forbidden || specifier.startsWith(forbidden.endsWith(':') ? forbidden : `${forbidden}/`),
  ) ||
  specifier.includes('local-machine') ||
  specifier.includes('.server');

const isForbiddenPath = (filePath: string): boolean =>
  filePath.endsWith('.tsx') || filePath.includes(`${path.sep}server${path.sep}`) || filePath.includes('.server.');

const resolveImport = async (
  sourcePath: string,
  specifier: string,
  packages: ReadonlyMap<string, WorkspacePackage>,
): Promise<string | undefined> => {
  if (specifier.startsWith('.')) {
    return await resolveSourcePath(path.resolve(path.dirname(sourcePath), specifier));
  }
  if (specifier.startsWith('$lib/')) {
    return await resolveSourcePath(path.join(sourceDirectory, 'lib', specifier.slice('$lib/'.length)));
  }
  return await resolveWorkspaceImport(specifier, packages);
};

describe('P4 recursive Svelte client closure', () => {
  test('resolves workspace exports and excludes Solid, TSX, Node, server, and writer leaves', async () => {
    const packages = await workspacePackages();
    const pending = [...entries];
    const visited = new Set<string>();
    const violations: string[] = [];

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
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1];
        if (!specifier) {
          continue;
        }
        if (isForbiddenSpecifier(specifier)) {
          violations.push(`${sourcePath} imports ${specifier}`);
          continue;
        }
        const resolved = await resolveImport(sourcePath, specifier, packages);
        if (resolved) {
          pending.push(resolved);
        }
      }
    }

    expect(violations).toEqual([]);
    expect([...visited].some((sourcePath) => sourcePath.endsWith('/packages/design-system/src/svelte.ts'))).toBe(true);
    expect([...visited].some((sourcePath) => sourcePath.endsWith('/lib/query/options/session.ts'))).toBe(true);
    expect([...visited].some((sourcePath) => sourcePath.endsWith('/lib/rpc/session-client.ts'))).toBe(true);
    expect([...visited].some((sourcePath) => sourcePath.endsWith('/session-analysis-model.ts'))).toBe(true);
  });
});
