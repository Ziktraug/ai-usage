import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopeBreakpointsToScreen } from './screen-breakpoints';

const packageDirectory = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const MEDIA_PRELUDE = /@media\s+([^{]+?)\s*\{/g;
const PANDA_TIMEOUT_MS = 30_000;

const mediaPreludes = (css: string): string[] => [...css.matchAll(MEDIA_PRELUDE)].map(([, prelude]) => prelude ?? '');

describe('scopeBreakpointsToScreen', () => {
  test('scopes up, down and range breakpoints to screen and leaves every other media query alone', () => {
    const css = [
      '@layer utilities {',
      '  @media (width >= 48rem) { .md\\:d_block { display: block; } }',
      '  @media (width < 48rem) { .mdDown\\:c_red { color: red; } }',
      '  @media (width >= 48rem) and (width < 64rem) { .mdToLg\\:c_red { color: red; } }',
      '  @media (width>=40rem){.sm\\:d_none{display:none}}',
      '  @media print { .print\\:d_none { display: none; } }',
      '  @media (prefers-color-scheme: dark) { .osDark\\:c_red { color: red; } }',
      '  @media screen and (max-width: 359px) { .time-slider { min-width: 0; } }',
      '  @container (width >= 20rem) { .cq\\:d_flex { display: flex; } }',
      '}',
    ].join('\n');

    expect(mediaPreludes(scopeBreakpointsToScreen(css))).toEqual([
      'screen and (width >= 48rem)',
      'screen and (width < 48rem)',
      'screen and (width >= 48rem) and (width < 64rem)',
      'screen and (width>=40rem)',
      'print',
      '(prefers-color-scheme: dark)',
      'screen and (max-width: 359px)',
    ]);
    expect(scopeBreakpointsToScreen(css)).toContain('@container (width >= 20rem)');
  });

  test('leaves an already scoped stylesheet unchanged', () => {
    const scoped = scopeBreakpointsToScreen('@media (width >= 48rem) { .a { color: red; } }');

    expect(scopeBreakpointsToScreen(scoped)).toBe(scoped);
  });

  test('fails visibly when the stylesheet holds no breakpoint query', () => {
    expect(() => scopeBreakpointsToScreen('@media (min-width: 48rem) { .a { color: red; } }')).toThrow(
      'no Panda breakpoint media query',
    );
  });

  // Pins the rewrite to the media queries Panda 2 actually emits for breakpoints: if Panda changes
  // their shape, this fails here instead of letting breakpoint styles reach the printed page again.
  test(
    'scopes every breakpoint query Panda generates for a design-system consumer',
    async () => {
      const scratch = await mkdtemp(path.join(tmpdir(), 'design-system-screen-breakpoints-'));
      try {
        const source = path.join(scratch, 'source.ts');
        const configFile = path.join(scratch, 'panda.config.mjs');
        const stylesheet = path.join(scratch, 'styles.css');
        await Bun.write(
          source,
          [
            "import { css } from '@ai-usage/design-system/css';",
            "css({ display: { base: 'none', md: 'block' }, mdDown: { color: 'red' }, smToLg: { color: 'blue' } });",
            '',
          ].join('\n'),
        );
        const config = {
          designSystem: '@ai-usage/design-system',
          include: [source],
          outdir: path.join(scratch, 'out'),
        };
        await Bun.write(configFile, `export default ${JSON.stringify(config)};\n`);
        const result = Bun.spawnSync(
          [
            process.execPath,
            '--bun',
            'panda',
            'cssgen',
            '--config',
            configFile,
            '--outfile',
            stylesheet,
            '--log-level',
            'warn',
          ],
          { cwd: packageDirectory, env: { ...process.env, CI: '1' }, stderr: 'pipe', stdout: 'pipe' },
        );
        expect(result.stderr.toString()).toBe('');
        expect(result.exitCode).toBe(0);

        const widthPreludes = mediaPreludes(scopeBreakpointsToScreen(await Bun.file(stylesheet).text())).filter(
          (prelude) => prelude.includes('width'),
        );
        expect(widthPreludes).toEqual(
          expect.arrayContaining([
            'screen and (width >= 48rem)',
            'screen and (width < 48rem)',
            'screen and (width >= 40rem) and (width < 64rem)',
          ]),
        );
        expect(widthPreludes.filter((prelude) => !prelude.startsWith('screen and '))).toEqual([]);
      } finally {
        await rm(scratch, { force: true, recursive: true });
      }
    },
    PANDA_TIMEOUT_MS,
  );
});
