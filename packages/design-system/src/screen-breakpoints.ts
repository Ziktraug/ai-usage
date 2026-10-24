import { rename } from 'node:fs/promises';
import path from 'node:path';

/**
 * Scopes Panda's breakpoint media queries to `screen`, the way Panda 1 emitted them.
 *
 * Panda 1 wrote `md:` as `@media screen and (min-width: 48rem)`; Panda 2 writes `@media (width >= 48rem)`,
 * which also matches a printed page box (about 720px wide in portrait, 960px or more in landscape). A
 * printed report would then take its `sm:`, `md:` and `lg:` layouts instead of the base one. Panda 2.3
 * has no setting for the media type: `theme.breakpoints` only takes a length, and a `conditions` entry
 * named after a breakpoint is ignored. So the generated stylesheet is rewritten after `panda cssgen`.
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

if (import.meta.main) {
  const [stylesheet, ...extra] = process.argv.slice(2);
  if (stylesheet === undefined || extra.length > 0) {
    throw new Error('Usage: screen-breakpoints.ts <stylesheet>');
  }
  const file = path.resolve(stylesheet);
  const scoped = scopeBreakpointsToScreen(await Bun.file(file).text());
  // Replace the file in one step: the dev server and concurrent builds read it.
  const temporary = `${file}.${process.pid}.tmp`;
  await Bun.write(temporary, scoped);
  await rename(temporary, file);
}
