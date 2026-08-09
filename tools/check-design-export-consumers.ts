import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The migration parity ledger accepts a design export as complete when the file
 * still declares it, which is satisfied by the declaration alone. That let the
 * Activity chart and brush be rebuilt with local `css()` while 183 semantic
 * exports quietly lost every consumer, and the checker stayed green.
 *
 * This measures the real graph: a semantic style export counts as consumed when
 * something outside its own module and the entrypoint barrels imports it. The
 * repository now carries no baseline allowance: any unconsumed semantic export
 * fails the check.
 */

const TS_SUFFIX = /\.ts$/;
const EXPORTED_CONSTANT = /^export const ([A-Za-z_$][\w$]*)/gm;

// Discovered, not listed: a module that loses its last export gets deleted, and a
// hardcoded name would then crash the very check that reported it emptying.
const componentModules = async (directory: string): Promise<string[]> =>
  (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
    .map((entry) => entry.name.replace(TS_SUFFIX, ''))
    .sort();
const IGNORED_DIRECTORIES = new Set([
  '.direnv',
  '.git',
  '.output-build',
  '.output-dev',
  '.svelte-kit',
  '.turbo',
  '.worktrees',
  'dist',
  'node_modules',
  'styled-system',
]);
const CONSUMED_EXTENSIONS = new Set(['.svelte', '.ts']);
/** Barrels re-export by name, so they prove nothing about consumption. */
const BARREL_FILES = new Set(['index.ts', 'report.ts', 'solid.ts', 'svelte.ts']);

export interface DesignExport {
  module: string;
  name: string;
}

const identifiersIn = (source: string): Set<string> => new Set(source.match(/[A-Za-z_$][\w$]*/g) ?? []);

const collectSources = async (directory: string, skip: (file: string) => boolean): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const sources: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        sources.push(...(await collectSources(entryPath, skip)));
      }
      continue;
    }
    if (!(entry.isFile() && CONSUMED_EXTENSIONS.has(path.extname(entry.name))) || skip(entryPath)) {
      continue;
    }
    sources.push(await readFile(entryPath, 'utf8'));
  }
  return sources;
};

export const unconsumedDesignExports = async (root: string): Promise<DesignExport[]> => {
  const componentDirectory = path.join(root, 'packages/design-system/src/components');
  const declared: DesignExport[] = [];
  const ownModuleSource = new Map<string, string>();
  for (const module of await componentModules(componentDirectory)) {
    const source = await readFile(path.join(componentDirectory, `${module}.ts`), 'utf8');
    ownModuleSource.set(module, source);
    for (const [, name] of source.matchAll(EXPORTED_CONSTANT)) {
      declared.push({ module, name: name as string });
    }
  }

  const isOwnOrBarrel = (file: string): boolean => {
    const base = path.basename(file);
    if (base.endsWith('.test.ts') || base.endsWith('.spec.ts')) {
      return true;
    }
    return (
      path.dirname(file) === componentDirectory ||
      (BARREL_FILES.has(base) && file.includes(path.join('design-system', 'src')))
    );
  };

  const consumers = [
    ...(await collectSources(path.join(root, 'apps/web/src'), isOwnOrBarrel)),
    ...(await collectSources(path.join(root, 'packages/design-system/src'), isOwnOrBarrel)),
  ];
  const consumed = new Set<string>();
  for (const source of consumers) {
    for (const identifier of identifiersIn(source)) {
      consumed.add(identifier);
    }
  }

  return declared
    .filter(({ module, name }) => {
      if (consumed.has(name)) {
        return false;
      }
      // An export used only inside its own module is internal, not dead; that is
      // a separate finding from having no consumer at all.
      const own = ownModuleSource.get(module) ?? '';
      return (own.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length <= 1;
    })
    .sort((left, right) => left.module.localeCompare(right.module) || left.name.localeCompare(right.name));
};

if (import.meta.main) {
  const current = await unconsumedDesignExports(process.cwd());
  if (current.length > 0) {
    console.error('These design-system exports have no consumer. Consume them, make them internal, or delete them.');
    for (const entry of current) {
      console.error(`${entry.module}::${entry.name}`);
    }
    process.exitCode = 1;
  } else {
    console.log('Unconsumed design exports: 0.');
  }
}
