import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removePanda1Output, type StyledSystemLayout } from './remove-panda-1-output';

const packageDirectory = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PANDA_TIMEOUT_MS = 30_000;

// What Panda 1.12 wrote and Panda 2 never writes, per layout. `panda lib` derives package.json exports
// from `helpers.mjs`, `<category>/index.mjs` and a `jsx/` directory before their Panda 2 counterparts.
const PANDA_1_LIBRARY_FILES = [
  'css/css.mjs',
  'css/index.mjs',
  'helpers.mjs',
  'jsx/factory.mjs',
  'jsx/index.d.ts',
  'jsx/index.mjs',
  'panda.buildinfo.json',
  'patterns/box.mjs',
  'patterns/index.mjs',
  'tokens/index.mjs',
  'tokens/tokens.d.ts',
  'types/csstype.d.ts',
  'types/jsx.d.ts',
  'types/system-types.d.ts',
];
// A `designSystem` consumer's Panda 2 output only re-exports the library from `index` modules.
const PANDA_1_CONSUMER_ONLY_FILES = ['css/css.d.ts', 'css/cva.d.ts', 'patterns/box.d.ts', 'patterns/grid-item.d.ts'];
// Written by `panda cssgen` and `panda lib`, not by `panda codegen`.
const PANDA_2_NON_CODEGEN_FILES = ['panda/buildinfo.json', 'panda/lib.json', 'panda/preset.mjs', 'styles.css'];

const filesIn = async (directory: string): Promise<string[]> =>
  (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();

const writeFiles = async (directory: string, files: readonly string[]): Promise<void> => {
  for (const file of files) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await Bun.write(path.join(directory, file), `// ${file}\n`);
  }
};

const runPanda = (args: readonly string[]): void => {
  const result = Bun.spawnSync([process.execPath, '--bun', 'panda', ...args, '--log-level', 'warn'], {
    cwd: packageDirectory,
    env: { ...process.env, CI: '1' },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0 || stderr !== '') {
    throw new Error(`panda ${args.join(' ')} exited with ${result.exitCode}: ${stderr}`);
  }
};

// Generates the tree Panda 2 writes for the layout into a scratch directory; the package's own
// styled-system directory is never touched.
const generatePanda2Output = async (scratch: string, layout: StyledSystemLayout): Promise<string> => {
  const outdir = path.join(scratch, 'styled-system');
  if (layout === 'library') {
    runPanda(['codegen', '--outdir', outdir]);
  } else {
    const emptySource = path.join(scratch, 'empty.ts');
    const configFile = path.join(scratch, 'panda.config.mjs');
    await Bun.write(emptySource, 'export {};\n');
    const config = { designSystem: '@ai-usage/design-system', include: [emptySource], outdir };
    await Bun.write(configFile, `export default ${JSON.stringify(config)};\n`);
    runPanda(['codegen', '--config', configFile]);
  }
  await writeFiles(outdir, PANDA_2_NON_CODEGEN_FILES);
  return outdir;
};

const withScratch = async (run: (scratch: string) => Promise<void>): Promise<void> => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'design-system-panda-1-output-'));
  try {
    await run(scratch);
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
};

describe('removePanda1Output', () => {
  // Builds run concurrently against one styled-system directory (turbo runs the design-system build
  // and check side by side), so the removal must never delete a file a Panda 2 build writes.
  test.each([
    ['library', PANDA_1_LIBRARY_FILES],
    ['consumer', [...PANDA_1_LIBRARY_FILES, ...PANDA_1_CONSUMER_ONLY_FILES]],
  ] as const)(
    'removes the Panda 1 output from a stale %s tree and keeps every file Panda 2 writes',
    async (layout, panda1Files) => {
      await withScratch(async (scratch) => {
        const outdir = await generatePanda2Output(scratch, layout);
        const panda2Files = await filesIn(outdir);
        expect(panda2Files).toContain('css/index.d.ts');
        expect(await removePanda1Output(outdir, layout)).toEqual([]);

        await writeFiles(outdir, panda1Files);
        const removed = await removePanda1Output(outdir, layout);

        expect(removed).toEqual(
          [...new Set(panda1Files.map((file) => (file.startsWith('jsx/') ? 'jsx' : file)))].sort(),
        );
        expect(await filesIn(outdir)).toEqual(panda2Files);
      });
    },
    PANDA_TIMEOUT_MS,
  );

  test('keeps the library declarations that only a consumer lacks', async () => {
    await withScratch(async (scratch) => {
      const outdir = path.join(scratch, 'styled-system');
      await writeFiles(outdir, PANDA_1_CONSUMER_ONLY_FILES);

      expect(await removePanda1Output(outdir, 'library')).toEqual([]);
      expect(await filesIn(outdir)).toEqual([...PANDA_1_CONSUMER_ONLY_FILES].sort());
    });
  });

  test('treats a missing output directory as holding nothing', async () => {
    await withScratch(async (scratch) => {
      expect(await removePanda1Output(path.join(scratch, 'styled-system'), 'library')).toEqual([]);
    });
  });
});
