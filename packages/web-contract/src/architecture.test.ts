import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const moduleSpecifierPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;
const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;
const allowedExternalPackages = ['@ai-usage/report-core', '@orpc/contract', 'valibot'] as const;
const allowedExactExternalSpecifiers = new Set(['@ai-usage/skills/config', '@ai-usage/skills/shared']);
const forbiddenWebRouter = ['@ai-usage', 'web', 'server', 'router'].join('/');

interface ContractClosureViolation {
  readonly importer: string;
  readonly path: readonly string[];
  readonly specifier: string;
}

type ContractSources = ReadonlyMap<string, string>;

const collectModuleSpecifiers = (source: string): readonly string[] => {
  const specifiers: string[] = [];
  for (const match of source.matchAll(moduleSpecifierPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
};

const isAllowedExternalSpecifier = (specifier: string): boolean =>
  allowedExactExternalSpecifiers.has(specifier) ||
  allowedExternalPackages.some((packageName) => specifier === packageName || specifier.startsWith(`${packageName}/`));

const resolveRelativeSpecifier = (
  sources: ContractSources,
  importer: string,
  specifier: string,
): string | undefined => {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const candidates = path.posix.extname(base)
    ? [base]
    : [
        ...sourceExtensions.map((extension) => `${base}${extension}`),
        ...sourceExtensions.map((extension) => path.posix.join(base, `index${extension}`)),
      ];
  return candidates.find((candidate) => sources.has(candidate));
};

const collectContractClosureViolations = (
  sources: ContractSources,
  entrypoints: readonly string[],
): readonly ContractClosureViolation[] => {
  const pending = entrypoints.map((entrypoint) => ({ module: entrypoint, path: [entrypoint] as readonly string[] }));
  const visited = new Set<string>();
  const violations: ContractClosureViolation[] = [];

  while (pending.length > 0) {
    const current = pending.shift();
    if (!(current && !visited.has(current.module))) {
      continue;
    }
    visited.add(current.module);
    const source = sources.get(current.module);
    if (source === undefined) {
      violations.push({ importer: current.module, path: current.path, specifier: '<missing-entrypoint>' });
      continue;
    }

    for (const specifier of collectModuleSpecifiers(source)) {
      if (!specifier.startsWith('.')) {
        if (!isAllowedExternalSpecifier(specifier)) {
          violations.push({ importer: current.module, path: current.path, specifier });
        }
        continue;
      }

      const resolved = resolveRelativeSpecifier(sources, current.module, specifier);
      if (resolved === undefined) {
        violations.push({ importer: current.module, path: current.path, specifier });
        continue;
      }
      if (resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
        violations.push({ importer: current.module, path: current.path, specifier });
        continue;
      }
      pending.push({ module: resolved, path: [...current.path, resolved] });
    }
  }

  return violations;
};

const collectProductionSources = async (directory: string, prefix = ''): Promise<Map<string, string>> => {
  const sources = new Map<string, string>();
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectProductionSources(absolute, relative);
      for (const [file, source] of nested) {
        sources.set(file, source);
      }
      continue;
    }
    if (!(entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))) {
      continue;
    }
    sources.set(relative, await readFile(absolute, 'utf8'));
  }

  return sources;
};

describe('web contract production closure', () => {
  test('cannot reach server, runtime, application, Node, or Bun implementations', async () => {
    const sources = await collectProductionSources(import.meta.dir);

    expect(collectContractClosureViolations(sources, [...sources.keys()])).toEqual([]);
  });

  test('fails closed for direct forbidden imports', () => {
    const sources = new Map([['index.ts', "import 'node:fs';\n"]]);

    expect(collectContractClosureViolations(sources, ['index.ts'])).toEqual([
      { importer: 'index.ts', path: ['index.ts'], specifier: 'node:fs' },
    ]);
  });

  test('follows indirect relative imports to forbidden dependencies', () => {
    const sources = new Map([
      ['index.ts', "import './leaf';\n"],
      ['leaf.ts', "import '@orpc/server';\n"],
    ]);

    expect(collectContractClosureViolations(sources, ['index.ts'])).toEqual([
      { importer: 'leaf.ts', path: ['index.ts', 'leaf.ts'], specifier: '@orpc/server' },
    ]);
  });

  test('detects forbidden implementation re-exports', () => {
    const fixtureSource = ["export { router } from '", forbiddenWebRouter, "';\n"].join('');
    const sources = new Map([['index.ts', fixtureSource]]);

    expect(collectContractClosureViolations(sources, ['index.ts'])).toEqual([
      { importer: 'index.ts', path: ['index.ts'], specifier: forbiddenWebRouter },
    ]);
  });

  test('detects literal dynamic imports of runtime modules', () => {
    const sources = new Map([['index.ts', "export const load = () => import('bun:sqlite');\n"]]);

    expect(collectContractClosureViolations(sources, ['index.ts'])).toEqual([
      { importer: 'index.ts', path: ['index.ts'], specifier: 'bun:sqlite' },
    ]);
  });

  test('permits only reviewed pure contract dependencies and internal leaves', () => {
    const sources = new Map([
      ['index.ts', "export { value } from './value';\n"],
      [
        'value.ts',
        "import { oc } from '@orpc/contract';\nimport * as v from 'valibot';\nexport const value = oc.input(v.string());\n",
      ],
    ]);

    expect(collectContractClosureViolations(sources, ['index.ts'])).toEqual([]);
  });
  test('permits only exact reviewed Skills contract entrypoints', () => {
    const unreviewedSkillsSpecifier = ['@ai-usage/skills', 'not-reviewed'].join('/');
    const allowedSources = new Map([
      ['config.ts', "import '@ai-usage/skills/config';\n"],
      ['shared.ts', "import '@ai-usage/skills/shared';\n"],
    ]);
    expect(collectContractClosureViolations(allowedSources, [...allowedSources.keys()])).toEqual([]);

    const rejectedSources = new Map([
      ['application.ts', "import '@ai-usage/skills/application';\n"],
      ['root.ts', 'import \x27@ai-usage/skills\x27;\n'],
      ['unknown.ts', `import \x27${unreviewedSkillsSpecifier}\x27;\n`],
    ]);
    expect(collectContractClosureViolations(rejectedSources, [...rejectedSources.keys()])).toEqual([
      { importer: 'application.ts', path: ['application.ts'], specifier: '@ai-usage/skills/application' },
      { importer: 'root.ts', path: ['root.ts'], specifier: '@ai-usage/skills' },
      { importer: 'unknown.ts', path: ['unknown.ts'], specifier: unreviewedSkillsSpecifier },
    ]);
  });
});
