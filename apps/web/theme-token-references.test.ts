import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * apps/web/panda.config.ts sets `optimize.removeUnusedTokens`: the served stylesheet declares a theme
 * token's variable only when an extracted style reaches it. That holds only while no runtime code
 * reads a token variable by name (`var(--colors-…)` in an inline style, `style:--colors-…`,
 * `setProperty`) or through the generated `token()` helper of `styled-system/tokens`: Panda never
 * sees such a reference, so the variable it needs can be pruned and the style silently resolves to
 * nothing. This scan holds the runtime sources of the app and of the design system to that rule.
 *
 * It reads the design system's generated `styled-system` (its preset manifest and stylesheet), which
 * `bun run test` builds first; it needs no app build.
 */
const APP_DIRECTORY = import.meta.dir;
const DESIGN_SYSTEM_SOURCE_ROOT = path.dirname(Bun.resolveSync('@ai-usage/design-system/preset', APP_DIRECTORY));
const DESIGN_SYSTEM_DIRECTORY = path.dirname(DESIGN_SYSTEM_SOURCE_ROOT);
const SOURCE_ROOTS = [path.join(APP_DIRECTORY, 'src'), DESIGN_SYSTEM_SOURCE_ROOT] as const;
const SOURCE_FILE_PATTERN = /\.(?:css|html|svelte|ts)$/;
const TEST_FILE_PATTERN = /\.test\.ts$/;

/**
 * Custom properties the app and the design system declare and set themselves; none is a theme token.
 * A new one is listed here, so a reference to a variable nobody declares cannot pass as local.
 */
const APP_LOCAL_CUSTOM_PROPERTIES: ReadonlySet<string> = new Set([
  // Shell and table geometry.
  '--ai-usage-shell-header-height',
  '--ai-usage-table-max-height',
  '--ai-usage-table-min-height',
  '--session-members-height',
  '--session-surface-height',
  // Per-element chart and figure values.
  '--hero-chars',
  '--mark-strength',
  '--punch-size',
  '--slider-range-end',
  '--slider-range-start',
  // Set by Ark UI's positioner on the popover it places.
  '--available-width',
  '--reference-width',
  // Work thread aliases, each set from a theme token by the extracted `threadSurface` style
  // (work-thread-styles.ts), so the route-only stylesheet can use the pruned semantic palette.
  '--wt-accent',
  '--wt-claude',
  '--wt-claude-bg',
  '--wt-codex',
  '--wt-codex-bg',
  '--wt-contrast',
  '--wt-danger',
  '--wt-danger-soft',
  '--wt-ink',
  '--wt-line',
  '--wt-line-strong',
  '--wt-muted',
  '--wt-ok',
  '--wt-ok-soft',
  '--wt-paper',
  '--wt-soft',
  '--wt-tint',
  '--wt-warn',
  '--wt-warn-soft',
  // Work timeline geometry: the day count and week offset the list sets on the board, and the
  // column widths and row background the stylesheet derives from them.
  '--wt-day-w',
  '--wt-days',
  '--wt-lane-pad',
  '--wt-next-w',
  '--wt-row-bg',
  '--wt-task-w',
  '--wt-week-offset',
]);

const UPPERCASE_PATTERN = /[A-Z]/g;
const REGEXP_SPECIAL_CHARACTER_PATTERN = /[.*+?^${}()|[\]\\]/g;
const LINE_BREAK_PATTERN = /\n/g;
// A custom property in a CSS position: `var(--x`, `style:--x`, a quoted style-object key `'--x':`,
// a CSSOM accessor, or a declaration `--x:` in CSS text.
const CSS_CUSTOM_PROPERTY_PATTERNS = [
  /var\(\s*(--[\w-]+)/g,
  /style:(--[\w-]+)/g,
  /['"`](--[\w-]+)['"`]\s*:/g,
  /(?:getPropertyValue|removeProperty|setProperty)\(\s*['"`](--[\w-]+)/g,
  /(?<![\w-])(--[a-zA-Z][\w-]*)\s*:(?!:)/g,
] as const;
// The generated token helper, imported by package path or by a relative path into a styled-system.
const TOKEN_HELPER_IMPORT_PATTERN =
  /['"`]((?:[^'"`\s]*\/)?styled-system\/tokens(?:\/[^'"`\s]*)?|@ai-usage\/design-system\/tokens(?:\/[^'"`\s]*)?)['"`]/g;
const TOKEN_LAYER_PATTERN = /@layer tokens\s*\{/g;
const CUSTOM_PROPERTY_DECLARATION_PATTERN = /(--[\w-]+)\s*:/g;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const dashCase = (name: string): string => name.replace(UPPERCASE_PATTERN, (letter) => `-${letter.toLowerCase()}`);

const keysOf = (value: unknown): string[] => (isRecord(value) ? Object.keys(value) : []);

/**
 * The token categories of every preset the design system publishes to the app (`panda lib`'s
 * preset manifest, the list apps/web's Panda loads through `designSystem`), as the variable prefix
 * Panda gives them: `fontSizes` → `--font-sizes-`. Breakpoints become `--breakpoints-` variables too.
 */
const themeTokenPrefixes = async (): Promise<string[]> => {
  const manifest: unknown = (await import(Bun.resolveSync('@ai-usage/design-system/panda/preset.mjs', APP_DIRECTORY)))
    .default;
  if (!(isRecord(manifest) && Array.isArray(manifest.presets))) {
    throw new Error('Expected the design system preset manifest to list its presets');
  }
  const categories = new Set<string>();
  for (const entry of manifest.presets) {
    const preset: unknown =
      typeof entry === 'string' ? (await import(Bun.resolveSync(entry, DESIGN_SYSTEM_DIRECTORY))).default : entry;
    const theme = isRecord(preset) ? preset.theme : undefined;
    const extended = isRecord(theme) ? theme.extend : undefined;
    for (const layer of [theme, extended]) {
      if (!isRecord(layer)) {
        continue;
      }
      for (const category of [...keysOf(layer.tokens), ...keysOf(layer.semanticTokens)]) {
        categories.add(category);
      }
      if (isRecord(layer.breakpoints)) {
        categories.add('breakpoints');
      }
    }
  }
  if (categories.size === 0) {
    throw new Error('Expected the design system presets to define token categories');
  }
  return [...categories].map((category) => `--${dashCase(category)}-`).sort();
};

/** The variables Panda declares in the design system stylesheet's `@layer tokens`: every theme token. */
const declaredThemeVariables = async (): Promise<string[]> => {
  const css = await readFile(Bun.resolveSync('@ai-usage/design-system/styles.css', APP_DIRECTORY), 'utf8');
  const names = new Set<string>();
  for (const match of css.matchAll(TOKEN_LAYER_PATTERN)) {
    let depth = 1;
    let end = match.index + match[0].length;
    while (depth > 0 && end < css.length) {
      depth += css[end] === '{' ? 1 : 0;
      depth -= css[end] === '}' ? 1 : 0;
      end += 1;
    }
    for (const declaration of css.slice(match.index, end).matchAll(CUSTOM_PROPERTY_DECLARATION_PATTERN)) {
      names.add(declaration[1] ?? '');
    }
  }
  return [...names].sort();
};

const escapeRegExp = (text: string): string => text.replace(REGEXP_SPECIAL_CHARACTER_PATTERN, '\\$&');

const lineOf = (source: string, index: number): number =>
  (source.slice(0, index).match(LINE_BREAK_PATTERN)?.length ?? 0) + 1;

interface TokenReferenceFindings {
  /** Every app-local custom property the source uses. */
  readonly local: string[];
  /** Custom properties in a CSS position that are neither theme tokens nor declared app-local. */
  readonly undeclared: string[];
  /** Theme token variables named in source, and imports of the generated token helper. */
  readonly violations: string[];
}

/** What one runtime source reads by variable name, as `path:line: name` findings. */
const tokenReferenceFindings = (
  relativePath: string,
  source: string,
  tokenPrefixes: readonly string[],
): TokenReferenceFindings => {
  const at = (index: number, name: string): string => `${relativePath}:${lineOf(source, index)}: ${name}`;
  const tokenVariablePattern = new RegExp(`(?<![\\w-])(?:${tokenPrefixes.map(escapeRegExp).join('|')})[\\w-]*`, 'g');
  const violations = [
    ...[...source.matchAll(tokenVariablePattern)].map((match) => at(match.index, match[0])),
    ...[...source.matchAll(TOKEN_HELPER_IMPORT_PATTERN)].map((match) => at(match.index, `import ${match[1]}`)),
  ];
  const undeclared: string[] = [];
  const local: string[] = [];
  for (const pattern of CSS_CUSTOM_PROPERTY_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1] ?? '';
      if (APP_LOCAL_CUSTOM_PROPERTIES.has(name)) {
        local.push(name);
      } else if (!tokenPrefixes.some((prefix) => name.startsWith(prefix))) {
        undeclared.push(at(match.index, name));
      }
    }
  }
  return { local, undeclared: [...new Set(undeclared)], violations };
};

const sourceFilesUnder = async (directory: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFilesUnder(entryPath)));
    } else if (entry.isFile() && SOURCE_FILE_PATTERN.test(entry.name) && !TEST_FILE_PATTERN.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
};

const prefixes = await themeTokenPrefixes();

describe('theme token variables stay inside the extracted styles', () => {
  test('derives a prefix for every variable the design system theme declares', async () => {
    const themeVariables = await declaredThemeVariables();

    expect(prefixes).toContain('--colors-');
    expect(prefixes).toContain('--font-sizes-');
    expect(prefixes).toContain('--spacing-');
    expect(prefixes).toContain('--breakpoints-');
    expect(themeVariables.length).toBeGreaterThan(100);
    expect(themeVariables.filter((name) => !prefixes.some((prefix) => name.startsWith(prefix)))).toEqual([]);
  });

  test('no runtime source names a theme token variable or imports the generated token helper', async () => {
    const violations: string[] = [];
    const undeclared: string[] = [];
    const local = new Set<string>();
    let scanned = 0;
    for (const root of SOURCE_ROOTS) {
      for (const file of await sourceFilesUnder(root)) {
        scanned += 1;
        const findings = tokenReferenceFindings(
          path.relative(path.resolve(APP_DIRECTORY, '../..'), file),
          await readFile(file, 'utf8'),
          prefixes,
        );
        violations.push(...findings.violations);
        undeclared.push(...findings.undeclared);
        for (const name of findings.local) {
          local.add(name);
        }
      }
    }

    expect(scanned).toBeGreaterThan(300);
    expect(violations).toEqual([]);
    expect(undeclared).toEqual([]);
    // A stale entry would let a later reference to that name pass unexamined.
    expect([...APP_LOCAL_CUSTOM_PROPERTIES].filter((name) => !local.has(name))).toEqual([]);
  });

  test('flags a planted token reference, token helper import or undeclared variable', () => {
    const source = [
      "const ring = css({ outline: '1px solid var(--colors-accent)' });",
      '<span style:--colors-accent={value}></span>',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: sample source naming a token variable it builds.
      'element.style.setProperty(`--spacing-${step}`, size);',
      "const fill = 'color-mix(in srgb, var(--colors-chart-c1) 40%, transparent)';",
      "import { token } from '@ai-usage/design-system/tokens';",
      "import { token as raw } from '../../styled-system/tokens/index.mjs';",
      "const width = css({ w: 'var(--made-up-width)' });",
      "const height = css({ h: 'var(--session-surface-height, 100dvh)' });",
      "Bun.spawn(['gh', 'pr', 'list', '--repo', repository, '--json']);",
    ].join('\n');

    const findings = tokenReferenceFindings('apps/web/src/planted.svelte', source, prefixes);

    expect(findings.violations).toEqual([
      'apps/web/src/planted.svelte:1: --colors-accent',
      'apps/web/src/planted.svelte:2: --colors-accent',
      'apps/web/src/planted.svelte:3: --spacing-',
      'apps/web/src/planted.svelte:4: --colors-chart-c1',
      'apps/web/src/planted.svelte:5: import @ai-usage/design-system/tokens',
      'apps/web/src/planted.svelte:6: import ../../styled-system/tokens/index.mjs',
    ]);
    expect(findings.undeclared).toEqual(['apps/web/src/planted.svelte:7: --made-up-width']);
    expect(findings.local).toEqual(['--session-surface-height']);
  });
});
