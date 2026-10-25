import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Removes what Panda 1 wrote to a `styled-system` directory and Panda 2 never writes.
 *
 * A checkout built before the Panda 2 upgrade keeps that output, and it is not inert: `panda lib`
 * derives the design-system package.json exports from the files it finds (`helpers.mjs` and
 * `<category>/index.mjs` win over the Panda 2 `.js` modules, a `jsx/` directory adds `./jsx`), and
 * the design-system type check includes the whole directory.
 *
 * `panda codegen --clean` would delete the whole directory instead, and builds share it: turbo runs
 * the design-system build and check side by side, and every web script builds the design system
 * again. Removing only paths Panda 2 never writes keeps a concurrent build's output intact.
 */

/**
 * `library` is the design system's own output (full codegen plus `panda lib`); `consumer` is an
 * app whose Panda config loads the design system through `designSystem`, so its Panda 2 codegen
 * re-exports the library from `index` modules only.
 */
export type StyledSystemLayout = 'consumer' | 'library';

const STYLED_SYSTEM_LAYOUTS: ReadonlySet<string> = new Set<StyledSystemLayout>(['consumer', 'library']);

// Panda 1 wrote its JSX factory here; neither Panda config sets `jsxFramework`.
const PANDA_1_JSX_DIRECTORY = 'jsx';
// Written by `panda lib` only. Panda 1 never wrote under it, and it holds Panda 2's one `.mjs`
// file (`preset.mjs`), so it is not scanned.
const PANDA_2_LIB_DIRECTORY = 'panda';
const PANDA_1_FILES: ReadonlySet<string> = new Set([
  // `panda ship` build info; Panda 2 writes `panda/buildinfo.json`.
  'panda.buildinfo.json',
  // Panda 2 declares tokens in `types/tokens.d.ts` and folds these modules into `types/system.d.ts`;
  // `types/jsx.d.ts` typed the Panda 1 JSX factory.
  'tokens/tokens.d.ts',
  ...[
    'composition',
    'conditions',
    'csstype',
    'global',
    'jsx',
    'parts',
    'prop-type',
    'selectors',
    'static-css',
    'style-props',
    'system-types',
  ].map((module) => `types/${module}.d.ts`),
]);
// A consumer's Panda 2 `css/` and `patterns/` hold only `index` re-exports of the library.
const CONSUMER_PANDA_1_DECLARATION = /^(?:css|patterns)\/(?!index\.d\.ts$)[^/]+\.d\.ts$/;

// Panda 1 wrote every runtime module as `.mjs`; Panda 2 writes `.js`.
const isPanda1File = (file: string, layout: StyledSystemLayout): boolean =>
  file.endsWith('.mjs') ||
  PANDA_1_FILES.has(file) ||
  (layout === 'consumer' && CONSUMER_PANDA_1_DECLARATION.test(file));

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const panda1EntriesIn = async (outdir: string, layout: StyledSystemLayout, relative = ''): Promise<string[]> => {
  const entries = await readdir(path.join(outdir, relative), { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const entryPath = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entryPath === PANDA_1_JSX_DIRECTORY) {
        found.push(entryPath);
      } else if (entryPath !== PANDA_2_LIB_DIRECTORY) {
        found.push(...(await panda1EntriesIn(outdir, layout, entryPath)));
      }
    } else if (isPanda1File(entryPath, layout)) {
      found.push(entryPath);
    }
  }
  return found;
};

/** Removes the Panda 1 output from `outdir` and returns the removed paths, relative to it and sorted. */
export const removePanda1Output = async (outdir: string, layout: StyledSystemLayout): Promise<string[]> => {
  try {
    await stat(outdir);
  } catch (error) {
    // A checkout that has never run Panda has nothing to remove.
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
  const entries = await panda1EntriesIn(outdir, layout);
  for (const entry of entries) {
    await rm(path.join(outdir, entry), { force: true, recursive: true });
  }
  return entries.sort();
};

const isStyledSystemLayout = (value: string | undefined): value is StyledSystemLayout =>
  value !== undefined && STYLED_SYSTEM_LAYOUTS.has(value);

if (import.meta.main) {
  const [layout, outdir, ...extra] = process.argv.slice(2);
  if (!isStyledSystemLayout(layout) || outdir === undefined || extra.length > 0) {
    throw new Error('Usage: remove-panda-1-output.ts <library|consumer> <styled-system directory>');
  }
  const removed = await removePanda1Output(path.resolve(outdir), layout);
  if (removed.length > 0) {
    console.log(`Removed ${removed.length} Panda 1 output entries from ${outdir}.`);
  }
}
