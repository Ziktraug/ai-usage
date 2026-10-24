import { readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Scopes Panda's breakpoint media queries to `screen`, the way Panda 1 emitted them.
 *
 * Panda 1 wrote `md:` as `@media screen and (min-width: 48rem)`; Panda 2 writes `@media (width >= 48rem)`,
 * which also matches a printed page box (about 720px wide in portrait, 960px or more in landscape). A
 * printed report would then take its `sm:`, `md:` and `lg:` layouts instead of the base one. Panda 2.3
 * has no setting for the media type: `theme.breakpoints` only takes a length, and a `conditions` entry
 * named after a breakpoint is ignored. So `panda cssgen` writes a raw stylesheet outside the app, and
 * the CLI below writes its scoped content to the app's stylesheet only when that content changed: a
 * running dev server imports the stylesheet and re-transforms it on every write, which a build that
 * changes nothing must not cause.
 *
 * A media query made only of `width` ranges is what Panda generates for a breakpoint condition (`md`,
 * `mdDown`, `mdToLg`, `mdOnly`); authored queries in this codebase already name their media type.
 */
const WIDTH_RANGE = String.raw`\(width\s*[<>]=?\s*[\d.]+(?:px|r?em)\)`;
const BREAKPOINT_MEDIA_QUERY = new RegExp(
  String.raw`@media\s+(${WIDTH_RANGE}(?:\s+and\s+${WIDTH_RANGE})*)(?=\s*\{)`,
  'g',
);
const SCREEN_BREAKPOINT_MEDIA_QUERY = new RegExp(String.raw`@media\s+screen\s+and\s+${WIDTH_RANGE}`);

/**
 * Returns `css` with every breakpoint media query scoped to `screen`. Already scoped queries stay as
 * they are, so the rewrite is idempotent; a stylesheet without any breakpoint query fails, because the
 * app's stylesheet always has some and their absence means Panda changed how it writes them.
 */
export const scopeBreakpointsToScreen = (css: string): string => {
  const scoped = css.replace(BREAKPOINT_MEDIA_QUERY, '@media screen and $1');
  if (!SCREEN_BREAKPOINT_MEDIA_QUERY.test(scoped)) {
    throw new Error(
      'Found no Panda breakpoint media query (`@media (width >= …)`) to scope to screen; Panda changed how it writes breakpoints.',
    );
  }
  return scoped;
};

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

// `undefined` before the first build writes the stylesheet.
const readIfPresent = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
};

if (import.meta.main) {
  const [rawStylesheet, stylesheet, ...extra] = process.argv.slice(2);
  if (rawStylesheet === undefined || stylesheet === undefined || extra.length > 0) {
    throw new Error('Usage: screen-breakpoints.ts <raw stylesheet> <stylesheet>');
  }
  const raw = path.resolve(rawStylesheet);
  const file = path.resolve(stylesheet);
  // The raw stylesheet is removed below, which would delete the stylesheet just written.
  if (raw === file) {
    throw new Error(
      `The raw stylesheet and the stylesheet resolve to the same path (${file}); pass a separate raw stylesheet, which this CLI removes.`,
    );
  }
  try {
    const scoped = scopeBreakpointsToScreen(await readFile(raw, 'utf8'));
    if (scoped !== (await readIfPresent(file))) {
      // Replace the file in one step: the dev server and concurrent builds read it.
      const temporary = `${file}.${process.pid}.tmp`;
      await Bun.write(temporary, scoped);
      await rename(temporary, file);
    }
  } finally {
    await rm(raw, { force: true });
  }
}
