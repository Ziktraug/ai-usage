import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopeBreakpointsToScreen } from './screen-breakpoints';

const packageDirectory = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const cliScript = fileURLToPath(new URL('screen-breakpoints.ts', import.meta.url));
const MEDIA_PRELUDE = /@media\s+([^{]+?)\s*\{/g;
const PANDA_TIMEOUT_MS = 30_000;
const RAW_CSS = '@media (width >= 48rem) { .md\\:d_block { display: block; } }\n';
// Older than any write the CLI makes, so a rewrite always shows in the mtime.
const PAST = new Date('2020-01-01T00:00:00Z');

const mediaPreludes = (css: string): string[] => [...css.matchAll(MEDIA_PRELUDE)].map(([, prelude]) => prelude ?? '');

const runCli = (args: readonly string[]): { exitCode: number; stderr: string } => {
  const result = Bun.spawnSync([process.execPath, cliScript, ...args], { stderr: 'pipe', stdout: 'pipe' });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
};

const fileIdentity = async (file: string): Promise<{ inode: number; mtimeMs: number }> => {
  const { ino, mtimeMs } = await stat(file);
  return { inode: ino, mtimeMs };
};

const withScratch = async (run: (scratch: string) => Promise<void>): Promise<void> => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'design-system-screen-breakpoints-cli-'));
  try {
    await run(scratch);
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
};

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

describe('screen-breakpoints CLI', () => {
  test('replaces a changed stylesheet with the scoped raw stylesheet and removes the raw one', async () => {
    await withScratch(async (scratch) => {
      const raw = path.join(scratch, 'raw.css');
      const stylesheet = path.join(scratch, 'styled-system', 'styles.css');
      await Bun.write(raw, RAW_CSS);
      await Bun.write(stylesheet, '@media screen and (width >= 40rem) { .sm\\:d_none { display: none; } }\n');

      expect(runCli([raw, stylesheet])).toEqual({ exitCode: 0, stderr: '' });

      expect(await Bun.file(stylesheet).text()).toBe(scopeBreakpointsToScreen(RAW_CSS));
      expect(await Bun.file(raw).exists()).toBe(false);
      expect(await readdir(path.dirname(stylesheet))).toEqual(['styles.css']);
    });
  });

  // A running dev server imports the stylesheet, so a build that changes nothing must not touch it.
  test('leaves an unchanged stylesheet untouched', async () => {
    await withScratch(async (scratch) => {
      const raw = path.join(scratch, 'raw.css');
      const stylesheet = path.join(scratch, 'styles.css');
      await Bun.write(raw, RAW_CSS);
      await Bun.write(stylesheet, scopeBreakpointsToScreen(RAW_CSS));
      await utimes(stylesheet, PAST, PAST);
      const before = await fileIdentity(stylesheet);

      expect(runCli([raw, stylesheet])).toEqual({ exitCode: 0, stderr: '' });

      expect(before.mtimeMs).toBe(PAST.getTime());
      expect(await fileIdentity(stylesheet)).toEqual(before);
      expect(await Bun.file(raw).exists()).toBe(false);
    });
  });

  test('creates a missing stylesheet', async () => {
    await withScratch(async (scratch) => {
      const raw = path.join(scratch, 'raw.css');
      const stylesheet = path.join(scratch, 'styles.css');
      await Bun.write(raw, RAW_CSS);

      expect(runCli([raw, stylesheet])).toEqual({ exitCode: 0, stderr: '' });

      expect(await Bun.file(stylesheet).text()).toBe(scopeBreakpointsToScreen(RAW_CSS));
      expect(await Bun.file(raw).exists()).toBe(false);
    });
  });

  test('fails on a raw stylesheet without breakpoint queries, keeps the stylesheet and removes the raw one', async () => {
    await withScratch(async (scratch) => {
      const raw = path.join(scratch, 'raw.css');
      const stylesheet = path.join(scratch, 'styles.css');
      const current = scopeBreakpointsToScreen(RAW_CSS);
      await Bun.write(raw, '@media (min-width: 48rem) { .a { color: red; } }\n');
      await Bun.write(stylesheet, current);
      await utimes(stylesheet, PAST, PAST);
      const before = await fileIdentity(stylesheet);

      const result = runCli([raw, stylesheet]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('no Panda breakpoint media query');
      expect(await Bun.file(stylesheet).text()).toBe(current);
      expect(await fileIdentity(stylesheet)).toEqual(before);
      expect(await readdir(scratch)).toEqual(['styles.css']);
    });
  });

  // The raw stylesheet is removed after the run, so it must never be the stylesheet itself.
  test('refuses a raw stylesheet that resolves to the stylesheet and leaves it untouched', async () => {
    await withScratch(async (scratch) => {
      const stylesheet = path.join(scratch, 'styles.css');
      await Bun.write(stylesheet, RAW_CSS);
      await utimes(stylesheet, PAST, PAST);
      const before = await fileIdentity(stylesheet);

      for (const raw of [stylesheet, `${scratch}${path.sep}.${path.sep}styles.css`]) {
        const result = runCli([raw, stylesheet]);

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('The raw stylesheet and the stylesheet resolve to the same path');
        expect(await Bun.file(stylesheet).text()).toBe(RAW_CSS);
        expect(await fileIdentity(stylesheet)).toEqual(before);
        expect(await readdir(scratch)).toEqual(['styles.css']);
      }
    });
  });

  test('prints its usage for a wrong number of arguments', () => {
    for (const args of [[], ['raw.css'], ['raw.css', 'styles.css', 'extra.css']]) {
      const result = runCli(args);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Usage: screen-breakpoints.ts <raw stylesheet> <stylesheet>');
    }
  });
});
